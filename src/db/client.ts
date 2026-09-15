import * as SQLite from 'expo-sqlite';
import { BUILD_ID, DATABASE_NAME } from '@/constants/defaults';
import { migrateDbIfNeeded, resetDatabase, verifySchemaShape } from '@/db/migrations';
import { SCHEMA_V1_ITEM_COLUMNS, SCHEMA_V2_ITEM_COLUMNS } from '@/db/schema';

/**
 * 数据库连接的单例入口。
 *
 * ## 为什么不用 `SQLiteProvider` / `useSQLiteContext`
 * 仓库层（`db/repositories/*`）会被 **React 树之外**的代码调用：通知点击处理、
 * 备份导入导出、前台重排调度。那些地方拿不到 `useSQLiteContext()`。
 * 如果 React 侧用 `SQLiteProvider`、非 React 侧再 `openDatabaseAsync` 一次，
 * 同一个库文件会同时存在两条连接，在 WAL 下互相争锁、还会各自持有事务状态。
 *
 * 所以统一走这里：**一个进程一条连接**。
 * - React 侧：在启动引导里 `await getReadyDatabase()`，或用 `useDatabase()`（后续实现）；
 * - 非 React 侧：直接 `await getReadyDatabase()`。
 *
 * ## 迁移时机
 * 打开连接后**立即**跑 `migrateDbIfNeeded`，并且整个「打开 + 迁移」过程
 * 只用一次 Promise 缓存，保证并发调用不会重复迁移、也不会拿到半初始化的库。
 *
 * 迁移之后还会跑一次**结构自检**（`verifySchemaShape`）：核对 `items` 的关键列，
 * 缺失就地补齐。它兜住「版本号已到位、但结构没跟上」的历史坏库，所以
 * **返回给上层的连接一定是「列齐全」的**，仓库层的查询不会踩到缺列的库。
 * 引导页因此可以简单地 `await getReadyDatabase()` 就认为库已就绪。
 *
 * ## 失败时的诊断与开发期兜底
 * 真机上出现过「JS 包没更新」和「库太坏、补列逻辑跑不起来」两种情况
 * 报错长得一模一样的问题。所以引导失败时：
 * 1. 另开一条连接采集现场（`user_version`、`table_info(items)` 全量列名），
 *    每一步单独 try/catch，**保证诊断本身不会再抛错**；
 * 2. `console.warn` 打完整诊断 + 原始错误；
 * 3. **仅 `__DEV__`**：若诊断到缺列，删库重建（拿数据换可用性，开发期可接受）。
 *    生产环境绝不静默删用户数据，直接把现场抛给错误页；
 * 4. 仍失败则抛 `DatabaseStartupError`（携带 `diagnostics`），由 `_layout.tsx`
 *    的错误页把 BUILD_ID / user_version / 列名列表渲染出来。
 *
 * 另外 `assertSchemaReady` 会用**即将交给上层的这条连接**再复核一次结构：
 * 它把「自检没修好却放行」这条路彻底堵死，让问题一定以错误页的形式暴露，
 * 而不是变成后面某次查询的红屏（那才最难判断是包旧还是库坏）。
 */

let readyPromise: Promise<SQLite.SQLiteDatabase> | null = null;

// ---------------------------------------------------------------------------
// 启动诊断
// ---------------------------------------------------------------------------

/** 启动现场信息；由 `_layout.tsx` 的错误页渲染 */
export interface DbDiagnostics {
  /** 手机上实际在跑的 JS 构建标识 —— 用来排除「包没更新」 */
  buildId: string;
  databaseName: string;
  /** `PRAGMA user_version`；`null` = 读取失败 */
  userVersion: number | null;
  /** `PRAGMA table_info(items)` 的列名；`[]` = items 表不存在 */
  itemColumns: string[] | null;
  /** items 缺失的列（V1 ∪ V2 全量口径）；空数组 = 结构健康 */
  missingColumns: string[];
  /** 触发诊断的原始错误 */
  originalError: string;
  /** 诊断与兜底过程中的每一步，按发生顺序 */
  steps: string[];
  /** 是否真的执行了「删库重建」 */
  rebuilt: boolean;
}

/** 启动失败并附带完整现场；错误页据此渲染诊断块 */
export class DatabaseStartupError extends Error {
  readonly diagnostics: DbDiagnostics;

  constructor(message: string, diagnostics: DbDiagnostics) {
    super(message);
    this.name = 'DatabaseStartupError';
    this.diagnostics = diagnostics;
  }
}

/** items 表「结构健康」所需的全部列 */
function requiredItemColumns(): string[] {
  return [...SCHEMA_V1_ITEM_COLUMNS, ...SCHEMA_V2_ITEM_COLUMNS.map((column) => column.name)];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

async function readUserVersionOf(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

async function readItemColumnsOf(db: SQLite.SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>('PRAGMA table_info(items)');
  return rows.map((row) => row.name);
}

/**
 * 用**即将交给上层的这条连接**复核结构；缺列就抛错。
 * 见文件头说明：这条断言让「结构没修好却被放行」不可能发生。
 */
async function assertSchemaReady(db: SQLite.SQLiteDatabase): Promise<void> {
  const present = new Set(await readItemColumnsOf(db));
  const missing = requiredItemColumns().filter((column) => !present.has(column));
  if (missing.length === 0) return;

  throw new Error(
    `结构复核不通过：items 缺少列 [${missing.join(', ')}]；` +
      `当前实际列 [${[...present].join(', ')}]`,
  );
}

/**
 * 采集现场信息。
 *
 * **刻意另开一条连接**：出问题时原连接可能正好卡在坏事务里，复用它会把
 * 诊断本身也搞崩。每一步单独 try/catch，保证诊断永远能返回结果
 * （读不出来也只是对应字段为 null），不会用一个新错误掩盖原错误。
 */
async function collectDiagnostics(originalError: string, steps: string[]): Promise<DbDiagnostics> {
  const diagnostics: DbDiagnostics = {
    buildId: BUILD_ID,
    databaseName: DATABASE_NAME,
    userVersion: null,
    itemColumns: null,
    missingColumns: [],
    originalError,
    steps,
    rebuilt: false,
  };

  const probe = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    try {
      diagnostics.userVersion = await readUserVersionOf(probe);
      steps.push(`读取 user_version = ${diagnostics.userVersion}`);
    } catch (error) {
      steps.push(`读取 user_version 失败：${toErrorMessage(error)}`);
    }

    try {
      const columns = await readItemColumnsOf(probe);
      diagnostics.itemColumns = columns;
      steps.push(`读取 table_info(items) = [${columns.join(', ')}]`);
      diagnostics.missingColumns = requiredItemColumns().filter(
        (column) => !columns.includes(column),
      );
    } catch (error) {
      steps.push(`读取 table_info(items) 失败：${toErrorMessage(error)}`);
    }
  } finally {
    // 必须关掉探针连接：否则后面的 deleteDatabaseAsync 会因文件被占用而失败
    await probe.closeAsync().catch(() => undefined);
  }

  return diagnostics;
}

/** 把诊断打到 console —— 手机不接调试器也能在 Metro 终端看到 */
function logDiagnostics(diagnostics: DbDiagnostics): void {
  const columns = diagnostics.itemColumns;
  console.warn(
    [
      `[db] 启动诊断 BUILD_ID=${diagnostics.buildId} 库=${diagnostics.databaseName}`,
      `  原始错误：${diagnostics.originalError}`,
      `  user_version：${diagnostics.userVersion ?? '读取失败'}`,
      `  items 列(${columns?.length ?? 0})：${columns ? `[${columns.join(', ')}]` : '读取失败'}`,
      `  缺失列：${
        diagnostics.missingColumns.length > 0 ? diagnostics.missingColumns.join(', ') : '无'
      }`,
      `  已执行删库重建：${diagnostics.rebuilt ? '是' : '否'}`,
      '  步骤：',
      ...diagnostics.steps.map((step) => `    - ${step}`),
    ].join('\n'),
  );
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const steps: string[] = [];
  let db: SQLite.SQLiteDatabase | null = null;

  try {
    db = await SQLite.openDatabaseAsync(DATABASE_NAME);
    steps.push('openDatabaseAsync 成功');
    await migrateDbIfNeeded(db);
    steps.push('migrateDbIfNeeded 成功');
    // 保险：无论 user_version 是什么值，都保证关键列存在（见 migrations.ts）
    await verifySchemaShape(db);
    steps.push('verifySchemaShape 成功');
    await assertSchemaReady(db);
    steps.push('结构复核通过：items 列齐全');
    return db;
  } catch (error) {
    steps.push(`失败：${toErrorMessage(error)}`);
    // 先关掉自己开的这条连接：不关的话 deleteDatabaseAsync 会因文件被占用 /
    // WAL 锁未释放而失败，兜底就形同虚设。
    await db?.closeAsync().catch(() => undefined);
    db = null;

    console.warn('[db] 启动引导失败，开始采集诊断信息…', error);
    const diagnostics = await collectDiagnostics(toErrorMessage(error), steps);
    logDiagnostics(diagnostics);

    // 生产环境绝不静默删用户数据：把现场抛给错误页就够了
    if (!__DEV__) {
      throw new DatabaseStartupError(toErrorMessage(error), diagnostics);
    }

    if (diagnostics.missingColumns.length === 0) {
      // 结构是齐的 → 缺列不是根因，重建也没用，别白扔数据
      throw new DatabaseStartupError(
        `${toErrorMessage(error)}（诊断：items 列齐全，重建无意义，未执行兜底）`,
        diagnostics,
      );
    }

    // ---- 开发期兜底：删库重建 ----
    diagnostics.rebuilt = true;
    diagnostics.steps.push(`诊断到缺列，执行删库重建：${diagnostics.missingColumns.join(', ')}`);
    try {
      await SQLite.deleteDatabaseAsync(DATABASE_NAME);
      diagnostics.steps.push('deleteDatabaseAsync 成功');

      const rebuilt = await SQLite.openDatabaseAsync(DATABASE_NAME);
      diagnostics.steps.push('重新 openDatabaseAsync 成功');
      await migrateDbIfNeeded(rebuilt);
      diagnostics.steps.push('重建后 migrateDbIfNeeded 成功');
      await verifySchemaShape(rebuilt);
      await assertSchemaReady(rebuilt);
      diagnostics.steps.push('重建后结构复核通过：items 列齐全');

      logDiagnostics(diagnostics);
      console.warn(
        `[db] 已删库重建（BUILD_ID=${BUILD_ID}）：原有本地数据已丢失，` +
          `缺失列 [${diagnostics.missingColumns.join(', ')}]。请把错误页截图一起反馈。`,
      );
      return rebuilt;
    } catch (rebuildError) {
      diagnostics.steps.push(`重建失败：${toErrorMessage(rebuildError)}`);
      logDiagnostics(diagnostics);
      throw new DatabaseStartupError(
        `删库重建后仍然失败：${toErrorMessage(rebuildError)}`,
        diagnostics,
      );
    }
  }
}

/**
 * 取已就绪（连接已打开、迁移已完成）的数据库实例。
 * 失败时会清空缓存，允许下次调用重试（例如磁盘临时不可用）。
 */
export function getReadyDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!readyPromise) {
    readyPromise = openAndMigrate().catch((error: unknown) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

/**
 * 关闭连接。仅测试与「释放资源」场景需要；
 * 关闭后再次调用 `getReadyDatabase()` 会重新打开并重新跑一次（幂等的）迁移。
 */
export async function closeDatabase(): Promise<void> {
  if (!readyPromise) return;
  const pending = readyPromise;
  readyPromise = null;
  const db = await pending.catch(() => null);
  await db?.closeAsync();
}

/** 清空并重建数据（不删文件），返回一个可继续使用的连接 */
export async function resetDatabaseContents(): Promise<SQLite.SQLiteDatabase> {
  const db = await getReadyDatabase();
  await resetDatabase(db);
  return db;
}

/**
 * 彻底删除数据库文件（危险操作，仅调试用）。
 * 删除后单例缓存会被清空，下次调用 `getReadyDatabase()` 会得到全新的空库。
 */
export async function destroyDatabase(): Promise<void> {
  await closeDatabase();
  await SQLite.deleteDatabaseAsync(DATABASE_NAME);
}

/** 测试辅助：仅重置内存中的 Promise 缓存，不碰磁盘 */
export function __resetDatabaseCache(): void {
  readyPromise = null;
}
