/**
 * 库存下限冒烟测试 —— `npm run stock:smoke`
 *
 * ===========================================================================
 * 这个脚本存在的唯一目的：
 * 守住「库存永远不能写成负数」，而且要守住**所有入口**，不是一个页面。
 * ===========================================================================
 *
 * 事故回放：「手帕纸」库存 0，AI 录入一句「今天用了一卷纸」解析成 consume 1，
 * 直接调 `recordConsume` 写库，库存变成 -1。当时防线的位置是错的 ——
 * 校验写在手动录入页（「不能超过当前库存」），而 AI 录入路径不经过那个页面，
 * `recordDiscard` 更是**至今只有 AI 一个调用方**，连 UI 兜底都没有。
 *
 * 所以修补的位置选在 `movements.repo` 的 `applyMovementCore`：所有流水写入的
 * 唯一通道。本脚本钉住的就是这件事 —— **不论从哪个入口进，判据都一样**。
 * 页面级的友好提示（`consume.tsx`、AI 确认卡片）是体验层的事，
 * 真机上怎么点都验不全，这里几条 SQL 就能覆盖。
 *
 * ---------------------------------------------------------------------------
 * 怎么跑
 * ---------------------------------------------------------------------------
 *     npm run stock:smoke
 *
 * 不需要 Expo、不需要模拟器、不需要网络、**不引入任何 npm 依赖**：
 * 与 `db-migrate-smoke.mjs` / `backup-smoke.mjs` 共用同一套基建
 * （`scripts/lib/node-sqlite.mjs` + `scripts/lib/ts-path-alias-loader.mjs`），
 * 直接 import `src/db/repositories` 的**真实源码**跑真 SQLite。
 *
 * 前置条件：Node >= 22.18（`node:sqlite` 可用 + 默认开启 TS 类型擦除）。
 *
 * ---------------------------------------------------------------------------
 * 覆盖的场景
 * ---------------------------------------------------------------------------
 * 1. 库存 0 + 各种扣减 → 抛错，且**一条流水都没写进去**（拦在写之前，不是写了再回滚）
 *    consume（AI）/ discard（AI，唯一无 UI 防线的入口）/ 快捷扣减 三条路径各来一遍
 * 2. 库存 5 + consume 3 → 成功，余额 2（缓存值与流水求和都要对得上）
 *    顺带：库存剩 2 再扣 2.5 被拦（超额，但数量不为零）
 * 3. 库存 0 + adjust 到 0 → 「无需盘点」短路先于下限检查（差值为 0，压根不写）
 * 4. 库存 -1 + adjust 到 0 → **成功**：这正是修负数库存的路径（0 >= 0 放行）
 * 5. 库存 0 + adjust 到 -1 → 抛错（盘点也不能把库存写成负数）
 * 6. 库存已经是负数 + purchase → **不拦**：刻意的例外，进货只会让余额变大，
 *    挡住它等于让负库存失去最后一条自救路径
 *
 * 场景 4、6 需要「库存已经是负数」这种脏数据，靠 `adapter.arrange` 裸写一条流水造出来
 * （这是历史上真实发生过的事：AI 绕过防线写进去的就是这么一条）。
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

const LOAD_HINT =
  '本脚本需要 Node >= 22.18（node:sqlite 可用 + 默认开启 TS 类型擦除），' +
  `当前版本：${process.version}`;

let migrations;
let itemRepo;
let movementRepo;
try {
  migrations = await import('@/db/migrations');
  itemRepo = await import('@/db/repositories/items.repo');
  movementRepo = await import('@/db/repositories/movements.repo');
} catch (error) {
  console.error(`[FAIL] 无法加载被测源码。\n  ${LOAD_HINT}\n  原始错误：${error.message}`);
  process.exit(1);
}

const { migrateDbIfNeeded } = migrations;

/** 固定时间戳：写进 occurred_at / created_at，流水才有确定的样子 */
const NOW = Date.UTC(2026, 8, 22, 10, 0);

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

/**
 * 期望抛错。**关键是它到底写了还是没写**：
 * 所以每个场景都会先用 readStock 拍一张快照，跟被拒之后再比一次。
 */
async function expectRejects(label, action, pattern) {
  try {
    await action();
  } catch (error) {
    const message = error.message ?? String(error);
    if (pattern && !pattern.test(message)) {
      throw new SmokeFailure(
        `断言失败：${label} 抛了错，但文案不含预期提示\n` +
          `    期望匹配：${pattern}\n    实际：${message}`,
      );
    }
    console.log(`  [ ok ] ${label} → 抛错：${message}`);
    return;
  }
  throw new SmokeFailure(`断言失败：${label} 没有抛错`);
}

// ---------------------------------------------------------------------------
// 布置场景
// ---------------------------------------------------------------------------

/** migrate 会顺手播种，先擦干净，每组才有确定的起点 */
function wipe(db) {
  db.arrange('DELETE FROM stock_movements; DELETE FROM items;');
}

async function createItem(db, name, unit, initialStock) {
  const item = await itemRepo.createItem(db, { name, unit, initialStock });
  return item.id;
}

/** 读一件物品的三样东西：流水求和（唯一事实来源）、items.stock（缓存）、流水条数 */
function readStock(db, itemId) {
  return {
    computed: db.probe(
      `SELECT COALESCE(SUM(quantity), 0) AS stock FROM stock_movements WHERE item_id = ${itemId}`,
    )[0].stock,
    cached: db.probe(`SELECT stock FROM items WHERE id = ${itemId}`)[0].stock,
    movements: db.probe(`SELECT COUNT(*) AS n FROM stock_movements WHERE item_id = ${itemId}`)[0].n,
  };
}

/**
 * 裸写一条负流水 —— 用来造「库存已经是负数」这种脏数据。
 * 走 arrange 而不是 repo，是因为 repo 现在一定会拦；
 * 而历史上那条 -1 正是**绕过** repo 防线之后写进去的。
 */
function seedBrokenMovement(db, itemId, quantity, note) {
  db.arrange(
    `INSERT INTO stock_movements
       (item_id, type, quantity, occurred_at, source, note, created_at)
     VALUES (${itemId}, 'consume', ${quantity}, ${NOW}, 'ai', '${note}', ${NOW})`,
  );
}

const SCENARIOS = [
  {
    name: '库存 0 + 扣减 → 拦住，且一条流水都没写进去',
    describe: '三个入口：AI 消耗 / AI 丢弃（无 UI 防线，本事故的成因）/ 快捷扣减',
    async run(ctx) {
      const db = ctx.db;
      const itemId = await createItem(db, '手帕纸', '包', 0);
      const before = readStock(db, itemId);
      expectEqual('起始库存', before.computed, 0);

      await expectRejects(
        'AI 消耗 1',
        () => movementRepo.recordConsume(db, { itemId, quantity: 1, source: 'ai' }),
        /库存不足/,
      );
      await expectRejects(
        'AI 丢弃 1（recordDiscard 的唯一调用方）',
        () => movementRepo.recordDiscard(db, { itemId, quantity: 1, source: 'ai' }),
        /库存不足/,
      );
      await expectRejects(
        '快捷扣减（「用一次」按钮）',
        () => movementRepo.recordQuickConsume(db, { itemId }),
        /库存不足/,
      );

      const after = readStock(db, itemId);
      expectEqual('被拒之后流水平衡未变', after.computed, 0);
      expectEqual('被拒之后流水条数未变（拦在 INSERT 之前）', after.movements, before.movements);
      expectEqual('被拒之后缓存库存未变', after.cached, 0);
    },
  },
  {
    name: '库存 5 + 扣减 3 → 成功，余额 2',
    describe: '够扣就必须放过去，且缓存值与流水求和都要对得上',
    async run(ctx) {
      const db = ctx.db;
      const itemId = await createItem(db, '猫罐头', '个', 5);

      const result = await movementRepo.recordConsume(db, { itemId, quantity: 3 });
      expectEqual('返回值里的余额', result.stock, 2);

      const stock = readStock(db, itemId);
      expectEqual('流水求和', stock.computed, 2);
      expectEqual('items.stock 缓存', stock.cached, 2);

      const before = readStock(db, itemId);
      await expectRejects(
        '库存剩 2 再扣 2.5（超额，但数量不为零）',
        () => movementRepo.recordConsume(db, { itemId, quantity: 2.5 }),
        /库存不足/,
      );
      expectEqual('超额被拒后流水条数未变', readStock(db, itemId).movements, before.movements);
    },
  },
  {
    name: '库存 0 + 盘点成 0 → 「无需盘点」',
    describe: '差值为 0 的短路先于下限检查：这不是负数被拒，是压根没有要盘的差值',
    async run(ctx) {
      const db = ctx.db;
      const itemId = await createItem(db, '垃圾袋', '卷', 0);
      const before = readStock(db, itemId);

      await expectRejects(
        'adjust 到 0',
        () => movementRepo.adjustStockTo(db, { itemId, targetStock: 0 }),
        /无需盘点/,
      );
      expectEqual('流水条数未变', readStock(db, itemId).movements, before.movements);
    },
  },
  {
    name: '库存 -1 + 盘点成 0 → 成功',
    describe: '修负数库存的路径：目标是 0，0 >= 0 放行（用户就该这么把 -1 那条账抹平）',
    async run(ctx) {
      const db = ctx.db;
      const itemId = await createItem(db, '手帕纸', '包', 0);
      // 造出历史脏数据：AI 曾绕过防线写进去的那条 -1
      seedBrokenMovement(db, itemId, -1, 'AI 误录');
      await movementRepo.recomputeStockCore(db, itemId);
      expectEqual('脏数据下的当前库存', readStock(db, itemId).computed, -1);

      const result = await movementRepo.adjustStockTo(db, { itemId, targetStock: 0, source: 'ai' });
      expectEqual('盘点后的余额', result.stock, 0);

      const stock = readStock(db, itemId);
      expectEqual('流水求和', stock.computed, 0);
      expectEqual('items.stock 缓存', stock.cached, 0);
    },
  },
  {
    name: '库存 0 + 盘点成 -1 → 拦住',
    describe: '盘点同样受下限约束：调整后的余额也不能是负数',
    async run(ctx) {
      const db = ctx.db;
      const itemId = await createItem(db, '牛奶', '盒', 0);
      const before = readStock(db, itemId);

      await expectRejects(
        'adjust 到 -1',
        () => movementRepo.adjustStockTo(db, { itemId, targetStock: -1 }),
        /盘点后库存不能是负数/,
      );
      expectEqual('流水条数未变', readStock(db, itemId).movements, before.movements);
      expectEqual('库存未变', readStock(db, itemId).computed, 0);
    },
  },
  {
    name: '库存已经是负数 + 进货 → 不拦（刻意的例外）',
    describe: 'purchase 的余额只会变大；挡住它等于让负库存失去最后一条自救路径',
    async run(ctx) {
      const db = ctx.db;
      const itemId = await createItem(db, '卫生纸', '提', 0);
      seedBrokenMovement(db, itemId, -5, '历史脏数据');
      await movementRepo.recomputeStockCore(db, itemId);
      expectEqual('起始库存', readStock(db, itemId).computed, -5);

      const result = await movementRepo.recordPurchase(db, { itemId, quantity: 2 });
      expectEqual('进货后的余额', result.stock, -3);
      expectEqual('流水求和', readStock(db, itemId).computed, -3);
    },
  },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const TEMP_DIR = mkdtempSync(path.join(tmpdir(), 'stock-floor-smoke-'));
let failures = 0;

console.log('='.repeat(76));
console.log('库存下限冒烟测试（scripts/stock-floor-smoke.mjs）');
console.log('='.repeat(76));
console.log(`  Node              : ${process.version}`);
console.log(`  项目根目录        : ${PROJECT_ROOT}`);
console.log(`  临时数据库目录    : ${TEMP_DIR}`);

for (const [index, scenario] of SCENARIOS.entries()) {
  console.log('');
  console.log('-'.repeat(76));
  console.log(`场景 ${index + 1}/${SCENARIOS.length}：${scenario.name}`);
  console.log(`  ${scenario.describe}`);
  console.log('-'.repeat(76));

  const ctx = new ScenarioContext(path.join(TEMP_DIR, `scenario-${index + 1}.db`));

  try {
    ctx.open();
    await migrateDbIfNeeded(ctx.db);
    wipe(ctx.db);
    await scenario.run(ctx);
    console.log('  结果：通过');
  } catch (error) {
    failures += 1;
    if (error instanceof SmokeFailure) {
      console.error(`  [FAIL] ${error.message}`);
    } else {
      console.error(`  [FAIL] 场景异常：${error.stack ?? error.message ?? String(error)}`);
    }
  } finally {
    ctx.close();
  }
}

console.log('');
console.log('='.repeat(76));
console.log(failures === 0 ? `全部通过：${SCENARIOS.length}/${SCENARIOS.length}` : `失败 ${failures} 项，共 ${SCENARIOS.length} 项`);
console.log('='.repeat(76));

try {
  rmSync(TEMP_DIR, { recursive: true, force: true });
} catch {
  console.log(`（临时目录未能删除，可手动清理：${TEMP_DIR}）`);
}

process.exitCode = failures === 0 ? 0 : 1;
