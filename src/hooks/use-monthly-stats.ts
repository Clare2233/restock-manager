import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { getReadyDatabase } from '@/db/client';
import { listPurchaseMonths, listPurchasesInRange } from '@/db/repositories/stats.repo';
import type { MonthlySpendSummary } from '@/domain/spending';
import { computeMonthlySpend } from '@/domain/spending';
import type { MonthKey, PurchaseRecord } from '@/types/models';
import { monthRangeOfKey, nowMs, shiftMonthKey, toMonthKey } from '@/utils/date';

/**
 * 统计页的数据入口 —— 页面**只**通过它取数，不碰 db / repo / 领域函数。
 *
 * ## 查询策略：两次查询覆盖四块图区
 *
 * 1. `listPurchasesInRange(当月)` → `computeMonthlySpend()`：
 *    当月支出汇总（总额 / 分类 / 单品排行）**全部来自同一个纯函数结果**，
 *    所以分类之和必然等于顶部总额，不会出现两处口径打架。
 * 2. `listPurchaseMonths()` → 一次拿到所有有采购的月份金额，用 Map 缓存：
 *    - 近 6 个月趋势柱：Map 里没有的月份就是 0，不必逐月查 6 遍；
 *    - 上月对比：直接取上月的值，不必再算一次区间。
 *
 * ## 为什么坚持「购买日实付」而不是「按消耗摊销」
 * 见 domain/spending.ts 顶部：用户问的是「这个月花了多少钱」，
 * 实付口径就是答案；摊销需要跨月追踪每笔采购的剩余量，与本模型冲突。
 *
 * ## 为什么储蓄 re-fetch 走 useFocusEffect
 * 补货页入库后回到统计页，当月数据必须变。这里每次聚焦都直查
 * （采购记录是几十~几百行的量级，本地查询是瞬时的），不做缓存新鲜期。
 */
export interface MonthComparison {
  previousMonthKey: MonthKey;
  previousAmount: number;
  /** 差额（本月 - 上月），正数 = 花得更多 */
  delta: number;
  /** 变化率；上月为 0 时返回 null，避免出现 +∞% 这种没意义的文案 */
  ratio: number | null;
  /** 上月是否有采购记录。false 时 UI 不该显示「较上月 +100%」 */
  hasPrevious: boolean;
}

export interface UseMonthlyStatsResult {
  loading: boolean;
  error: string | null;
  monthKey: MonthKey;
  /** 允许前进到的最晚月份（当月）；往后翻到未来没有意义 */
  maxMonthKey: MonthKey;
  setMonthKey: (monthKey: MonthKey) => void;
  /** 当月汇总；加载失败或该月无数据时为 null */
  summary: MonthlySpendSummary | null;
  /** 与上月对比；首屏未加载完或上月无数据时为 null */
  comparison: MonthComparison | null;
  /** 近 6 个月（含**今天所在月**，从早到晚）。锚点是今天、不随选中月变化 */
  trend: ReadonlyArray<{ monthKey: MonthKey; amount: number }>;
  /**
   * 可翻到的最早月份（给月份切换器设下限）：
   * `max(今天往前 12 个月, 最早有采购的月份)`，没有采购记录时为 null。
   *
   * 数据不足 12 个月 → 就是最早那个月；超过 12 个月 → 固定 today-12，
   * 更早的历史仍按「实付口径」统计过，只是不再逐月回翻。
   */
  earliestMonthKey: MonthKey | null;
  /** 是否有过任何采购记录（与「能翻到哪个月」是两件事，别混用） */
  hasAnyPurchases: boolean;
  reload: () => Promise<void>;
}

const TREND_MONTHS = 6;
/** 往前翻月的月份数上限 */
const MONTH_LOOKBACK_LIMIT = 12;

export function useMonthlyStats(): UseMonthlyStatsResult {
  const maxMonthKey = toMonthKey(nowMs());
  const [monthKey, setMonthKey] = useState<MonthKey>(maxMonthKey);
  const [purchases, setPurchases] = useState<readonly PurchaseRecord[]>([]);
  const [monthlyTotals, setMonthlyTotals] = useState<ReadonlyMap<MonthKey, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const range = monthRangeOfKey(monthKey);
    if (!range) return;

    setLoading(true);
    try {
      const db = await getReadyDatabase();
      const [rows, months] = await Promise.all([
        listPurchasesInRange(db, range.startMs, range.endMs),
        // 趋势与上月对比都要它，一次查全、不随当前月变化，但把它放进同一次 await
        // 是为了让 loading 只有一次，页面不会先闪一下旧数据再补齐空缺的月份。
        listPurchaseMonths(db),
      ]);
      setPurchases(rows);
      setMonthlyTotals(new Map(months.map((row) => [row.monthKey, row.totalSpend] as const)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [monthKey]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const summary = useMemo(() => {
    if (loading) return null;
    return computeMonthlySpend(purchases, monthKey);
  }, [purchases, monthKey, loading]);

  const comparison = useMemo<MonthComparison | null>(() => {
    if (!summary) return null;
    const previousMonthKey = shiftMonthKey(monthKey, -1);
    const previousAmount = monthlyTotals.get(previousMonthKey) ?? 0;
    const hasPrevious = monthlyTotals.has(previousMonthKey);
    return {
      previousMonthKey,
      previousAmount,
      delta: summary.totalSpend - previousAmount,
      ratio: previousAmount > 0 ? summary.totalSpend / previousAmount - 1 : null,
      hasPrevious,
    };
  }, [summary, monthKey, monthlyTotals]);

  // 趋势窗口锚定「今天所在月」而不是选中月：选中月只是图上的一根高亮柱，
  // 它不应该把整个窗口拖着走（翻到很早的月份时，窗口滚走就看不到近期趋势了）。
  const trend = useMemo(() => {
    const points: Array<{ monthKey: MonthKey; amount: number }> = [];
    for (let offset = TREND_MONTHS - 1; offset >= 0; offset -= 1) {
      const key = shiftMonthKey(maxMonthKey, -offset);
      points.push({ monthKey: key, amount: monthlyTotals.get(key) ?? 0 });
    }
    return points;
  }, [maxMonthKey, monthlyTotals]);

  const earliestMonthKey = useMemo(() => {
    const keys = Array.from(monthlyTotals.keys()).sort();
    if (keys.length === 0) return null;
    // 'YYYY-MM' 的字典序就是时间序，直接比字符串即可。
    const floor = shiftMonthKey(maxMonthKey, -MONTH_LOOKBACK_LIMIT);
    const trueEarliest = keys[0] as MonthKey;
    return trueEarliest < floor ? floor : trueEarliest;
  }, [monthlyTotals, maxMonthKey]);

  return {
    loading,
    error,
    monthKey,
    maxMonthKey,
    setMonthKey,
    summary,
    comparison,
    trend,
    earliestMonthKey,
    hasAnyPurchases: monthlyTotals.size > 0,
    reload: load,
  };
}
