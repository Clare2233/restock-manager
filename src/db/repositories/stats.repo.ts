import type { SQLiteDatabase } from 'expo-sqlite';
import { normalizeCategory } from '@/constants/categories';
import type {
  ConsumptionTotal,
  ItemCategory,
  MovementType,
  PurchaseRecord,
} from '@/types/models';
import { nowMs } from '@/utils/date';
import { roundTo } from '@/utils/number';

/**
 * 统计查询仓库。
 *
 * 这里只负责「按时间范围把原始数据捞出来」，聚合逻辑放在 `domain/spending.ts`
 * 的纯函数里 —— 那样聚合规则可以单测，也方便在导入后重算演示数据。
 */

/** 采购记录的 join 行 */
interface PurchaseRow {
  id: number;
  item_id: number;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  occurred_at: number;
}

interface ConsumptionTotalRow {
  item_id: number;
  name: string;
  unit: string;
  quantity: number;
  movement_count: number;
}

/** 区间内的采购记录（含物品信息），时间倒序 */
export async function listPurchasesInRange(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number = nowMs(),
): Promise<PurchaseRecord[]> {
  const rows = await db.getAllAsync<PurchaseRow>(
    `SELECT m.id, m.item_id, i.name, i.category, i.unit,
            m.quantity, m.unit_price, m.total_price, m.occurred_at
       FROM stock_movements m
       JOIN items i ON i.id = m.item_id
      WHERE m.type = 'purchase' AND m.occurred_at >= ? AND m.occurred_at <= ?
      ORDER BY m.occurred_at DESC, m.id DESC`,
    [fromMs, toMs],
  );

  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    itemName: row.name,
    category: normalizeCategory(row.category) as ItemCategory,
    unit: row.unit,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    occurredAt: row.occurred_at,
  }));
}

/**
 * 区间总支出。
 * 口径：优先用 `total_price`（实付），缺失时用 `unit_price × quantity` 兜底。
 */
export async function sumSpendInRange(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number = nowMs(),
): Promise<number> {
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(COALESCE(total_price, COALESCE(unit_price, 0) * quantity)) AS total
       FROM stock_movements
      WHERE type = 'purchase' AND occurred_at >= ? AND occurred_at <= ?`,
    [fromMs, toMs],
  );
  return roundTo(row?.total ?? 0);
}

/** 按物品聚合的消耗量排行（quantity 返回正数） */
export async function listConsumptionTotals(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number = nowMs(),
): Promise<ConsumptionTotal[]> {
  const rows = await db.getAllAsync<ConsumptionTotalRow>(
    `SELECT m.item_id, i.name, i.unit,
            SUM(-m.quantity) AS quantity,
            COUNT(*)         AS movement_count
       FROM stock_movements m
       JOIN items i ON i.id = m.item_id
      WHERE m.type = 'consume' AND m.occurred_at >= ? AND m.occurred_at <= ?
      GROUP BY m.item_id, i.name, i.unit
      ORDER BY quantity DESC`,
    [fromMs, toMs],
  );

  return rows.map((row) => ({
    itemId: row.item_id,
    name: row.name,
    unit: row.unit,
    quantity: roundTo(row.quantity),
    movementCount: row.movement_count,
  }));
}

/** 区间内某类流水条数（统计页展示「本月记录 N 次」） */
export async function countMovementsInRange(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number = nowMs(),
  type?: MovementType,
): Promise<number> {
  const row = type
    ? await db.getFirstAsync<{ total: number }>(
        `SELECT COUNT(*) AS total FROM stock_movements
          WHERE type = ? AND occurred_at >= ? AND occurred_at <= ?`,
        [type, fromMs, toMs],
      )
    : await db.getFirstAsync<{ total: number }>(
        `SELECT COUNT(*) AS total FROM stock_movements
          WHERE occurred_at >= ? AND occurred_at <= ?`,
        [fromMs, toMs],
      );
  return row?.total ?? 0;
}

/** 有采购记录的月份列表（统计页月份切换器用），倒序 */
export async function listPurchaseMonths(
  db: SQLiteDatabase,
  limit = 24,
): Promise<Array<{ monthKey: string; totalSpend: number }>> {
  const rows = await db.getAllAsync<{ month_key: string; total_spend: number }>(
    `SELECT strftime('%Y-%m', occurred_at / 1000, 'unixepoch', 'localtime') AS month_key,
            SUM(COALESCE(total_price, COALESCE(unit_price, 0) * quantity)) AS total_spend
       FROM stock_movements
      WHERE type = 'purchase'
      GROUP BY month_key
      ORDER BY month_key DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    monthKey: row.month_key,
    totalSpend: roundTo(row.total_spend ?? 0),
  }));
}
