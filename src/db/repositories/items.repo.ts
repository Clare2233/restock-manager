import type { SQLiteDatabase } from 'expo-sqlite';
import { mapItem } from '@/db/mappers';
import { insertMovementCore, recomputeStockCore } from '@/db/repositories/movements.repo';
import { DEFAULT_CATEGORY } from '@/constants/categories';
import {
  DEFAULT_LEAD_DAYS,
  DEFAULT_NOTIFY_TIME,
  DEFAULT_REMIND_DAYS,
  DEFAULT_WINDOW_DAYS,
} from '@/constants/defaults';
import type {
  CreateItemInput,
  Item,
  ItemRow,
  ItemSort,
  ListItemsOptions,
  UpdateItemInput,
} from '@/types/models';
import { nowMs } from '@/utils/date';
import { clampNumber, roundTo } from '@/utils/number';

/**
 * 物品仓库。
 *
 * 依赖方向：items.repo → movements.repo（单向）。
 * 建物品时的「期初库存」必须写成一条 `adjust` 流水，而不是直接塞 `stock`，
 * 否则流水与库存对不上账。
 */

const ITEM_COLUMNS = `id, name, category, unit, pack_size, pack_unit, icon, color,
  stock, safety_stock, quick_consume_qty, remind_days, lead_days, avg_window_days,
  note, estimated_cycle_days, notify_enabled, notify_time, last_price,
  tracking_started_at, is_archived, sort_order, created_at, updated_at`;

const ORDER_BY: Record<ItemSort, string> = {
  sortOrder: 'sort_order ASC, id ASC',
  // 中文按 UTF-8 码位排序（非拼音）。若要拼音序，需引入 collation，本期不做。
  name: 'name ASC, id ASC',
  stockAsc: 'stock ASC, sort_order ASC',
  stockDesc: 'stock DESC, sort_order ASC',
  updatedDesc: 'updated_at DESC, id DESC',
};

/** 更新入参字段 → 数据库列名 */
const COLUMN_BY_FIELD: Record<keyof UpdateItemInput, string> = {
  name: 'name',
  category: 'category',
  unit: 'unit',
  packSize: 'pack_size',
  packUnit: 'pack_unit',
  icon: 'icon',
  color: 'color',
  safetyStock: 'safety_stock',
  quickConsumeQty: 'quick_consume_qty',
  remindDays: 'remind_days',
  leadDays: 'lead_days',
  avgWindowDays: 'avg_window_days',
  note: 'note',
  estimatedCycleDays: 'estimated_cycle_days',
  notifyEnabled: 'notify_enabled',
  notifyTime: 'notify_time',
  lastPrice: 'last_price',
  sortOrder: 'sort_order',
  trackingStartedAt: 'tracking_started_at',
  isArchived: 'is_archived',
};

function toSqlValue(value: unknown): string | number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  return null;
}

/**
 * 备注收敛：只 trim，空串一律存成 NULL。
 * 避免 `''` 与 `NULL` 两种「空」让 UI 和查询走向两条分支。
 */
function normalizeNote(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

/**
 * 预计使用周期收敛：必须是**正整数天**，否则回落成 null。
 * 宁可当成「没填」，也不要存 0 / 负数 / 小数：
 * 预测层会拿它做除数，非法值要么算出 Infinity，要么得出荒谬的耗尽日。
 * 回收成 null 之后的语义是明确的——「不做冷启动估算」。
 */
function normalizeCycleDays(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const days = Math.trunc(Number(value));
  if (!Number.isFinite(days) || days < 1) return null;
  return days;
}

/** 新建入参收敛：把数值夹到合法区间，避免脏数据进库 */
function normalizeCreateInput(input: CreateItemInput): Required<
  Pick<
    CreateItemInput,
    | 'name'
    | 'category'
    | 'unit'
    | 'packSize'
    | 'packUnit'
    | 'safetyStock'
    | 'quickConsumeQty'
    | 'remindDays'
    | 'leadDays'
    | 'avgWindowDays'
    | 'note'
    | 'estimatedCycleDays'
    | 'notifyEnabled'
    | 'notifyTime'
  >
> {
  const name = input.name?.trim();
  if (!name) {
    throw new Error('物品名称不能为空');
  }
  const unit = input.unit?.trim();
  if (input.unit !== undefined && !unit) {
    throw new Error('计量单位不能为空字符串');
  }
  return {
    name,
    category: input.category ?? DEFAULT_CATEGORY,
    unit: unit || '个',
    packSize: Math.max(1, roundTo(input.packSize ?? 1)),
    packUnit: input.packUnit?.trim() || null,
    safetyStock: Math.max(0, roundTo(input.safetyStock ?? 0)),
    quickConsumeQty: Math.max(0, roundTo(input.quickConsumeQty ?? 1)),
    remindDays: Math.max(0, Math.trunc(input.remindDays ?? DEFAULT_REMIND_DAYS)),
    leadDays: Math.max(0, Math.trunc(input.leadDays ?? DEFAULT_LEAD_DAYS)),
    avgWindowDays: Math.max(1, Math.trunc(input.avgWindowDays ?? DEFAULT_WINDOW_DAYS)),
    note: normalizeNote(input.note),
    estimatedCycleDays: normalizeCycleDays(input.estimatedCycleDays),
    notifyEnabled: input.notifyEnabled ?? true,
    notifyTime: input.notifyTime?.trim() || DEFAULT_NOTIFY_TIME,
  };
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 查询物品列表（默认不含已归档） */
export async function listItems(
  db: SQLiteDatabase,
  options: ListItemsOptions = {},
): Promise<Item[]> {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (!options.includeArchived) {
    conditions.push('is_archived = 0');
  }
  if (options.categories && options.categories.length > 0) {
    conditions.push(`category IN (${options.categories.map(() => '?').join(', ')})`);
    params.push(...options.categories);
  }
  const search = options.search?.trim();
  if (search) {
    // LIKE 对 ASCII 天然大小写不敏感，中文按字面匹配
    conditions.push('name LIKE ?');
    params.push(`%${search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = ORDER_BY[options.sort ?? 'sortOrder'];

  const rows = await db.getAllAsync<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items ${where} ORDER BY ${orderBy}`,
    params,
  );
  return rows.map(mapItem);
}

export async function getItemById(db: SQLiteDatabase, id: number): Promise<Item | null> {
  const row = await db.getFirstAsync<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`,
    [id],
  );
  return row ? mapItem(row) : null;
}

export async function countItems(
  db: SQLiteDatabase,
  options: ListItemsOptions = {},
): Promise<number> {
  const includeArchived = options.includeArchived ?? false;
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM items ${includeArchived ? '' : 'WHERE is_archived = 0'}`,
  );
  return row?.total ?? 0;
}

/** 取下一个排序值（新建物品时放到末尾） */
export async function nextSortOrder(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ max_order: number | null }>(
    'SELECT MAX(sort_order) AS max_order FROM items',
  );
  return (row?.max_order ?? 0) + 10;
}

/** 所有物品的 `stock` 与流水求和不一致的条目（诊断用） */
export async function findStockMismatches(
  db: SQLiteDatabase,
): Promise<Array<{ itemId: number; cached: number; computed: number }>> {
  const rows = await db.getAllAsync<{ item_id: number; cached: number; computed: number }>(
    `SELECT v.item_id, i.stock AS cached, v.computed_stock AS computed
       FROM v_item_stock v JOIN items i ON i.id = v.item_id
      WHERE ABS(i.stock - v.computed_stock) > 0.0001`,
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    cached: row.cached,
    computed: row.computed,
  }));
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/**
 * 新建物品。**不开事务**：期初库存会以一条 `adjust` 流水写入并重算 `stock`。
 * 供种子数据、备份导入等已有事务的场景复用。
 */
export async function createItemCore(
  db: SQLiteDatabase,
  input: CreateItemInput,
): Promise<number> {
  const normalized = normalizeCreateInput(input);
  const now = nowMs();
  const initialStock = roundTo(input.initialStock ?? 0);

  const result = await db.runAsync(
    `INSERT INTO items
       (name, category, unit, pack_size, pack_unit, icon, color, stock, safety_stock,
        quick_consume_qty, remind_days, lead_days, avg_window_days, note,
        estimated_cycle_days, notify_enabled, notify_time, last_price,
        tracking_started_at, is_archived, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      normalized.name,
      normalized.category,
      normalized.unit,
      normalized.packSize,
      normalized.packUnit,
      input.icon ?? null,
      input.color ?? null,
      normalized.safetyStock,
      normalized.quickConsumeQty,
      normalized.remindDays,
      normalized.leadDays,
      normalized.avgWindowDays,
      normalized.note,
      normalized.estimatedCycleDays,
      normalized.notifyEnabled ? 1 : 0,
      normalized.notifyTime,
      input.lastPrice ?? null,
      // null = 交给预测层自动推断基准日（见 types/models.ts 的说明）
      input.trackingStartedAt ?? null,
      input.sortOrder ?? (await nextSortOrder(db)),
      now,
      now,
    ],
  );

  const itemId = result.lastInsertRowId;

  if (initialStock !== 0) {
    await insertMovementCore(db, {
      itemId,
      type: 'adjust',
      quantity: initialStock,
      source: 'manual',
      note: '期初库存',
      occurredAt: now,
    });
    await recomputeStockCore(db, itemId);
  }

  return itemId;
}

/** 新建物品（含事务），返回完整领域模型 */
export async function createItem(
  db: SQLiteDatabase,
  input: CreateItemInput,
): Promise<Item> {
  let itemId: number | null = null;
  await db.withTransactionAsync(async () => {
    itemId = await createItemCore(db, input);
  });
  if (itemId === null) {
    throw new Error('新建物品失败：事务未返回结果');
  }
  const created = await getItemById(db, itemId);
  if (!created) {
    throw new Error('新建物品失败：写入后无法读回');
  }
  return created;
}

/**
 * 更新物品资料。**不开事务**。
 * 注意：入参里没有 `stock`（见 types/models.ts 的说明），改库存请走 movements.repo。
 */
export async function updateItemCore(
  db: SQLiteDatabase,
  id: number,
  patch: UpdateItemInput,
): Promise<void> {
  const assignments: string[] = [];
  const params: Array<string | number | null> = [];

  for (const [field, value] of Object.entries(patch) as Array<
    [keyof UpdateItemInput, unknown]
  >) {
    if (value === undefined) continue;
    const column = COLUMN_BY_FIELD[field];
    if (!column) continue;

    let normalized = value;
    if (field === 'name') {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name) throw new Error('物品名称不能为空');
      normalized = name;
    } else if (field === 'unit') {
      const unit = typeof value === 'string' ? value.trim() : '';
      if (!unit) throw new Error('计量单位不能为空');
      normalized = unit;
    } else if (field === 'packSize') {
      normalized = Math.max(1, roundTo(Number(value)));
    } else if (field === 'safetyStock' || field === 'quickConsumeQty') {
      normalized = Math.max(0, roundTo(Number(value)));
    } else if (field === 'remindDays' || field === 'leadDays') {
      normalized = Math.max(0, Math.trunc(Number(value)));
    } else if (field === 'avgWindowDays') {
      normalized = Math.max(1, Math.trunc(Number(value)));
    } else if (field === 'packUnit') {
      normalized = typeof value === 'string' ? value.trim() || null : null;
    } else if (field === 'note') {
      // 显式传 null / '' 都表示「清空备注」
      normalized = normalizeNote(typeof value === 'string' ? value : null);
    } else if (field === 'estimatedCycleDays') {
      // 显式传 null 表示「不再做冷启动估算」；非法值同样收敛成 null
      normalized = normalizeCycleDays(typeof value === 'number' ? value : null);
    } else if (field === 'sortOrder') {
      normalized = Math.trunc(clampNumber(Number(value), -1_000_000, 1_000_000));
    }

    assignments.push(`${column} = ?`);
    params.push(toSqlValue(normalized));
  }

  if (assignments.length === 0) return;

  assignments.push('updated_at = ?');
  params.push(nowMs(), id);

  await db.runAsync(`UPDATE items SET ${assignments.join(', ')} WHERE id = ?`, params);
}

/** 更新物品资料（含事务），返回更新后的模型；物品不存在返回 null */
export async function updateItem(
  db: SQLiteDatabase,
  id: number,
  patch: UpdateItemInput,
): Promise<Item | null> {
  await db.withTransactionAsync(async () => {
    await updateItemCore(db, id, patch);
  });
  return getItemById(db, id);
}

/** 归档 / 恢复物品（含事务）。归档后不参与提醒与购物清单自动条目。 */
export async function setArchived(
  db: SQLiteDatabase,
  id: number,
  archived: boolean,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE items SET is_archived = ?, updated_at = ? WHERE id = ?', [
      archived ? 1 : 0,
      nowMs(),
      id,
    ]);
  });
}

/** 删除物品（含事务）。流水与通知记录靠外键 CASCADE 一起清掉。 */
export async function deleteItem(db: SQLiteDatabase, id: number): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM items WHERE id = ?', [id]);
  });
}
