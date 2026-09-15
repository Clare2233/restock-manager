/**
 * 备份冒烟测试 —— `npm run backup:smoke`
 *
 * ===========================================================================
 * 覆盖「能在 Node 里验证」的那一半；剩下的一半留给真机
 * ===========================================================================
 *
 * 第六批次的备份有三件事是**模拟器验不了**的：
 * - 系统分享面板能不能呼出来、AirDrop / 微信传不传得过去；
 * - 文件选择器能不能看到网盘里的 json（各 ROM 的文件管理器行为不一）；
 * - iOS 的 UTI 关联是不是让用户能直接存进「文件」App。
 *
 * 剩下的部分其实是普通代码：读四张表、拼 JSON、校验、开事务写入。
 * 把它们留到真机上一次点对点传输来验证，代价高、也无法回归。
 * 所以这里用 `node:sqlite` + 真实源码（不做副本、不 mock）钉住这部分。
 *
 *   1. `services/backup/build-payload.ts` —— 导出到底打包了什么；
 *   2. `services/backup/validate.ts`     —— 各种坏文件必须被挡住；
 *   3. `services/backup/restore.ts`      —— 事务写入，以及**失败要整体回滚**。
 *
 * 为什么第 3 点必须在这里验：回滚一旦失效，结果是「一半新数据一半旧数据」，
 * 真机上看起来只是「导入失败了」，用户会以为数据没动 —— 这是最贵的一类假象。
 * 在 Node 里造一个坏文件、断言行数不变，只要三行代码。
 *
 * ---------------------------------------------------------------------------
 * 怎么跑
 * ---------------------------------------------------------------------------
 *     npm run backup:smoke
 *
 * 与 `db-migrate-smoke.mjs` / `notifications-smoke.mjs` 共用同一套基建
 * （`scripts/lib/node-sqlite.mjs`）：`node:sqlite` 顶替 `expo-sqlite`，
 * `@/` 别名由 `scripts/lib/ts-path-alias-loader.mjs` 解析，不引入任何 npm 依赖。
 * 前置条件：Node >= 22.18。
 *
 * ---------------------------------------------------------------------------
 * 为什么要先清一遍库
 * ---------------------------------------------------------------------------
 * `migrateDbIfNeeded()` 在**全新库**上会顺手播一遍种子数据（见它的注释），
 * 所以这里的临时库一开始不是空的。所有分组第一步都调
 * `clearAllBusinessTablesCore` 把库擦干净，断言才能写成确定的数字。
 */
import { register } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScenarioContext } from './lib/node-sqlite.mjs';

// 必须先注册 hook，后面的 import('@/...') 才能解析
register('./lib/ts-path-alias-loader.mjs', import.meta.url);

// 固定时间戳：导出与恢复都写在数据里，写死才能得到确定性的断言
// （2026-09-14T02:30Z，以及它之后的一分钟）
const FIXED_EXPORTED_AT = Date.UTC(2026, 8, 14, 2, 30);
const FIXED_NOW = FIXED_EXPORTED_AT + 60_000;

// ---------------------------------------------------------------------------
// 加载被测代码（真实源码，不是副本）
// ---------------------------------------------------------------------------

const loadHint =
  '\n  本脚本需要 Node >= 22.18（node:sqlite 可用 + 默认开启 TS 类型擦除），' +
  `\n  当前版本：${process.version}`;

let migrations;
let itemRepo;
let movementRepo;
let shoppingRepo;
let notifRepo;
let settingsRepo;
let backupRepo;
let payloadBuilder;
let validate;
let restore;
let defaults;
let backupTypes;
let backupFilePolicy;
let dataEpoch;
let dateUtils;
try {
  migrations = await import('@/db/migrations');
  itemRepo = await import('@/db/repositories/items.repo');
  movementRepo = await import('@/db/repositories/movements.repo');
  shoppingRepo = await import('@/db/repositories/shopping.repo');
  notifRepo = await import('@/db/repositories/notifications.repo');
  settingsRepo = await import('@/db/repositories/settings.repo');
  backupRepo = await import('@/db/repositories/backup.repo');
  payloadBuilder = await import('@/services/backup/build-payload');
  validate = await import('@/services/backup/validate');
  restore = await import('@/services/backup/restore');
  defaults = await import('@/constants/defaults');
  backupTypes = await import('@/types/backup');
  backupFilePolicy = await import('@/services/backup/backup-file');
  dataEpoch = await import('@/store/data-epoch');
  dateUtils = await import('@/utils/date');
} catch (error) {
  console.error(`[FAIL] 无法加载被测源码。${loadHint}\n  原始错误：${error.message}`);
  process.exit(1);
}

const { migrateDbIfNeeded, verifySchemaShape } = migrations;
const { DEFAULT_APP_SETTINGS, SETTINGS_KEYS } = defaults;
const { BACKUP_VERSION } = backupTypes;

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

function expectDeepEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new SmokeFailure(`断言失败：${label}\n    期望：${b}\n    实际：${a}`);
  }
  console.log(`  [ ok ] ${label} = ${a}`);
}

/** 期望抛错：非法 clock 这类防御必须有，而且必须是**抛**而不是悄悄返回个值 */
async function expectRejects(label, action) {
  try {
    await action();
  } catch (error) {
    console.log(`  [ ok ] ${label} → 抛错：${error.message}`);
    return;
  }
  throw new SmokeFailure(`断言失败：${label} 没有抛错`);
}

/** 期望抛错，且错误信息里出现过大的提示 */
function expectTooLarge(label, bytes, pattern) {
  try {
    backupFilePolicy.assertBackupWithinLimit(bytes);
  } catch (error) {
    if (!pattern.test(error.message)) {
      throw new SmokeFailure(
        `断言失败：${label} 抛了错，但文案不含预期提示\n    实际：${error.message}`,
      );
    }
    console.log(`  [ ok ] ${label} → ${error.message}`);
    return;
  }
  throw new SmokeFailure(`断言失败：${label} 本应被体积守卫拒绝`);
}

/** 校验必须拒绝：返回 ok 就是漏了防线 */
function expectInvalid(label, raw) {
  const result = validate.validateBackupFile(raw);
  if (result.ok) {
    throw new SmokeFailure(`断言失败：${label} 本应被拒绝，实际上通过了校验`);
  }
  console.log(`  [ ok ] ${label} → ${result.error}`);
}

function countRows(db, table) {
  return db.probe(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;
}

function idsOf(db, table) {
  return db.probe(`SELECT id FROM ${table} ORDER BY id ASC`).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// 布置场景
// ---------------------------------------------------------------------------

/** 清空所有业务数据（含 migrate 顺手播的种子），让每组的起点都一样 */
async function wipe(db) {
  await backupRepo.clearAllBusinessTablesCore(db);
}

/**
 * 布置一份「像真APP在用」的数据：2 件物品（1 件已归档）、4 条流水、
 * 2 条清单条目（手写 + 自动抑制）、2 条通知历史（含 itemId=null 的每日摘要）、
 * 非默认设置，外加一行 notification_plan 残留。
 */
async function arrangeRealData(db) {
  // `createItem` 返回的是完整 Item（不是 id）；这里只需要 id
  const trashBag = (
    await itemRepo.createItem(db, { name: '垃圾袋', unit: '卷', initialStock: 3, note: '厨房用' })
  ).id;
  const tissue = (
    await itemRepo.createItem(db, { name: '手帕纸', unit: '包', initialStock: 10 })
  ).id;
  await movementRepo.recordPurchase(db, {
    itemId: trashBag,
    quantity: 2,
    unitPrice: 3.5,
    occurredAt: FIXED_EXPORTED_AT,
  });
  await movementRepo.recordConsume(db, { itemId: trashBag, quantity: 1 });
  await itemRepo.setArchived(db, tissue, true);

  await shoppingRepo.addManualItem(db, { name: '地板巾' });
  await shoppingRepo.upsertAutoOverride(db, {
    itemId: trashBag,
    name: '垃圾袋',
    unit: '卷',
    quantity: 1,
    priority: 2,
    status: 'bought',
  });

  await notifRepo.insertHistory(db, {
    itemId: trashBag,
    kind: 'buy_reminder',
    firedAt: FIXED_EXPORTED_AT,
  });
  await notifRepo.insertHistory(db, {
    itemId: null,
    kind: 'daily_digest',
    firedAt: FIXED_EXPORTED_AT,
  });

  await settingsRepo.updateAppSettings(db, { currencySymbol: '$', defaultRemindDays: 7 });
  // 残留的计划签名：验证它既不会被导出、也会被恢复流程清掉
  await settingsRepo.setSettingValue(db, SETTINGS_KEYS.notificationPlan, 'sig-should-not-survive');

  return { trashBag, tissue };
}

/** 最小合法备份：省略的字段都要按验证策略回落到默认值 */
function minimalFile(overrides = {}) {
  return {
    version: 1,
    exportedAt: '2026-09-14T00:00:00.000Z',
    items: [{ id: 1, name: '垃圾袋', category: 'cleaning', unit: '卷', createdAt: 0, updatedAt: 0 }],
    movements: [],
    shopping_list_items: [],
    notification_history: [],
    settings: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 分组场景
// ---------------------------------------------------------------------------

const GROUPS = [
  {
    name: 'buildBackupPayload',
    describe: '导出到底打包了什么（含刻意不打包的东西）',
    async run(db) {
      await wipe(db);
      await arrangeRealData(db);

      const file = await payloadBuilder.buildBackupPayload(db, { exportedAt: FIXED_EXPORTED_AT });

      expectEqual('version 与 BACKUP_VERSION 一致', file.version, BACKUP_VERSION);
      expectEqual(
        'exportedAt 是导出时刻的 ISO 字符串',
        file.exportedAt,
        new Date(FIXED_EXPORTED_AT).toISOString(),
      );

      expectEqual('物品数（含归档的）', file.items.length, 2);
      const archived = file.items.find((item) => item.name === '手帕纸');
      expectTrue('归档物品也被导出（isArchived 保留 true）', archived?.isArchived === true);
      expectTrue(
        '物品里没有 stock 字段（库存由流水推导，不导出）',
        file.items.every((item) => !('stock' in item)),
      );
      expectEqual('保留物品备注这类可为 null 的字段', archived?.note ?? null, null);

      expectEqual('流水数（2 条期初 adjust + 采购 + 消耗）', file.movements.length, 4);
      expectTrue(
        '流水里有采购且带了单价',
        file.movements.some((m) => m.type === 'purchase' && m.unitPrice === 3.5),
      );

      expectEqual('清单条目数', file.shopping_list_items.length, 2);
      expectTrue(
        '清单同时含手写条目与自动抑制记录',
        file.shopping_list_items.some((row) => row.source === 'manual') &&
          file.shopping_list_items.some((row) => row.source === 'auto'),
      );

      expectEqual('通知历史数', file.notification_history.length, 2);
      expectTrue(
        'history 含 itemId=null 的每日摘要',
        file.notification_history.some((row) => row.itemId === null && row.kind === 'daily_digest'),
      );

      expectEqual('设置里的自定义货币符号', file.settings.currencySymbol, '$');
      expectEqual('设置里的自定义提醒天数', file.settings.defaultRemindDays, 7);

      expectTrue('不导出 notification_jobs', !('notification_jobs' in file));
      expectTrue('不导出 notification_plan', !('notification_plan' in file));
    },
  },

  {
    name: 'validate: 接受',
    describe: '最小合法文件必须通过 —— 缺省字段回落到库默认值',
    async run(db) {
      const result = validate.validateBackupFile(minimalFile());
      if (!result.ok) {
        throw new SmokeFailure(`断言失败：最小合法文件被拒绝了：${result.error}`);
      }
      const item = result.file.items[0];
      expectEqual('缺省 packSize → 1', item.packSize, 1);
      expectEqual('缺省 remindDays → DEFAULT_REMIND_DAYS', item.remindDays, DEFAULT_APP_SETTINGS.defaultRemindDays);
      expectEqual('缺省 notifyEnabled → true', item.notifyEnabled, true);
      expectEqual('缺省 notifyTime → 默认时刻', item.notifyTime, DEFAULT_APP_SETTINGS.defaultNotifyTime);
      expectEqual('缺省 isArchived → false', item.isArchived, false);
      expectEqual('缺省 note → null', item.note, null);
      expectTrue('summary 标记文件带了设置', result.summary.hasSettings === true);
      expectEqual('summary 物品数', result.summary.items, 1);

      const noSettings = validate.validateBackupFile(minimalFile({ settings: undefined }));
      if (!noSettings.ok) {
        throw new SmokeFailure(`断言失败：缺 settings 的文件被拒绝了：${noSettings.error}`);
      }
      expectTrue('缺 settings 时 summary 如实标记', noSettings.summary.hasSettings === false);
      expectEqual(
        '缺 settings 时回落到默认货币符号',
        noSettings.file.settings.currencySymbol,
        DEFAULT_APP_SETTINGS.currencySymbol,
      );

      expectEqual(
        'settings 里的非法值被逐字段兜底（费用符号空串 → 默认）',
        validate.validateBackupFile(minimalFile({ settings: { currencySymbol: '  ' } })).file.settings
          .currencySymbol,
        DEFAULT_APP_SETTINGS.currencySymbol,
      );
    },
  },

  {
    name: 'validate: 拒绝',
    describe: '坏文件必须在动数据库之前被挡住，并说清楚是哪一行哪个字段',
    async run(db) {
      expectInvalid('版本号高于当前支持的版本', minimalFile({ version: 2 }));
      expectInvalid('版本号不是整数', minimalFile({ version: 1.5 }));
      expectInvalid('缺少 version', minimalFile({ version: undefined }));
      expectInvalid('根不是对象', ['不是对象']);
      expectInvalid('缺少 movements 数组', minimalFile({ movements: undefined }));
      expectInvalid('缺少 settings 的对象形式之一：settings 是数组', minimalFile({ settings: [] }));
      expectInvalid('items 不是数组', minimalFile({ items: {} }));

      expectInvalid(
        '物品名称为空串',
        minimalFile({
          items: [{ id: 1, name: '   ', category: 'cleaning', unit: '卷' }],
        }),
      );
      expectInvalid(
        '物品 id 不是正整数',
        minimalFile({
          items: [{ id: 0, name: '垃圾袋', category: 'cleaning', unit: '卷' }],
        }),
      );
      expectInvalid(
        '物品缺少 unit',
        minimalFile({ items: [{ id: 1, name: '垃圾袋', category: 'cleaning' }] }),
      );
      expectInvalid(
        '物品 id 重复',
        minimalFile({
          items: [
            { id: 7, name: '垃圾袋', category: 'cleaning', unit: '卷', createdAt: 0, updatedAt: 0 },
            { id: 7, name: '手帕纸', category: 'paper', unit: '包', createdAt: 0, updatedAt: 0 },
          ],
        }),
      );
      expectInvalid(
        'notifyTime 不是 HH:mm',
        minimalFile({
          items: [{ id: 1, name: '垃圾袋', category: 'cleaning', unit: '卷', notifyTime: '9点' }],
        }),
      );
      expectInvalid(
        'notifyEnabled 写成 1（必须是 true/false）',
        minimalFile({
          items: [{ id: 1, name: '垃圾袋', category: 'cleaning', unit: '卷', notifyEnabled: 1 }],
        }),
      );
      expectInvalid(
        '流水指向不存在的物品',
        minimalFile({
          movements: [{ id: 1, itemId: 99, type: 'purchase', quantity: 1, occurredAt: 0, createdAt: 0 }],
        }),
      );
      expectInvalid(
        'consume 的数量不是负数',
        minimalFile({
          movements: [{ id: 1, itemId: 1, type: 'consume', quantity: 2, occurredAt: 0, createdAt: 0 }],
        }),
      );
      expectInvalid(
        'adjust 的数量为 0',
        minimalFile({
          movements: [{ id: 1, itemId: 1, type: 'adjust', quantity: 0, occurredAt: 0, createdAt: 0 }],
        }),
      );
      expectInvalid(
        '未知的流水类型（不许静默兜底成 adjust）',
        minimalFile({
          movements: [
            { id: 1, itemId: 1, type: 'restock', quantity: 1, occurredAt: 0, createdAt: 0 },
          ],
        }),
      );
      expectInvalid(
        '清单 status 越界',
        minimalFile({
          shopping_list_items: [{ id: 1, name: '毛巾', quantity: 1, source: 'manual', status: 'done', addedAt: 0 }],
        }),
      );
      expectInvalid(
        '通知历史 kind 越界',
        minimalFile({
          notification_history: [{ id: 1, itemId: null, kind: 'weekly', firedAt: 0 }],
        }),
      );
      expectInvalid(
        '清单条目的 itemId 指向不存在的物品',
        minimalFile({
          shopping_list_items: [
            { id: 1, itemId: 42, name: '毛巾', quantity: 1, source: 'manual', status: 'pending', addedAt: 0 },
          ],
        }),
      );

      const brokenJson = validate.parseBackupFile('{ "version": 1, }');
      if (brokenJson.ok) throw new SmokeFailure('断言失败：坏 JSON 竟然通过解析');
      console.log(`  [ ok ] JSON 语法错误 → ${brokenJson.error}`);
    },
  },

  {
    name: 'restoreBackup',
    describe: '清空 → 写入 → 重算库存 → 写设置，全在一事务里',
    async run(db) {
      await wipe(db);
      await arrangeRealData(db);
      const file = await payloadBuilder.buildBackupPayload(db, { exportedAt: FIXED_EXPORTED_AT });
      const expectedItemIds = idsOf(db, 'items');

      // 模拟「用户确认清空现有数据」
      await wipe(db);
      expectEqual('清空后物品数为', countRows(db, 'items'), 0);

      const counts = await restore.restoreBackup(db, file, { now: FIXED_NOW });
      expectEqual('恢复返回：物品', counts.items, 2);
      expectEqual('恢复返回：流水', counts.movements, 4);
      expectEqual('恢复返回：清单条目', counts.shoppingListItems, 2);
      expectEqual('恢复返回：通知历史', counts.notificationHistory, 2);

      expectEqual('库里物品数', countRows(db, 'items'), 2);
      expectEqual('库里流水数', countRows(db, 'stock_movements'), 4);
      expectEqual('库里清单条目数', countRows(db, 'shopping_list_items'), 2);
      expectEqual('库里通知历史数', countRows(db, 'notification_history'), 2);
      expectEqual('恢复后 notification_jobs 仍是空（不导入系统 identifier）', countRows(db, 'notification_jobs'), 0);

      expectDeepEqual('物品的 id 原样保留', idsOf(db, 'items'), expectedItemIds);
      expectTrue(
        '流水的 id 也原样保留',
        idsOf(db, 'stock_movements').every((id) => file.movements.some((m) => m.id === id)),
      );

      // 库存必须在流水插完之后重算：逐物品比对 SUM(quantity) 与 items.stock
      const stockRows = db.probe(
        `SELECT i.id, i.stock AS cached, COALESCE(SUM(m.quantity), 0) AS computed
           FROM items i LEFT JOIN stock_movements m ON m.item_id = i.id
          GROUP BY i.id`,
      );
      for (const row of stockRows) {
        expectEqual(`物品 ${row.id} 的库存与流水求和一致`, row.cached, row.computed);
      }

      expectEqual(
        'notification_plan 这行旧签名已被清掉（否则导入后首次重排会被短路）',
        db.probe(`SELECT key FROM app_settings WHERE key = '${SETTINGS_KEYS.notificationPlan}'`).length,
        0,
      );

      const restored = await settingsRepo.getAppSettings(db);
      expectEqual('设置：货币符号跟着备份走', restored.currencySymbol, '$');
      expectEqual('设置：提醒天数跟着备份走', restored.defaultRemindDays, 7);
      expectEqual('设置：lastRestoreAt 记的是本次时间', restored.lastRestoreAt, FIXED_NOW);

      expectTrue(
        '归档标记也恢复了对（不是变成未归档）',
        db.probe("SELECT is_archived FROM items WHERE name = '手帕纸'")[0].is_archived === 1,
      );
      expectTrue(
        '每日摘要历史（itemId = NULL）恢复成功',
        countRows(db, 'notification_history') === 2 &&
          db.probe(
            "SELECT COUNT(*) AS n FROM notification_history WHERE item_id IS NULL AND kind = 'daily_digest'",
          )[0].n === 1,
      );
    },
  },

  {
    name: 'restoreBackup: 失败必须整体回滚',
    describe: '事务中途失败时，库必须还是导入前的样子',
    async run(db) {
      await wipe(db);
      await arrangeRealData(db);
      const before = {
        items: countRows(db, 'items'),
        movements: countRows(db, 'stock_movements'),
        shopping: countRows(db, 'shopping_list_items'),
        history: countRows(db, 'notification_history'),
      };

      // 这份文件能通过校验（各实体的 id 都不重复），但会撞上
      // notification_history 的 UNIQUE(item_id, kind, fired_at)：
      // 两条历史参数完全相同、只有 id 不同。
      // 故意用它来验「数据库的最后一道防线被触发时，事务有没有把我带回去」。
      const file = await payloadBuilder.buildBackupPayload(db, { exportedAt: FIXED_EXPORTED_AT });
      const duplicate = {
        ...file.notification_history[0],
        id: file.notification_history[0].id + 500,
      };
      const poisoned = {
        ...file,
        notification_history: [...file.notification_history, duplicate],
      };
      if (!validate.validateBackupFile(poisoned).ok) {
        throw new SmokeFailure('场景自身有问题：这份文件应当能通过校验');
      }

      await expectRejects('插入重复历史时被 SQLite 拒绝', () =>
        restore.restoreBackup(db, poisoned, { now: FIXED_NOW }),
      );

      expectEqual('回滚：物品数未变', countRows(db, 'items'), before.items);
      expectEqual('回滚：流水数未变', countRows(db, 'stock_movements'), before.movements);
      expectEqual('回滚：清单条目数未变', countRows(db, 'shopping_list_items'), before.shopping);
      expectEqual('回滚：通知历史数未变', countRows(db, 'notification_history'), before.history);
      expectEqual(
        '回滚：设置也没被改写成 lastRestoreAt',
        (await settingsRepo.getAppSettings(db)).lastRestoreAt,
        null,
      );
    },
  },

  {
    name: 'backup-file: 命名与体积上限',
    describe: '20MB 上限的边界行为（Node 里唯一能验的「文件政策」部分）',
    async run(db) {
      // 文件名按**本地日历日**生成：同一天重复导出必须落在同一个文件名上，
      // 这是「缓存里不会攒出一堆同名备份」的前提。
      // 期望值跟着本机时区走（固定时间戳换算成哪一日本来就取决于时区），
      // 所以这里用与被测代码同一份 `toISODate` 来算期望值之外，
      // 再单独断言它是「前缀 + YYYY-MM-DD + .json」这个形状。
      const name = backupFilePolicy.buildBackupFileName(FIXED_EXPORTED_AT);
      expectEqual('文件名 = 前缀 + 本地日期 + .json', name, `囤货清单备份-${dateUtils.toISODate(FIXED_EXPORTED_AT)}.json`);
      expectTrue(
        '文件名形状是 前缀-YYYY-MM-DD.json',
        /^囤货清单备份-\d{4}-\d{2}-\d{2}\.json$/.test(name),
      );

      expectDeepEqual(
        '同一时刻导出两次 → 同名（会互相覆盖，不会堆积）',
        backupFilePolicy.buildBackupFileName(FIXED_EXPORTED_AT),
        name,
      );

      const limit = backupFilePolicy.MAX_BACKUP_BYTES;
      expectEqual('上限是 20MB', limit, 20 * 1024 * 1024);

      // 边界：正好等于上限必须放行 —— 守卫写成 `>=` 会把合法文件拒之门外
      backupFilePolicy.assertBackupWithinLimit(limit);
      console.log('  [ ok ] 正好等于上限的文件放行');

      backupFilePolicy.assertBackupWithinLimit(limit - 1);
      console.log('  [ ok ] 小于上限的文件放行');

      // 选择器没报告体积时不能误杀
      backupFilePolicy.assertBackupWithinLimit(null);
      backupFilePolicy.assertBackupWithinLimit(undefined);
      console.log('  [ ok ] 体积未知（null / undefined）时放行，交给读取处再守一道');

      expectTooLarge('超过上限 1 字节', limit + 1, /超过上限/);
      expectTooLarge('远超上限（500MB 视频）', 500 * 1024 * 1024, /超过上限/);

      expectEqual('体积文案：小于 1KB 按字节', backupFilePolicy.describeBackupBytes(512), '512 B');
      expectEqual('体积文案：KB 保留一位', backupFilePolicy.describeBackupBytes(2048), '2.0 KB');
      expectEqual('体积文案：MB 保留一位', backupFilePolicy.describeBackupBytes(limit), '20.0 MB');
    },
  },

  {
    name: 'data-epoch',
    describe: '数据世代号的递增与读取（页面聚焦时靠它判断要不要强查）',
    async run(db) {
      dataEpoch.__resetDataEpoch();
      expectEqual('初始值', dataEpoch.getDataEpoch(), 0);

      dataEpoch.bumpDataEpoch();
      expectEqual('bump 一次之后', dataEpoch.getDataEpoch(), 1);
      dataEpoch.bumpDataEpoch();
      expectEqual('再 bump 一次（只增不减）', dataEpoch.getDataEpoch(), 2);

      // 「页面上次看到的 epoch」与「当前 epoch」不同 → 该强查了。
      // 这里模拟的就是 use-items 里那个 ref 的比较。
      const seenBeforeImport = dataEpoch.getDataEpoch();
      expectEqual('没发生替换时：两者相同（走 30 秒过期逻辑）', seenBeforeImport, 2);
      dataEpoch.bumpDataEpoch();
      expectTrue('发生替换后：两者不同（页面会无条件强查）', dataEpoch.getDataEpoch() !== seenBeforeImport);

      dataEpoch.__resetDataEpoch();
      expectEqual('__resetDataEpoch 用于隔离用例', dataEpoch.getDataEpoch(), 0);
    },
  },

  {
    name: 'clearAllDataCore',
    describe: '设置页「清空数据」：六张业务表全空、不播种',
    async run(db) {
      await wipe(db);
      await arrangeRealData(db);
      expectTrue('清空前确实有数据', countRows(db, 'items') > 0);

      await restore.clearAllDataCore(db);

      expectEqual('items', countRows(db, 'items'), 0);
      expectEqual('stock_movements', countRows(db, 'stock_movements'), 0);
      expectEqual('shopping_list_items', countRows(db, 'shopping_list_items'), 0);
      expectEqual('notification_history', countRows(db, 'notification_history'), 0);
      expectEqual('notification_jobs', countRows(db, 'notification_jobs'), 0);
      expectEqual('app_settings', countRows(db, 'app_settings'), 0);

      const settings = await settingsRepo.getAppSettings(db);
      expectEqual('清空后再读设置 → 默认货币符号', settings.currencySymbol, DEFAULT_APP_SETTINGS.currencySymbol);
      expectEqual('清空后再读设置 → lastBackupAt 归零', settings.lastBackupAt, null);
      expectEqual('清空后再读设置 → lastRestoreAt 归零', settings.lastRestoreAt, null);
    },
  },
];

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const TOTAL = GROUPS.length;
let failures = 0;
const tempDir = mkdtempSync(path.join(tmpdir(), 'restock-backup-smoke-'));

console.log('='.repeat(76));
console.log(`备份冒烟测试：${TOTAL} 个分组`);
console.log(`临时库：${tempDir}`);
console.log('='.repeat(76));

const ctx = new ScenarioContext(path.join(tempDir, 'backup.db'));
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
