import type { SQLiteDatabase } from 'expo-sqlite';
import { INIT_PRAGMAS, SCHEMA_V1, SCHEMA_V2, SCHEMA_V2_ITEM_COLUMNS } from '@/db/schema';
import { seedInitialData } from '@/db/seed';

/**
 * 数据库迁移。
 *
 * 版本号存在 `PRAGMA user_version`（SQLite 自带头部字段，不需要额外建表）。
 *
 * 规则：
 * - **已发布的迁移片段永远不要改**，只追加。改了会让老用户的库升不到新结构。
 * - 每次升级都是「在同一个事务里跑 DDL + 更新版本号」，失败自动回滚，
 *   不会留下「表建了一半、版本号却没变」的半残状态。
 * - `PRAGMA journal_mode` / `foreign_keys` **不能在事务内生效**，
 *   必须在事务外先执行（见 INIT_PRAGMAS 的说明）。
 * - **加列一律走幂等写法**（先查 `PRAGMA table_info` 再 ALTER，见
 *   `ensureV2ItemColumns`）：`user_version` 只能证明「迁移曾经跑过」，
 *   不能证明「结构真的对」。已出现过手机报
 *   `table items has no column named note` 的坏库。
 * - **骨架先于数据**：必须等**所有** `SCHEMA_Vx` 跑完，才能写种子 / 回填数据。
 *   仓库层的 INSERT 引用的是最新列（如 `note`），提前写会在 prepare 阶段失败
 *   并回滚整个迁移事务，连建好的表一起回滚掉。
 */

/** 当前代码期望的数据库版本 */
export const DATABASE_VERSION = 2;

async function readUserVersion(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * 读 `items` 表的列名集合。
 * 返回 `null` 表示 `items` 表**还不存在**（全新库，V1 尚未执行）——
 * 这与「表在但缺列」是两种完全不同的情况，必须区分开。
 */
async function readItemColumnNames(db: SQLiteDatabase): Promise<Set<string> | null> {
  const rows = await db.getAllAsync<{ name: string }>('PRAGMA table_info(items)');
  if (rows.length === 0) return null;
  return new Set(rows.map((row) => row.name));
}

/**
 * 幂等补齐 V2 引入的 `items` 列：**先查 `PRAGMA table_info`，不存在才 ALTER**。
 *
 * 为什么不能直接 `execAsync(SCHEMA_V2)`：
 * 1. SQLite 对已存在的列会报 `duplicate column name`，整个迁移事务回滚，
 *    库永远升不上去；
 * 2. 更关键的是**「版本号超前于结构」的坏库** —— 手机上出现过
 *    `user_version = 2` 但 `items` 里没有 `note` 列的库（历史版本的
 *    `resetDatabase` 只跑了 V1 却把版本号写成了 2）。这种库因为
 *    「版本已到位」永远不会再执行 V2 片段，缺失的列就永久补不回来，
 *    表现为 `prepareAsync` 失败：`table items has no column named note`。
 *
 * 先查后改，无论 `user_version` 是多少、无论片段是否跑过一半，结构都能修对。
 *
 * @returns 本次真正补上的列名；列已齐全时返回空数组。
 */
export async function ensureV2ItemColumns(db: SQLiteDatabase): Promise<string[]> {
  const existing = await readItemColumnNames(db);
  // items 表还不存在：这里不能 ALTER，交给 SCHEMA_V1 建表时带上
  if (!existing) return [];

  const added: string[] = [];
  for (const column of SCHEMA_V2_ITEM_COLUMNS) {
    if (existing.has(column.name)) continue;
    await db.execAsync(column.ddl);
    existing.add(column.name);
    added.push(column.name);
  }
  return added;
}

/**
 * 结构自检：核对关键列，缺失就地补齐并 `console.warn` 留痕。
 *
 * 调用点有两个：
 * 1. `migrateDbIfNeeded()` 的「版本已到位」分支 —— 这是**真正会命中**坏库的地方；
 * 2. `client.ts` 的 `openAndMigrate()` —— 紧跟在迁移之后、返回连接之前，
 *    保证仓库层的任何查询都发生在「结构已就绪」之后。
 *
 * 重复调用是完全幂等的，代价只有一条几乎为 0 的 `PRAGMA` 查询。
 * 它是**兜底保险**而不是迁移主路径：主路径负责把 `user_version` 推到最新，
 * 这里负责兜住所有「迁移被跳过」的边界情况（坏库、旧版本 App 装的库、
 * 未来某个片段写漏了等等）。
 */
export async function verifySchemaShape(db: SQLiteDatabase): Promise<void> {
  const repaired = await ensureV2ItemColumns(db);
  if (repaired.length === 0) return;

  // 走到这里说明迁移链有漏洞（版本号与实际结构不一致），必须留下痕迹
  console.warn(
    `[db] 结构自检修复：items 表缺少 ${repaired.join('、')}，已自动补齐。` +
      '说明 user_version 曾超前于实际结构（历史 resetDatabase 遗留的坏库），' +
      '请核对 DATABASE_VERSION 与 SCHEMA_Vx 片段是否同步。',
  );
}

/**
 * 幂等：版本已到位就直接返回。
 * 必须在**每次打开连接**后调用一次（client.ts 已封装）。
 */
export async function migrateDbIfNeeded(db: SQLiteDatabase): Promise<void> {
  // 1) 连接级 PRAGMA，必须在事务外执行
  for (const pragma of INIT_PRAGMAS) {
    await db.execAsync(pragma);
  }

  const currentVersion = await readUserVersion(db);

  if (currentVersion >= DATABASE_VERSION) {
    // 包含「库版本比代码还新」（用户装了旧版本 App）的情况：
    // 此时不做任何破坏性操作，让上层按只读方式兜底。
    //
    // 但**版本号到位 ≠ 结构到位**，所以这里不能直接 return：
    // 跑一次自检，把 `user_version = 2` 却没有 `note` 列的历史坏库修好。
    // 这里用 verifySchemaShape 而不是 ensureV2ItemColumns，是为了让
    // 「修复发生了」这件事被 console.warn 记录下来（否则它会被静默修好）。
    await verifySchemaShape(db);
    return;
  }

  // 2) 逐级升级，全程一个事务
  await db.withTransactionAsync(async () => {
    let version = currentVersion;
    /** 库是空的（V1 骨架由本次迁移建出来）—— 决定要不要写种子数据 */
    let createdSchemaFromScratch = false;

    if (version < 1) {
      await db.execAsync(SCHEMA_V1);
      version = 1;
      createdSchemaFromScratch = true;
    }

    if (version < 2) {
      // 纯加列，没有数据搬迁，所以不需要单独的 migrateToV2()。
      // 用幂等写法而不是 execAsync(SCHEMA_V2)：列已存在就跳过，
      // 不会因为「跑了一半的库」报 duplicate column 而整体回滚。
      await ensureV2ItemColumns(db);
      version = 2;
    }

    // 后续版本在这里追加：
    // if (version < 3) { await db.execAsync(SCHEMA_V3); await migrateToV3(db); version = 3; }

    // 3) 种子数据必须放在**所有**骨架片段跑完之后，不能塞进 `version < 1` 分支里。
    //
    // 原因：`seedInitialData` 走的是仓库层的 `createItemCore`，它的 INSERT
    // 显式列出了 `note, estimated_cycle_days`（V2 才有的列）。
    // 如果播种紧跟在 SCHEMA_V1 之后执行，SQLite 会在 prepare 阶段直接拒绝：
    //     table items has no column named note
    // 整个迁移事务随之回滚 —— 表被一起回滚掉，`user_version` 停在 0，
    // 于是每次启动都「建表 → 播种失败 → 回滚」，库永远是空的。
    // （真机现象即：报错说 items 没有 note 列，但诊断又显示 items 表不存在，
    //  两者其实是同一件事的两个阶段 —— 表被回滚了。）
    //
    // 与 `resetDatabase` 遵循同一条规则：**骨架全部就绪之后才允许写数据。**
    // 👉 以后新增 `SCHEMA_Vx` 时，只要它给 `items` 加列，就要把它排在播种之前。
    if (createdSchemaFromScratch) {
      await seedInitialData(db);
    }

    await db.execAsync(`PRAGMA user_version = ${version}`);
  });
}

/**
 * 把库清空重建（设置页「清空数据」用）。
 * 不使用 DROP DATABASE，而是走「删表 → 重建 → 重新播种」，
 * 这样比删除数据库文件更可控（WAL 文件也会一起收拾干净）。
 *
 * ## 骨架与版本号必须严格同序
 * DROP 之后**必须依次执行 `SCHEMA_V1`、`SCHEMA_V2`、…… 最后才写 `user_version`**。
 * 绝不能 DROP 完直接 `PRAGMA user_version = DATABASE_VERSION`：
 * 那样会造出「版本号是新的、结构还是旧的」的库，而缺掉的片段因为版本号
 * 已经到位**永远不会再执行**，缺的列就永久补不回来 —— 手机上报的
 * `table items has no column named note` 正是这种库。
 * （`verifySchemaShape` 现在能兜住这类坏库，但那是保险，不该靠它。）
 *
 * 👉 **以后每新增一个 `SCHEMA_Vx`，这里都要同步追加一行 `execAsync`。**
 */
export async function resetDatabase(db: SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      DROP VIEW  IF EXISTS v_item_stock;
      DROP TABLE IF EXISTS shopping_list_items;
      DROP TABLE IF EXISTS notification_history;
      DROP TABLE IF EXISTS notification_jobs;
      DROP TABLE IF EXISTS app_settings;
      DROP TABLE IF EXISTS stock_movements;
      DROP TABLE IF EXISTS items;
    `);
    // 全量 Schema 骨架，必须覆盖到最新版本（见上方说明）
    await db.execAsync(SCHEMA_V1);
    await db.execAsync(SCHEMA_V2);
    await seedInitialData(db);
    // 只有骨架全部就绪后，才允许把版本号写成最新
    await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
  });
}
