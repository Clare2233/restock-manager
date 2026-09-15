import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  BackupHistoryEntry,
  BackupItem,
  BackupMovement,
  BackupShoppingItem,
} from '@/types/backup';
import { roundTo } from '@/utils/number';

/**
 * 备份专用的读写 SQL。
 *
 * ## 为什么单独一个 repo，而不是散在 `services/backup/`
 * 项目约定「SQL 只出现在 db 层」（见其余 repo 的文件头）。
 * 备份的写操作是**绕过业务规则的原样落库**（显式 id、不由业务 hover 生成、
 * 不逐条走 `createItem`+流水），让它在服务层拼 SQL 会让这条约定破窗。
 * 所以这里只放 SQL，`services/backup/restore.ts` 负责编排顺序。
 *
 * ## 为什么不用 `resetDatabase()` 来「清空」
 * `migrations.resetDatabase` 会 DROP 全部表**并重新播种子数据**（见它的注释），
 * 那是给「重置到出厂」用的。备份导入要的是「清空但不播种」：
 * 否则装完自己的数据，还会多出一套示例物品。
 *
 * ## 全部函数都以 Core 结尾
 * 与其余 repo 的约定一致：**不开事务，只做原子写**。
 * 调用方（`services/backup/restore.ts`）持有唯一的事务，
 * 嵌套会让 SQLite 抛 "cannot start a transaction within a transaction"。
 */

/**
 * 依赖 `items` 的子表。
 * 导入 / 清空时按这个顺序删，即使 `PRAGMA foreign_keys = ON` 也不会踩外键。
 * （理论上 items 是最后删的，CASCADE 会把剩下的都带走；显式逐表删是为了
 * 让「删了哪些」在 trace 里一目了然，将来加表时也不靠猜。）
 */
const CHILD_TABLES_IN_DELETE_ORDER = [
  'stock_movements',
  'shopping_list_items',
  'notification_history',
  'notification_jobs',
] as const;

/**
 * 清空全部业务数据（含设置），**但不播种、不删表结构**。
 *
 * 刻意把整张 `app_settings` 表（而不只是 `app_settings` 这一个 key）删干净：
 * 表里还有一行 `notification_plan` —— 上次重排的计划签名。
 * 留着它，导入后的首次重排会因为「签名相同」被短路掉，用户就永远收不到通知。
 */
export async function clearAllBusinessTablesCore(db: SQLiteDatabase): Promise<void> {
  for (const table of CHILD_TABLES_IN_DELETE_ORDER) {
    await db.runAsync(`DELETE FROM ${table}`);
  }
  await db.runAsync('DELETE FROM app_settings');
  await db.runAsync('DELETE FROM items');
}

/**
 * 原样插入一条物品（**显式 id**，`stock` 落 0）。
 *
 * 为什么不用 `items.repo.createItemCore`：它会自动分配自增 id，
 * 而备份里的 movements / 清单 / 历史都用 `itemId` 指着这里 ——
 * id 一变，外键就全乱了。
 *
 * `stock` 为什么写死 0：库存必须在插入流水之后由 `recomputeAllStocksCore`
 * 统一定能对得上账。见 `types/backup.ts` 的说明。
 */
export async function insertBackupItemCore(
  db: SQLiteDatabase,
  item: BackupItem,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO items
       (id, name, category, unit, pack_size, pack_unit, icon, color, stock,
        safety_stock, quick_consume_qty, remind_days, lead_days, avg_window_days,
        note, estimated_cycle_days, notify_enabled, notify_time, last_price,
        tracking_started_at, is_archived, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.name,
      item.category,
      item.unit,
      roundTo(item.packSize),
      item.packUnit,
      item.icon,
      item.color,
      roundTo(item.safetyStock),
      roundTo(item.quickConsumeQty),
      item.remindDays,
      item.leadDays,
      item.avgWindowDays,
      item.note,
      item.estimatedCycleDays,
      item.notifyEnabled ? 1 : 0,
      item.notifyTime,
      item.lastPrice === null ? null : roundTo(item.lastPrice),
      item.trackingStartedAt,
      item.isArchived ? 1 : 0,
      item.sortOrder,
      item.createdAt,
      item.updatedAt,
    ],
  );
}

/** 原样插入一条流水（显式 id）。符号合法性由调用方（validate）保证 */
export async function insertBackupMovementCore(
  db: SQLiteDatabase,
  movement: BackupMovement,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO stock_movements
       (id, item_id, type, quantity, unit_price, total_price, occurred_at, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movement.id,
      movement.itemId,
      movement.type,
      roundTo(movement.quantity),
      movement.unitPrice === null ? null : roundTo(movement.unitPrice),
      movement.totalPrice === null ? null : roundTo(movement.totalPrice),
      movement.occurredAt,
      movement.source,
      movement.note,
      movement.createdAt,
    ],
  );
}

/**
 * 原样插入一条购物清单条目（显式 id）。
 *
 * 手写条目和自动条目的**抑制记录**都在同一张表，所以这里是全量：
 * 少了任何一边，导入后的清单都会和导出时长得不一样。
 */
export async function insertBackupShoppingItemCore(
  db: SQLiteDatabase,
  entry: BackupShoppingItem,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO shopping_list_items
       (id, item_id, name, unit, quantity, unit_price, source, status,
        priority, note, sort_order, added_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.itemId,
      entry.name,
      entry.unit,
      roundTo(entry.quantity),
      entry.unitPrice === null ? null : roundTo(entry.unitPrice),
      entry.source,
      entry.status,
      entry.priority,
      entry.note,
      entry.sortOrder,
      entry.addedAt,
      entry.resolvedAt,
    ],
  );
}

/**
 * 原样插入一条通知历史（显式 id）。
 *
 * 用 `INSERT`（不是 `INSERT OR IGNORE`）：表的 `UNIQUE(item_id, kind, fired_at)`
 * 撞车意味着文件里有重复行，让它抛错回滚比默默丢掉「用户以为导进来了」的行更好。
 */
export async function insertBackupHistoryCore(
  db: SQLiteDatabase,
  entry: BackupHistoryEntry,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO notification_history
       (id, item_id, kind, fired_at, dismissed, snoozed_until)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.itemId,
      entry.kind,
      entry.firedAt,
      entry.dismissed ? 1 : 0,
      entry.snoozedUntil,
    ],
  );
}
