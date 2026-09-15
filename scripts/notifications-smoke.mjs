/**
 * 通知冒烟测试 —— `npm run notifications:smoke`
 *
 * ===========================================================================
 * 这个脚本覆盖的通知代码里，凡是**能在 Node 里验证的**部分：
 * ===========================================================================
 *
 * 第五批次的本地通知有两个部分是「模拟器也验不了」的：
 * - 权限弹窗是否出现（Expo Go 上的行为要靠真机看）；
 * - 系统是否准点把通知发出来（尤其 Android 12+ 缺少精确闹钟权限时的漂移）。
 *
 * 剩下的**大部分逻辑其实是普通代码**：查两张表、算下一个触发时刻、拼文案。
 * 把它们留到真机上用「盯着手机等通知」来验收，代价太高、也不可回归。
 * 所以这里用 `node:sqlite` + 真实源码（不做副本、不 mock）把这部分钉住：
 *
 *   1. `notifications.repo.ts` —— 新增的 `listDueJobs` / `getLastDigestFiredAt` /
 *      `countFiredSince`，以及 `insertHistory` 传 null 的行为；
 *   2. `utils/date.ts` 的 `nextFirePoint` —— 「下一个 09:00 是今天还是明天」的边界；
 *   3. `domain/notification-copy.ts` —— 全部文案。
 *
 * 为什么要测 AGENTS.md 里没提的东西：这几处**都是纯函数与单条 SQL**，
 * 出错时不会崩溃、只会静默排错时间或发错文案 ——
 * 通知这类「用户会被打扰」的功能，恰恰最不能靠肉眼发现这类偏差。
 *
 * ---------------------------------------------------------------------------
 * 怎么跑
 * ---------------------------------------------------------------------------
 *     npm run notifications:smoke
 *
 * 与 `db-migrate-smoke.mjs` 共用同一套基建（`scripts/lib/node-sqlite.mjs`）：
 * Node 内置 `node:sqlite` 顶替 `expo-sqlite`，`@/` 别名由
 * `scripts/lib/ts-path-alias-loader.mjs` 解析，不引入任何 npm 依赖。
 *
 * 前置条件：Node >= 22.18。
 *
 * ---------------------------------------------------------------------------
 * 真实库而不是空壳表
 * ---------------------------------------------------------------------------
 * 测试数据落在 `migrateDbIfNeeded()` 跑出来的**真实 schema** 上
 * （含 `UNIQUE(item_id, kind, fired_at)` 这类约束），
 * 所以脚本能反映 SQLite 的真实语义 ——
 * 特别是「NULL 互不相等」这条，它是好几个设计的前提，也是最容易记错的一条。
 */
import { register } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScenarioContext } from './lib/node-sqlite.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

// 必须先注册 hook，后面的 import('@/...') 才能解析
register('./lib/ts-path-alias-loader.mjs', import.meta.url);

// ---------------------------------------------------------------------------
// 加载被测代码（真实源码，不是副本）
// ---------------------------------------------------------------------------

const loadHint =
  '\n  本脚本需要 Node >= 22.18（node:sqlite 可用 + 默认开启 TS 类型擦除），' +
  `\n  当前版本：${process.version}`;

let migrateDbIfNeeded;
let verifySchemaShape;
let repo;
let dateUtils;
let copy;
try {
  ({ migrateDbIfNeeded, verifySchemaShape } = await import('@/db/migrations'));
  repo = await import('@/db/repositories/notifications.repo');
  dateUtils = await import('@/utils/date');
  copy = await import('@/domain/notification-copy');
} catch (error) {
  console.error(`[FAIL] 无法加载被测源码。${loadHint}\n  原始错误：${error.message}`);
  process.exit(1);
}

const { formatDateTimeCN, nextFirePoint } = dateUtils;
const { MAX_LISTED_NAMES, buildDailyDigestCopy, buildOutOfStockCopy } = copy;

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

class SmokeFailure extends Error {}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new SmokeFailure(`断言失败：${label}\n    期望：${expected}\n    实际：${actual}`);
  }
  console.log(`  [ ok ] ${label} = ${actual}`);
}

function expectTrue(label, actual) {
  expectEqual(label, actual, true);
}

/** 期望抛错：非法 clock 这类防御必须有，而且必须是**抛**而不是悄悄返回个值 */
function expectThrows(label, action) {
  try {
    action();
  } catch (error) {
    console.log(`  [ ok ] ${label} → 抛错：${error.message}`);
    return;
  }
  throw new SmokeFailure(`断言失败：${label} 没有抛错`);
}

/**
 * 本地时间戳构造。月份从 **1** 开始写（与 `new Date` 不同），
 * 免得每行 DateTime 都得在脑子里做一次 -1。
 */
function at(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm'，断言只比ctime字符串，避免时区解释歧义 */
function show(ms) {
  return formatDateTimeCN(ms);
}

/** 插一条最小物品行，返回自增 id */
function insertItem(db, name) {
  db.arrange(`INSERT INTO items (name, created_at, updated_at) VALUES ('${name}', 0, 0)`);
  return db.probe(`SELECT id FROM items WHERE name = '${name}'`)[0].id;
}

function countRows(db, sql) {
  return db.probe(sql)[0].n;
}

// ---------------------------------------------------------------------------
// 分组场景
// ---------------------------------------------------------------------------

const GROUPS = [
  {
    name: 'listDueJobs',
    describe: '已到点的待发任务（fire_at <= now），含 item_id 为 NULL 的摘要',
    async run(db) {
      const now = at(2026, 9, 14, 12, 0);
      const trashBag = insertItem(db, '垃圾袋');
      const tissue = insertItem(db, '手帕纸');

      // 两条已过期（-60s / -1ms），一条未到点
      await repo.upsertJob(db, {
        itemId: trashBag,
        kind: 'buy_reminder',
        notificationId: 'nsid-due-past',
        fireAt: now - 60_000,
      });
      await repo.upsertJob(db, {
        itemId: tissue,
        kind: 'buy_reminder',
        notificationId: 'nsid-future',
        fireAt: now + 3_600_000,
      });
      // 摘要这条刻意 itemId = null：job 表的 UNIQUE(item_id, kind)
      // 依赖「NULL 互不相等」，它能不能正常进出库是整套方案的前提
      await repo.upsertJob(db, {
        itemId: null,
        kind: 'daily_digest',
        notificationId: 'nsid-digest-past',
        fireAt: now - 1,
      });

      const due = await repo.listDueJobs(db, now);
      expectEqual('到点的条数（不含未来那条）', due.length, 2);
      expectEqual('从早到晚排序：第 1 条 itemId', due[0].itemId, trashBag);
      expectEqual('第 2 条是 itemId=NULL 的摘要', due[1].itemId, null);
      expectEqual('第 2 条 kind', due[1].kind, 'daily_digest');
      expectEqual('第 2 条 fire_at 保留到毫秒', due[1].fireAt, now - 1);

      // 边界：deadline 恰好等于某条的 fire_at 时算「已到点」（<= 而不是 <）
      const atDeadline = await repo.listDueJobs(db, now - 60_000);
      expectEqual('deadline 恰好等于 fire_at 也算到期', atDeadline.length, 1);

      const futureOnly = await repo.listDueJobs(db, now + 3_600_000);
      expectEqual('deadline 推到未来那条的时间点后', futureOnly.length, 3);

      const none = await repo.listDueJobs(db, now - 60_001);
      expectEqual('deadline 早于所有 fire_at', none.length, 0);
    },
  },
  {
    name: 'getLastDigestFiredAt',
    describe: '最近一次「每日摘要」的触发时间（item_id IS NULL 的那行）',
    async run(db) {
      const empty = await repo.getLastDigestFiredAt(db);
      expectEqual('空库返回 null', empty, null);

      const trashBag = insertItem(db, '垃圾袋');
      const digestAt0900 = at(2026, 9, 14, 9, 0);
      const digestAt0905 = at(2026, 9, 14, 9, 5);

      await repo.insertHistory(db, {
        itemId: null,
        kind: 'daily_digest',
        firedAt: digestAt0900,
      });
      expectEqual('只发过一次摘要', await repo.getLastDigestFiredAt(db), digestAt0900);

      await repo.insertHistory(db, {
        itemId: null,
        kind: 'daily_digest',
        firedAt: digestAt0905,
      });
      expectEqual('两次摘要取最近那条', await repo.getLastDigestFiredAt(db), digestAt0905);

      // 关键：这条 fired_at 更大，但它有 item_id —— 不能把摘要的时间盖掉。
      // 这正是 getLastFiredAt 不能用在摘要上的原因（它对 itemId=null 直接 return null）。
      await repo.insertHistory(db, {
        itemId: trashBag,
        kind: 'out_of_stock',
        firedAt: at(2026, 9, 14, 23, 0),
      });
      expectEqual('有主的更新记录不得干扰摘要口径', await repo.getLastDigestFiredAt(db), digestAt0905);

      // 同为「无主」但 kind 不同，也不该被算进来
      await repo.insertHistory(db, {
        itemId: null,
        kind: 'buy_reminder',
        firedAt: at(2026, 9, 14, 22, 0),
      });
      expectEqual('无主但非摘要的 kind 被排除', await repo.getLastDigestFiredAt(db), digestAt0905);
    },
  },
  {
    name: 'insertHistory（itemId = null）',
    describe: '每日摘要的历史落库：无主记录不去重，有主记录去重',
    async run(db) {
      const trashBag = insertItem(db, '垃圾袋');
      const firedAt = at(2026, 9, 14, 9, 0);

      await repo.insertHistory(db, { itemId: null, kind: 'daily_digest', firedAt });
      await repo.insertHistory(db, { itemId: null, kind: 'daily_digest', firedAt });
      expectEqual(
        '同一时刻写两次摘要历史都会被保留（NULL 不参与唯一索引）',
        countRows(db, 'SELECT COUNT(*) AS n FROM notification_history WHERE item_id IS NULL'),
        2,
      );

      await repo.insertHistory(db, { itemId: trashBag, kind: 'buy_reminder', firedAt });
      await repo.insertHistory(db, { itemId: trashBag, kind: 'buy_reminder', firedAt });
      expectEqual(
        '有主的历史按 UNIQUE(item_id, kind, fired_at) 去重',
        countRows(
          db,
          `SELECT COUNT(*) AS n FROM notification_history
            WHERE item_id = ${trashBag} AND kind = 'buy_reminder'`,
        ),
        1,
      );

      // 无主记录会重复这一事实不影响正确性：摘要一律按 MAX(fired_at) 读。
      // 这里把它显式断言下来，是为了让「为什么不用唯一索引挡」有据可查。
    },
  },
  {
    name: 'countFiredSince',
    describe: 'P0「同日同一物品最多一条」的判据（scheduler 用它去重）',
    async run(db) {
      const trashBag = insertItem(db, '垃圾袋');
      const tissue = insertItem(db, '手帕纸');
      const detergent = insertItem(db, '洗衣液');
      const todayStart = at(2026, 9, 14, 0, 0);
      const yesterdayStart = at(2026, 9, 13, 0, 0);
      const tomorrowStart = at(2026, 9, 15, 0, 0);

      await repo.insertHistory(db, {
        itemId: trashBag,
        kind: 'out_of_stock',
        firedAt: at(2026, 9, 13, 23, 59, 59), // 昨天临睡前，不计入今天
      });
      await repo.insertHistory(db, {
        itemId: trashBag,
        kind: 'out_of_stock',
        firedAt: at(2026, 9, 14, 8, 0), // 今天已发过
      });
      await repo.insertHistory(db, {
        itemId: trashBag,
        kind: 'buy_reminder',
        firedAt: at(2026, 9, 14, 8, 10), // 同物品但不同类型
      });
      await repo.insertHistory(db, {
        itemId: tissue,
        kind: 'out_of_stock',
        firedAt: at(2026, 9, 14, 8, 20), // 别的物品
      });

      expectEqual(
        '今天该物品已发 1 条 P0',
        await repo.countFiredSince(db, trashBag, 'out_of_stock', todayStart),
        1,
      );
      expectEqual(
        '把窗口放宽到昨天起 → 2 条',
        await repo.countFiredSince(db, trashBag, 'out_of_stock', yesterdayStart),
        2,
      );
      expectEqual(
        '换个 kind 各算各的',
        await repo.countFiredSince(db, trashBag, 'buy_reminder', todayStart),
        1,
      );
      expectEqual(
        '另一件物品互不干扰',
        await repo.countFiredSince(db, tissue, 'out_of_stock', todayStart),
        1,
      );
      expectEqual(
        '从未发过的物品',
        await repo.countFiredSince(db, detergent, 'out_of_stock', todayStart),
        0,
      );
      expectEqual(
        'since 推到明天 → 今天发的不算',
        await repo.countFiredSince(db, trashBag, 'out_of_stock', tomorrowStart),
        0,
      );
    },
  },
  {
    name: 'nextFirePoint',
    describe: '下一个「到点时刻」：今天还没到 → 今天；已过/正好这一瞬 → 次日',
    async run(db) {
      expectEqual(
        '今天 8:00 调用，clock=09:00',
        show(nextFirePoint('09:00', at(2026, 9, 14, 8, 0))),
        show(at(2026, 9, 14, 9, 0)),
      );
      expectEqual(
        '今天 10:00 调用，clock=09:00（已过）',
        show(nextFirePoint('09:00', at(2026, 9, 14, 10, 0))),
        show(at(2026, 9, 15, 9, 0)),
      );
      expectEqual(
        '正好 09:00:00 调用（边界算已过，不排一个即刻过期的通知）',
        show(nextFirePoint('09:00', at(2026, 9, 14, 9, 0))),
        show(at(2026, 9, 15, 9, 0)),
      );
      expectEqual(
        '今天 23:59:59 调用，clock=00:00（跨午夜）',
        show(nextFirePoint('00:00', at(2026, 9, 14, 23, 59, 59))),
        show(at(2026, 9, 15, 0, 0)),
      );
      expectEqual(
        '9 月 30 日调用（跨月）',
        show(nextFirePoint('09:00', at(2026, 9, 30, 10, 0))),
        show(at(2026, 10, 1, 9, 0)),
      );
      expectEqual(
        '12 月 31 日调用（跨年）',
        show(nextFirePoint('09:00', at(2026, 12, 31, 10, 0))),
        show(at(2027, 1, 1, 9, 0)),
      );
      expectEqual(
        '平年 2 月 28 日调用',
        show(nextFirePoint('09:00', at(2026, 2, 28, 10, 0))),
        show(at(2026, 3, 1, 9, 0)),
      );
      expectEqual(
        '闰年 2 月 28 日调用（28 日仍在闰日之前）',
        show(nextFirePoint('09:00', at(2024, 2, 28, 10, 0))),
        show(at(2024, 2, 29, 9, 0)),
      );
      expectEqual(
        'clock 补零写法 9:05 与 09:05 等价',
        nextFirePoint('9:05', at(2026, 9, 14, 8, 0)),
        nextFirePoint('09:05', at(2026, 9, 14, 8, 0)),
      );

      expectThrows('clock 非法（25:00）', () => nextFirePoint('25:00', at(2026, 9, 14, 8, 0)));
      expectThrows('clock 非法（非 HH:mm）', () => nextFirePoint('上午9点', at(2026, 9, 14, 8, 0)));
    },
  },
  {
    name: '每日摘要文案',
    describe: 'buildDailyDigestCopy：把多件待补货物品合并成一条通知',
    async run(db) {
      expectEqual('没有待补货物品 → 不排通知（返回 null）', buildDailyDigestCopy([]), null);

      const one = buildDailyDigestCopy([{ itemName: '垃圾袋', isEstimated: false }]);
      expectEqual('1 件：标题', one.title, '垃圾袋快用完了');
      expectEqual('1 件：正文', one.body, '记得补货');

      const oneEstimated = buildDailyDigestCopy([{ itemName: '洗衣液', isEstimated: true }]);
      expectEqual('1 件（估算）：标题带标记', oneEstimated.title, '洗衣液（估算）快用完了');

      const two = buildDailyDigestCopy([
        { itemName: '垃圾袋', isEstimated: false },
        { itemName: '手帕纸', isEstimated: false },
      ]);
      expectEqual('2 件：标题', two.title, '家里这些快用完了');
      expectEqual('2 件：正文（列全，用「共」）', two.body, '垃圾袋、手帕纸 共 2 件，记得补货');

      // 用户定的口径：2 件没有省略时用「共」，超过 MAX_LISTED_NAMES 有省略时才用「等」
      expectEqual('摘要正文最多列几件（常量）', MAX_LISTED_NAMES, 3);

      const five = buildDailyDigestCopy([
        { itemName: '垃圾袋', isEstimated: false },
        { itemName: '手帕纸', isEstimated: false },
        { itemName: '酒精湿巾', isEstimated: false },
        { itemName: '洗洁精', isEstimated: false },
        { itemName: '保鲜袋', isEstimated: false },
      ]);
      expectEqual('5 件：标题', five.title, '家里这些快用完了');
      expectEqual('5 件：正文（列前 3 + 「等 N 件」）', five.body, '垃圾袋、手帕纸、酒精湿巾 等 5 件，记得补货');

      const threeWithEstimate = buildDailyDigestCopy([
        { itemName: '垃圾袋', isEstimated: false },
        { itemName: '手帕纸', isEstimated: false },
        { itemName: '洗衣液', isEstimated: true },
      ]);
      expectEqual(
        '含估算：只给估算物品加标记，其余保持原样',
        threeWithEstimate.body,
        '垃圾袋、手帕纸、洗衣液（估算） 共 3 件，记得补货',
      );

      const fourEstimatedFirst = buildDailyDigestCopy([
        { itemName: '洗衣液', isEstimated: true },
        { itemName: '柔顺剂', isEstimated: true },
        { itemName: '垃圾袋', isEstimated: false },
        { itemName: '手帕纸', isEstimated: false },
      ]);
      expectEqual(
        '多个估算 + 有省略',
        fourEstimatedFirst.body,
        '洗衣液（估算）、柔顺剂（估算）、垃圾袋 等 4 件，记得补货',
      );
    },
  },
  {
    name: 'P0 已用完文案',
    describe: 'buildOutOfStockCopy：突破每日摘要、单独成条',
    async run(db) {
      const copy0 = buildOutOfStockCopy('垃圾袋');
      expectEqual('P0：标题', copy0.title, '垃圾袋已用完');
      expectEqual('P0：正文', copy0.body, '现在是补货的最佳时机');

      const trimmed = buildOutOfStockCopy('  纸巾  ');
      expectEqual('P0：名字首尾空白会被去掉', trimmed.title, '纸巾已用完');
    },
  },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(path.join(tmpdir(), 'restock-notify-smoke-'));
const TOTAL = GROUPS.length;
let failures = 0;

console.log('='.repeat(76));
console.log('通知数据层 / 文案冒烟测试（scripts/notifications-smoke.mjs）');
console.log('='.repeat(76));
console.log(`  Node            : ${process.version}`);
console.log(`  项目根目录      : ${PROJECT_ROOT}`);
console.log(`  临时数据库目录  : ${tempDir}`);
console.log('  说明：数据写在真实迁移出来的库上（含 UNIQUE 约束），不是空壳表');

const ctx = new ScenarioContext(path.join(tempDir, 'notifications.db'));
ctx.open();
await migrateDbIfNeeded(ctx.db);
await verifySchemaShape(ctx.db);

for (const [index, group] of GROUPS.entries()) {
  console.log('');
  console.log('-'.repeat(76));
  console.log(`分组 ${index + 1}/${TOTAL}：${group.name}`);
  console.log(`  ${group.describe}`);
  console.log('-'.repeat(76));

  try {
    // 每组独立：清掉通知两张表，避免上一组的数据被下一组算进去
    await repo.clearAllNotifications(ctx.db);
    await group.run(ctx.db);
    console.log('  结果：通过');
  } catch (error) {
    failures += 1;
    console.log('  结果：失败');
    if (error instanceof SmokeFailure) {
      console.log(error.message.split('\n').map((text) => `    ${text}`).join('\n'));
    } else {
      console.log(`    异常：${error.stack ?? String(error)}`);
    }
  }
}

ctx.close();

console.log('');
console.log('='.repeat(76));
console.log(failures === 0 ? `全部通过：${TOTAL}/${TOTAL}` : `失败 ${failures} 项，共 ${TOTAL} 项`);
console.log('='.repeat(76));

try {
  rmSync(tempDir, { recursive: true, force: true });
} catch {
  console.log(`（临时目录未能删除，可手动清理：${tempDir}）`);
}

process.exitCode = failures === 0 ? 0 : 1;
