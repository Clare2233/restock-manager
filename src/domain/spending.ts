import { getCategoryLabel, normalizeCategory } from '@/constants/categories';
import type { ConsumptionTotal, ItemCategory, MonthKey, PurchaseRecord } from '@/types/models';
import { monthRangeOf, monthRangeOfKey } from '@/utils/date';
import { roundTo, sumNumbers } from '@/utils/number';

/**
 * 支出与消耗统计 —— 纯函数。
 *
 * **口径：按购买日实付金额统计**（现金口径），不按消耗摊销。
 * 理由：「这个月花了多少钱」是用户真正关心的问题，摊销口径虽然有理论意义，
 * 但需要跨月追踪每笔采购的剩余量，与「库存按物品聚合」的模型冲突。
 * `total_price` 缺失时用 `unit_price × quantity` 兜底，都没有则记为 0
 * 并计进 `missingAmountCount`，让 UI 能提示「有 N 笔没记金额」。
 */

export interface CategorySpend {
  category: ItemCategory;
  label: string;
  amount: number;
  /** 占当月总支出比例（0~1）；总额为 0 时是 0 */
  ratio: number;
  purchaseCount: number;
}

export interface ItemSpend {
  itemId: number;
  name: string;
  unit: string;
  amount: number;
  quantity: number;
  purchaseCount: number;
}

export interface MonthlySpendSummary {
  monthKey: MonthKey;
  startMs: number;
  endMs: number;
  totalSpend: number;
  /** 该月采购笔数（含未记金额的） */
  purchaseCount: number;
  /** 未记金额的笔数 */
  missingAmountCount: number;
  byCategory: CategorySpend[];
  byItem: ItemSpend[];
}

/** 单笔采购的实际金额：实付优先，缺失时用单价 × 数量兜底 */
export function resolvePurchaseAmount(purchase: PurchaseRecord): number {
  if (purchase.totalPrice !== null && Number.isFinite(purchase.totalPrice)) {
    return Math.max(0, purchase.totalPrice);
  }
  if (purchase.unitPrice !== null && Number.isFinite(purchase.unitPrice)) {
    return Math.max(0, purchase.unitPrice * Math.abs(purchase.quantity));
  }
  return 0;
}

/** 合计支出 */
export function computeSpendTotal(purchases: readonly PurchaseRecord[]): number {
  return roundTo(sumNumbers(purchases.map(resolvePurchaseAmount)));
}

/** 分类占比（只返回有采购记录的分类，金额降序） */
export function computeCategoryBreakdown(
  purchases: readonly PurchaseRecord[],
): CategorySpend[] {
  const total = computeSpendTotal(purchases);
  const buckets = new Map<ItemCategory, { amount: number; purchaseCount: number }>();

  for (const purchase of purchases) {
    const category = normalizeCategory(purchase.category);
    const bucket = buckets.get(category) ?? { amount: 0, purchaseCount: 0 };
    bucket.amount += resolvePurchaseAmount(purchase);
    bucket.purchaseCount += 1;
    buckets.set(category, bucket);
  }

  return Array.from(buckets.entries())
    .map(([category, bucket]) => ({
      category,
      label: getCategoryLabel(category),
      amount: roundTo(bucket.amount),
      ratio: total > 0 ? roundTo(bucket.amount / total, 4) : 0,
      purchaseCount: bucket.purchaseCount,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** 单品支出排行 */
export function computeItemSpendingRanking(
  purchases: readonly PurchaseRecord[],
  limit?: number,
): ItemSpend[] {
  const buckets = new Map<number, ItemSpend>();

  for (const purchase of purchases) {
    const existing = buckets.get(purchase.itemId);
    const amount = resolvePurchaseAmount(purchase);
    if (existing) {
      existing.amount = roundTo(existing.amount + amount);
      existing.quantity = roundTo(existing.quantity + Math.abs(purchase.quantity));
      existing.purchaseCount += 1;
    } else {
      buckets.set(purchase.itemId, {
        itemId: purchase.itemId,
        name: purchase.itemName,
        unit: purchase.unit,
        amount,
        quantity: roundTo(Math.abs(purchase.quantity)),
        purchaseCount: 1,
      });
    }
  }

  const ranked = Array.from(buckets.values()).sort((a, b) => b.amount - a.amount);
  return limit === undefined ? ranked : ranked.slice(0, Math.max(0, limit));
}

/**
 * 月度支出汇总。
 * `anchor` 可以是时间戳（取该月）或 'YYYY-MM' 月份键（统计页切月用）。
 */
export function computeMonthlySpend(
  purchases: readonly PurchaseRecord[],
  anchor: number | MonthKey = Date.now(),
): MonthlySpendSummary {
  const range =
    typeof anchor === 'string'
      ? (monthRangeOfKey(anchor) ?? monthRangeOf(Date.now()))
      : monthRangeOf(anchor);
  const { startMs, endMs } = range;
  const monthKey =
    typeof anchor === 'string' && monthRangeOfKey(anchor) ? anchor : monthRangeOf(startMs).monthKey;

  const inMonth = purchases.filter(
    (purchase) => purchase.occurredAt >= startMs && purchase.occurredAt <= endMs,
  );

  return {
    monthKey,
    startMs,
    endMs,
    totalSpend: computeSpendTotal(inMonth),
    purchaseCount: inMonth.length,
    missingAmountCount: inMonth.filter((purchase) => resolvePurchaseAmount(purchase) === 0).length,
    byCategory: computeCategoryBreakdown(inMonth),
    byItem: computeItemSpendingRanking(inMonth),
  };
}

/** 环比：与上个月相比的变化量；上月为 0 时 ratio 返回 null（无法计算百分比） */
export function compareMonthlySpend(
  previous: MonthlySpendSummary,
  current: MonthlySpendSummary,
): { delta: number; deltaRatio: number | null } {
  const delta = roundTo(current.totalSpend - previous.totalSpend);
  const deltaRatio =
    previous.totalSpend > 0 ? roundTo(delta / previous.totalSpend, 4) : null;
  return { delta, deltaRatio };
}

/** 消耗量排行（直接来自 SQL 聚合，按数量降序，可截断） */
export function computeConsumptionRanking(
  totals: readonly ConsumptionTotal[],
  limit?: number,
): ConsumptionTotal[] {
  const sorted = [...totals].sort((a, b) => b.quantity - a.quantity);
  return limit === undefined ? sorted : sorted.slice(0, Math.max(0, limit));
}

/**
 * 估算「每消耗一次的平均成本」，用于判断某物品是否值得换更便宜的替代品。
 * 没有消耗记录时返回 null。
 */
export function computeUnitCost(
  totalSpend: number,
  consumedQuantity: number,
): number | null {
  if (consumedQuantity <= 0) return null;
  return roundTo(totalSpend / consumedQuantity, 4);
}
