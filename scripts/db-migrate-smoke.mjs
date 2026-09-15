/**
 * 数据库迁移冒烟测试 —— `npm run db:smoke`
 *
 * ===========================================================================
 * 这个脚本存在的唯一目的：
 * 防止「仓库层 INSERT 引用了比当前迁移点更新的列」这类 bug 再次发生。
 * ===========================================================================
 *
 * `src/db/repositories/*.ts` 里的 INSERT 永远按**最新 schema**写，
 * 例如 `createItemCore` 会写 `note`、`estimated_cycle_days`。
 * 但迁移是逐级的：`SCHEMA_V1` 建出来的 `items` 表**没有**这两列，
 * 要到 `SCHEMA_V2` 才补上。
 *
 * 一旦播种 / 校验 / 修复的代码被放在「V1 之后、V2 之前」执行，
 * SQLite 会在 prepare 阶段直接拒绝：
 *
 *     table items has no column named note
 *
 * 异常冒泡出 `withTransactionAsync` → **DDL 一起被回滚** →
 * 下次启动又是「建表 → 播种失败 → 回滚」，库永远是空的。
 *
 * 这个 bug 曾经让 App 在全新安装时直接卡在错误页，而且当时没有任何测试能拦住它：
 * 错误页只说 `table items has no column named note`，诊断却显示「items 表不存在」
 * （因为表已经被回滚掉了），看起来自相矛盾，极难定位。
 * 所以除了「跑通」，本脚本还要断言**迁移后的真实结构**：
 * user_version / items 列数 / items 行数。
 *
 * ---------------------------------------------------------------------------
 * 怎么跑
 * ---------------------------------------------------------------------------
 *     npm run db:smoke
 *
 * 不需要 Expo、不需要模拟器、不需要网络、**不引入任何 npm 依赖**：
 * - 用 Node 内置的 `node:sqlite` 顶替 `expo-sqlite`（见 `scripts/lib/node-sqlite.mjs`）；
 * - 直接 import `src/db/migrations.ts` 的**真实源码**跑迁移，
 *   不复制 SQL、不依赖构建产物，所以它测的永远是你现在改的代码；
 * - `@/` 路径别名由 `scripts/lib/ts-path-alias-loader.mjs` 解析。
 *
 * 前置条件：Node >= 22.18（`node:sqlite` 可用 + 默认开启 TS 类型擦除）。
 *
 * ---------------------------------------------------------------------------
 * 覆盖的场景
 * ---------------------------------------------------------------------------
 * 1. 全新库    —— 文件不存在，首次安装（曾经必崩的那条路径）
 * 2. 历史坏库  —— `user_version = 2` 但结构停在 V1，且已有用户数据
 *                 （走 `migrateDbIfNeeded` 的「版本已到位」分支，靠自检补列）
 * 3. 半残库    —— `user_version = 1`，V2 片段还没跑，已有用户数据
 * 4. 删库重建  —— 关连接 → 删 .db/-wal/-shm → 重新打开 → 迁移
 *                 （client.ts 的兜底路径，真机上曾在这里「重建失败」）
 * 5. 清空重建  —— 设置页「清空数据」的 `resetDatabase`：删表 → V1 → V2 → 播种 → 版本号。
 *                 除最终结构外还要**断言这个顺序**：把 `user_version` 提到播种之前
 *                 是完全静默的，只看最终结果发现不了。
 *
 * 每个场景都完整走一遍 `client.ts` 的启动流程：
 * `migrateDbIfNeeded()` + `verifySchemaShape()`（场景 5 额外走 `resetDatabase()`）。
 *
 * 第 2、3 个场景带用户数据，是为了守住两条底线：
 * **补列不能丢数据，也不能重复播种**。
 * 另有一条附加检查：诊断用的 `SCHEMA_V1_ITEM_COLUMNS` 常量与真实 DDL 是否同步。
 *
 * 调试：`SMOKE_TRACE=full npm run db:smoke` 在成功时也打印全部 SQL 原文。
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
let resetDatabase;
let DATABASE_VERSION;
let SCHEMA_V1;
let SCHEMA_V1_ITEM_COLUMNS;
let SCHEMA_V2_ITEM_COLUMNS;
try {
  ({ migrateDbIfNeeded, verifySchemaShape, resetDatabase, DATABASE_VERSION } =
    await import('@/db/migrations'));
  ({ SCHEMA_V1, SCHEMA_V1_ITEM_COLUMNS, SCHEMA_V2_ITEM_COLUMNS } = await import('@/db/schema'));
} catch (error) {
  console.error(`[FAIL] 无法加载 src/db 下的迁移源码。${loadHint}\n  原始错误：${error.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 期望值
// ---------------------------------------------------------------------------

/** 与 src/db/seed.ts 的 SEED_ITEMS 条数一致；改了种子数据记得同步这里 */
const EXPECTED_SEED_ITEM_COUNT = 6;

/** 迁移跑完之后 items 应该有的全部列 = V1 骨架 + V2 增量 */
const EXPECTED_ITEM_COLUMNS = [
  ...SCHEMA_V1_ITEM_COLUMNS,
  ...SCHEMA_V2_ITEM_COLUMNS.map((column) => column.name),
];

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

class SmokeFailure extends Error {}

function expect(label, actual, expected) {
  if (actual !== expected) {
    throw new SmokeFailure(`断言失败：${label}\n  期望：${expected}\n  实际：${actual}`);
  }
  console.log(`  [ ok ] ${label} = ${actual}`);
}

/** 读迁移之后的真实结构（断言口径，与诊断页一致） */
function readState(adapter) {
  const version = adapter.probe('PRAGMA user_version')[0]?.user_version ?? 0;
  const itemExists =
    adapter.probe("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'").length >
    0;
  const columns = itemExists ? adapter.probe('PRAGMA table_info(items)').map((row) => row.name) : [];
  const itemRows = itemExists ? adapter.probe('SELECT COUNT(*) AS n FROM items')[0].n : 0;
  return { version, itemExists, columns, itemRows };
}

function assertScenario(scenario, state) {
  expect('user_version', state.version, scenario.expected.version);

  if (!state.itemExists) {
    throw new SmokeFailure(
      '断言失败：items 表不存在。\n' +
        '  说明迁移事务被回滚了（DDL 一起消失）—— 最可能的原因就是某条 SQL\n' +
        '  在骨架补齐之前引用了还不存在的列，请检查上方 trace 里失败的语句。',
    );
  }
  console.log('  [ ok ] items 表存在');

  expect('items 列数', state.columns.length, scenario.expected.itemColumns);

  const missing = EXPECTED_ITEM_COLUMNS.filter((name) => !state.columns.includes(name));
  if (missing.length > 0) {
    throw new SmokeFailure(`断言失败：items 缺少列 ${missing.join('、')}`);
  }
  console.log(`  [ ok ] 期望列齐全（${EXPECTED_ITEM_COLUMNS.length} 列）`);

  expect(scenario.expected.rowLabel, state.itemRows, scenario.expected.itemRows);
}

/**
 * `resetDatabase` 的**顺序**断言：骨架必须先于数据。
 *
 * migrations.ts 里写明「以后每新增一个 `SCHEMA_Vx`，`resetDatabase` 都要同步追加一行」，
 * 且绝不能 DROP 完直接写 `user_version` —— 那会造出「版本号是新的、结构还是旧的」库，
 * 而缺掉的片段因为版本号已到位**永远不会再执行**，缺的列永久补不回来。
 *
 * 为什么必须单独断言顺序：顺序错有两种后果，其中一种**完全静默**。
 * - 把「播种」放到 V2 之前 → SQLite 当场报 `no column named note`（好抓）；
 * - 把 `user_version` 提到骨架之前 → 没有任何报错，下次启动因为「版本已到位」
 *   直接跳过所有片段，缺的列再也补不上（只能靠 `verifySchemaShape` 兜底）。
 * 只看「最终列数 / 行数」这两种情况刚好都发现不了，所以必须看轨迹顺序。
 */
const RESET_STEPS = [
  {
    label: 'SCHEMA_V1',
    match: (entry) => entry.sql.includes('CREATE TABLE IF NOT EXISTS items'),
  },
  {
    label: 'SCHEMA_V2',
    match: (entry) => entry.sql.includes('ADD COLUMN note'),
  },
  {
    label: '播种',
    match: (entry) => entry.op === 'runAsync' && entry.sql.includes('INSERT INTO items'),
  },
  {
    label: `user_version = ${DATABASE_VERSION}`,
    match: (entry) => entry.sql.includes(`PRAGMA user_version = ${DATABASE_VERSION}`),
  },
];

function assertResetOrder(trace) {
  const found = RESET_STEPS.map((step) => {
    const at = trace.findIndex(step.match);
    if (at === -1) {
      throw new SmokeFailure(
        `断言失败：清空重建的轨迹里找不到「${step.label}」这一步。\n` +
          '  说明 resetDatabase 漏跑了某个片段（新增 SCHEMA_Vx 后必须在这里同步追加）。',
      );
    }
    return { label: step.label, at };
  });

  const chain = found.map((step) => `${step.label}(#${trace[step.at].index})`).join(' → ');
  const isOrdered = found.every((step, i) => i === 0 || found[i - 1].at < step.at);
  if (!isOrdered) {
    throw new SmokeFailure(
      '断言失败：清空重建的步骤顺序不对，必须「骨架全部就绪之后才写数据」。\n' +
        `  实际顺序：${chain}`,
    );
  }

  console.log(`  [ ok ] 顺序：${chain}`);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const MARK = { ok: '[ ok ]', fail: '[FAIL]' };

function oneLine(sql, limit = 96) {
  const text = sql.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function indent(text, spaces = 4) {
  const pad = ' '.repeat(spaces);
  return String(text)
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/** 一行一条语句的概览，成功时也能看到执行序列 */
function printCompactTrace(trace) {
  console.log('  SQL 轨迹：');
  for (const entry of trace) {
    const mark = entry.error ? MARK.fail : MARK.ok;
    console.log(
      `    ${mark} #${String(entry.index).padStart(3)} ${entry.op.padEnd(12)} ${oneLine(entry.sql)}`,
    );
  }
}

function printFullTrace(trace) {
  console.log('  ---- 本次场景执行的全部 SQL（原文）----');
  for (const entry of trace) {
    console.log(`  [#${entry.index}] ${entry.op}`);
    console.log(indent(entry.sql));
  }
  console.log('  ---- SQL 原文结束 ----');
}

function printFailure(scenario, ctx, error) {
  console.log('');
  printCompactTrace(ctx.trace);
  console.log('');
  console.log('  结果：失败');
  console.log('='.repeat(76));

  const failedEntry = [...ctx.trace].reverse().find((entry) => entry.error);

  if (failedEntry) {
    console.log('  [SQL 执行失败]');
    console.log(`    第 ${failedEntry.index} 条语句（${failedEntry.op}）`);
    console.log(`    错误信息：${failedEntry.error.message}`);
    console.log('    ---- 失败语句完整文本 ----');
    console.log(indent(failedEntry.sql));
    console.log('    -------------------------');
    console.log('');
  }

  if (error instanceof SmokeFailure) {
    console.log('  [断言失败]');
    console.log(indent(error.message));
  } else if (!failedEntry) {
    console.log('  [异常]');
    console.log(indent(error.stack ?? String(error)));
  }

  if (!failedEntry && !(error instanceof SmokeFailure)) {
    // 断言失败 / 其他异常：没有「失败的那条 SQL」，就把全部 SQL 原文打出来
    console.log('');
    printFullTrace(ctx.trace);
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** 按 V1 的最小必填列插一条物品：故意不碰 note（布置「缺列的老库」） */
function insertRawItems(adapter, names) {
  for (const name of names) {
    adapter.arrange(`INSERT INTO items (name, created_at, updated_at) VALUES ('${name}', 0, 0)`);
  }
}

const SCENARIOS = [
  {
    name: '全新库',
    describe: '数据库文件不存在（首次安装），曾经必崩的那条路径',
    expected: {
      version: DATABASE_VERSION,
      itemColumns: EXPECTED_ITEM_COLUMNS.length,
      itemRows: EXPECTED_SEED_ITEM_COUNT,
      rowLabel: '种子物品行数',
    },
    async run(ctx) {
      await migrateDbIfNeeded(ctx.db);
      await verifySchemaShape(ctx.db);
    },
  },
  {
    name: '历史坏库',
    describe: 'user_version = 2 但结构停在 V1（版本号超前），且已有 2 条用户数据',
    expected: {
      version: DATABASE_VERSION,
      itemColumns: EXPECTED_ITEM_COLUMNS.length,
      itemRows: 2,
      rowLabel: '用户数据行数（补列不得丢数据、不得重复播种）',
    },
    async run(ctx) {
      // 布置：只有 V1 结构，版本号却已经是 2 —— 迁移主路径会直接跳过 V2 片段，
      // 只能靠「版本已到位」分支里的 verifySchemaShape 补列。
      ctx.db.arrange(SCHEMA_V1);
      insertRawItems(ctx.db, ['历史数据 A', '历史数据 B']);
      ctx.db.arrange(`PRAGMA user_version = ${DATABASE_VERSION}`);

      await migrateDbIfNeeded(ctx.db);
      await verifySchemaShape(ctx.db);
    },
  },
  {
    name: '半残库',
    describe: 'user_version = 1（V2 片段还没跑），且已有 1 条用户数据',
    expected: {
      version: DATABASE_VERSION,
      itemColumns: EXPECTED_ITEM_COLUMNS.length,
      itemRows: 1,
      rowLabel: '用户数据行数（升级不得丢数据、不得重复播种）',
    },
    async run(ctx) {
      ctx.db.arrange(SCHEMA_V1);
      insertRawItems(ctx.db, ['半残数据']);
      ctx.db.arrange('PRAGMA user_version = 1');

      await migrateDbIfNeeded(ctx.db);
      await verifySchemaShape(ctx.db);
    },
  },
  {
    name: '删库重建',
    describe: 'client.ts 的兜底路径：关连接 → 删库文件 → 重新打开 → 迁移（真机上曾「重建失败」）',
    expected: {
      version: DATABASE_VERSION,
      itemColumns: EXPECTED_ITEM_COLUMNS.length,
      itemRows: EXPECTED_SEED_ITEM_COUNT,
      rowLabel: '种子物品行数',
    },
    async run(ctx) {
      // 1) 先跑一次正常安装，得到「结构完整、有数据」的库
      await migrateDbIfNeeded(ctx.db);
      await verifySchemaShape(ctx.db);
      const before = readState(ctx.db);
      expect('重建前 user_version', before.version, DATABASE_VERSION);
      expect('重建前 items 行数', before.itemRows, EXPECTED_SEED_ITEM_COUNT);

      // 2) 删库重建
      ctx.resetStorage();

      // 3) 删库之后必须还能重新走通完整迁移
      await migrateDbIfNeeded(ctx.db);
      await verifySchemaShape(ctx.db);
    },
  },
  {
    name: '清空重建',
    describe: '设置页「清空数据」的 resetDatabase：删表 → V1 → V2 → 播种 → user_version',
    expected: {
      version: DATABASE_VERSION,
      itemColumns: EXPECTED_ITEM_COLUMNS.length,
      itemRows: EXPECTED_SEED_ITEM_COUNT,
      rowLabel: '种子物品行数（清空重建后必须重新播种）',
    },
    async run(ctx) {
      // 1) 先装出一个「结构完整、有数据」的库 —— 清空重建的真实前提，
      //    也顺带保证场景 5 不是在空库上测的
      await migrateDbIfNeeded(ctx.db);
      await verifySchemaShape(ctx.db);

      // 2) 只关心 resetDatabase 自己发出的语句，所以在这里切开轨迹
      const traceStart = ctx.trace.length;
      await resetDatabase(ctx.db);
      // 与 client.ts 的 resetDatabaseContents 保持同一形状：重建完立刻自检
      await verifySchemaShape(ctx.db);

      assertResetOrder(ctx.trace.slice(traceStart));
    },
  },
];

// ---------------------------------------------------------------------------
// 附加检查：诊断常量 SCHEMA_V1_ITEM_COLUMNS 是否与真实 DDL 同步
// ---------------------------------------------------------------------------

/**
 * `schema.ts` 里写明这个常量「不参与迁移，漏同步最坏只是诊断不准」。
 * 但诊断不准正是当初定位困难的原因之一，所以顺手守一下。
 */
function checkSchemaV1ColumnConstant(adapter) {
  adapter.arrange(SCHEMA_V1);
  const actual = adapter.probe('PRAGMA table_info(items)').map((row) => row.name);
  const declared = [...SCHEMA_V1_ITEM_COLUMNS];

  if (actual.length !== declared.length || actual.some((name, i) => name !== declared[i])) {
    const missing = actual.filter((name) => !declared.includes(name));
    const extra = declared.filter((name) => !actual.includes(name));
    throw new SmokeFailure(
      '断言失败：SCHEMA_V1_ITEM_COLUMNS 与 SCHEMA_V1 的 CREATE TABLE items 不一致。\n' +
        `  真实 DDL（${actual.length} 列）：${actual.join(', ')}\n` +
        `  常量声明（${declared.length} 列）：${declared.join(', ')}\n` +
        `  DDL 有而常量没有：${missing.length ? missing.join('、') : '（无）'}\n` +
        `  常量有而 DDL 没有：${extra.length ? extra.join('、') : '（无）'}`,
    );
  }
  console.log(`  [ ok ] SCHEMA_V1_ITEM_COLUMNS 与真实 DDL 同步（${actual.length} 列）`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(path.join(tmpdir(), 'restock-smoke-'));
const TOTAL_CHECKS = SCENARIOS.length + 1;
let failures = 0;

console.log('='.repeat(76));
console.log('数据库迁移冒烟测试（scripts/db-migrate-smoke.mjs）');
console.log('='.repeat(76));
console.log(`  Node              : ${process.version}`);
console.log(`  项目根目录        : ${PROJECT_ROOT}`);
console.log(`  DATABASE_VERSION  : ${DATABASE_VERSION}`);
console.log(
  `  期望 items 列数   : ${EXPECTED_ITEM_COLUMNS.length}` +
    `（V1 ${SCHEMA_V1_ITEM_COLUMNS.length} + V2 ${SCHEMA_V2_ITEM_COLUMNS.length}）`,
);
console.log(`  期望种子物品行数  : ${EXPECTED_SEED_ITEM_COUNT}`);
console.log(`  临时数据库目录    : ${tempDir}`);

for (const [index, scenario] of SCENARIOS.entries()) {
  console.log('');
  console.log('-'.repeat(76));
  console.log(`场景 ${index + 1}/${SCENARIOS.length}：${scenario.name}`);
  console.log(`  ${scenario.describe}`);
  console.log('-'.repeat(76));

  const ctx = new ScenarioContext(path.join(tempDir, `scenario-${index + 1}.db`));

  try {
    ctx.open();
    await scenario.run(ctx);
    const state = readState(ctx.db);

    printCompactTrace(ctx.trace);
    if (process.env.SMOKE_TRACE === 'full') {
      console.log('');
      printFullTrace(ctx.trace);
    }

    console.log('');
    assertScenario(scenario, state);
    console.log('  结果：通过');
  } catch (error) {
    failures += 1;
    printFailure(scenario, ctx, error);
  } finally {
    ctx.close();
  }
}

// 附加检查
console.log('');
console.log('-'.repeat(76));
console.log('附加检查：SCHEMA_V1_ITEM_COLUMNS 常量与真实 DDL 是否同步');
console.log('-'.repeat(76));
{
  const ctx = new ScenarioContext(path.join(tempDir, 'schema-constant-check.db'));
  try {
    ctx.open();
    checkSchemaV1ColumnConstant(ctx.db);
    console.log('  结果：通过');
  } catch (error) {
    failures += 1;
    printFailure({ name: '附加检查' }, ctx, error);
  } finally {
    ctx.close();
  }
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

console.log('');
console.log('='.repeat(76));
if (failures === 0) {
  console.log(`全部通过：${TOTAL_CHECKS}/${TOTAL_CHECKS}`);
} else {
  console.log(`失败 ${failures} 项，共 ${TOTAL_CHECKS} 项`);
}
console.log('='.repeat(76));

try {
  rmSync(tempDir, { recursive: true, force: true });
} catch {
  console.log(`（临时目录未能删除，可手动清理：${tempDir}）`);
}

process.exitCode = failures === 0 ? 0 : 1;
