import { DEFAULT_WINDOW_DAYS, MIN_RELIABLE_DAYS } from '@/constants/defaults';
import type { ConsumptionSample, ISODate, Item, Millis } from '@/types/models';
import {
  addDaysMs,
  clampDays,
  diffInCalendarDays,
  fromISODate,
  nowMs,
  startOfDayMs,
  subDaysMs,
  toISODate,
} from '@/utils/date';
import { roundTo } from '@/utils/number';

/**
 * 消耗预测 —— 纯函数，不碰数据库、不读全局状态，因此可以单独跑测试。
 *
 * 公式（与需求一致）：
 *   日均消耗     = 窗口内总消耗 / 实际统计天数
 *   剩余可用天数 = 当前库存 / 日均消耗
 *   预计耗尽日   = 今天 + 剩余可用天数
 *   建议购买日   = 预计耗尽日 - 提前提醒天数 - 采购缓冲天数
 *
 * 完全没有消耗流水时，若物品填了「预计使用周期」，额外做一次冷启动估算：
 *   日均消耗 = 当前库存 / 预计使用周期
 * 结果标 `isEstimated: true`，见 applyColdStartEstimate。
 *
 * 两处刻意的工程取舍，都是为了让提醒「宁可早、不要晚」：
 *
 * 1. **分母用实际统计天数，而不是死板除以 30。**
 *    新物品如果固定除以 30，日均会被严重低估，导致「永远不提醒」。
 *    实际天数 = 今天 − 统计基准日 + 1，并夹到 [1, 窗口天数]。
 *    统计基准日优先取显式设置，否则取窗口内最早的一条消耗，
 *    这样「物品早就建了、但最近才开始用」也能得到正确的速率。
 *
 * 2. **剩余天数向下取整（floor），不是四舍五入。**
 *    库存 1.2、日均 1 时，向上取整会认为还能撑到后天，实际今天就用完。
 */

/** 日均统计结果 */
export interface ConsumptionStats {
  /** 配置的统计窗口天数 */
  windowDays: number;
  /** 实际作为分母的天数（夹在 [1, windowDays]） */
  spanDays: number;
  /** 窗口内总消耗量（正数） */
  totalQty: number;
  /** 日均消耗量（正数） */
  dailyAvg: number;
  /** 窗口起点（当天 00:00） */
  windowStartMs: Millis;
  /** 参与统计的消耗条数 */
  sampleCount: number;
  /** 是否有消耗记录 */
  hasData: boolean;
  /**
   * 数据是否可信：统计跨度足够长且有样本。
   *
   * **参与日期计算**：为 false 且又不是冷启动估算时，`computePrediction`
   * 不会产出 `runOutDate` / `buyDate`（见文件顶部取舍 3），
   * 提醒因此退化为只靠安全库存（C2）兜底。
   */
  isReliable: boolean;
  /**
   * 日均是否来自**冷启动估算**（用户填的「预计使用周期」），而不是真实消耗样本。
   *
   * 与 `isReliable` 是两件事，不要混：
   * - `isEstimated` 描述「日均从哪来」—— 没样本，靠周期推算；
   * - `isReliable` 描述「样本够不够长」—— 有样本，但窗口太短。
   *
   * 为 true 时 UI 要说明「按预计周期估算」，不能声称是按实际消耗统计。
   */
  isEstimated: boolean;
}

/** 预测量 */
export interface Prediction {
  stock: number;
  dailyAvg: number;
  /** 剩余可用天数；null = 无法预测（没有消耗数据） */
  remainingDays: number | null;
  /** 预计耗尽日；null = 无法预测 */
  runOutDate: ISODate | null;
  /** 建议购买日；null = 无法预测 */
  buyDate: ISODate | null;
  /** 距预计耗尽还有几天（可为负，表示已过期） */
  daysUntilRunOut: number | null;
  /** 距建议购买日还有几天（<= 0 表示今天就该买） */
  daysUntilBuy: number | null;
  isReliable: boolean;
  /** 日均是否来自冷启动估算（见 `ConsumptionStats.isEstimated`） */
  isEstimated: boolean;
  stats: ConsumptionStats;
}

/** 计算统计量所需的最小输入 */
export function computeConsumptionStats(params: {
  samples: readonly ConsumptionSample[];
  windowDays: number;
  /** 显式指定的统计基准日；null/undefined = 自动取窗口内最早的消耗 */
  trackingStartedAt?: Millis | null;
  now?: Millis;
}): ConsumptionStats {
  const now = params.now ?? nowMs();
  const windowDays = Math.max(1, Math.trunc(params.windowDays));
  const todayStart = startOfDayMs(now);
  // 窗口含今天：过去 N 天 = 从 N-1 天前的那天 00:00 开始
  const windowStartMs = startOfDayMs(subDaysMs(todayStart, windowDays - 1));

  let totalQty = 0;
  let sampleCount = 0;
  let earliestSampleAt: Millis | null = null;

  for (const sample of params.samples) {
    if (!Number.isFinite(sample.quantity) || !Number.isFinite(sample.occurredAt)) continue;
    if (sample.occurredAt < windowStartMs || sample.occurredAt > now) continue;
    totalQty += Math.abs(sample.quantity);
    sampleCount += 1;
    if (earliestSampleAt === null || sample.occurredAt < earliestSampleAt) {
      earliestSampleAt = sample.occurredAt;
    }
  }
  totalQty = roundTo(totalQty);

  const baselineMs = params.trackingStartedAt ?? earliestSampleAt ?? now;
  const trackDays = diffInCalendarDays(todayStart, startOfDayMs(baselineMs)) + 1;
  const spanDays = clampDays(trackDays, 1, windowDays);
  const dailyAvg = roundTo(totalQty / spanDays, 3);

  // 窗口本身不足 7 天时（用户把窗口调小了），阈值跟着窗口一起降级
  const reliableThreshold = Math.min(MIN_RELIABLE_DAYS, windowDays);

  return {
    windowDays,
    spanDays,
    totalQty,
    dailyAvg,
    windowStartMs,
    sampleCount,
    hasData: sampleCount > 0,
    isReliable: sampleCount > 0 && spanDays >= reliableThreshold,
    // 本函数只处理真实样本；冷启动估算由 predictItem 事后补上（见 applyColdStartEstimate）
    isEstimated: false,
  };
}

/** 由统计量推导预测量 */
export function computePrediction(params: {
  stock: number;
  stats: ConsumptionStats;
  remindDays: number;
  leadDays: number;
  now?: Millis;
}): Prediction {
  const now = params.now ?? nowMs();
  const todayStart = startOfDayMs(now);
  const stock = roundTo(params.stock);
  const dailyAvg = params.stats.dailyAvg;
  const remindDays = Math.max(0, Math.trunc(params.remindDays));
  const leadDays = Math.max(0, Math.trunc(params.leadDays));

  let remainingDays: number | null = null;
  // 见文件顶部取舍 3：只有「可信的实测」或「冷启动估算」才允许换算成日期
  const rateIsUsable = dailyAvg > 0 && (params.stats.isReliable || params.stats.isEstimated);

  if (rateIsUsable) {
    remainingDays = Math.max(0, Math.floor(stock / dailyAvg));
  } else if (stock <= 0) {
    // 日均不可用、但库存已经见底：这是确定的事实，与日均可信度无关，可以直接判定。
    // 注意此时 remainingDays = 0 是「事实」而非「预测」，所以不受可信度限制。
    remainingDays = 0;
  }

  const runOutDate =
    remainingDays === null ? null : toISODate(addDaysMs(todayStart, remainingDays));

  const buyDate =
    runOutDate === null
      ? null
      : toISODate(addDaysMs(fromISODate(runOutDate), -(remindDays + leadDays)));

  return {
    stock,
    dailyAvg,
    remainingDays,
    runOutDate,
    buyDate,
    daysUntilRunOut:
      runOutDate === null ? null : diffInCalendarDays(fromISODate(runOutDate), todayStart),
    daysUntilBuy:
      buyDate === null ? null : diffInCalendarDays(fromISODate(buyDate), todayStart),
    isReliable: params.stats.isReliable,
    isEstimated: params.stats.isEstimated,
    stats: params.stats,
  };
}

/** 预测只需要物品的这几个字段，方便单测时构造轻量对象 */
export type PredictionItemInput = Pick<
  Item,
  | 'stock'
  | 'remindDays'
  | 'leadDays'
  | 'avgWindowDays'
  | 'trackingStartedAt'
  | 'estimatedCycleDays'
>;

/**
 * 冷启动：完全没有消耗流水时，用用户填的「预计使用周期」反推一个日均。
 *
 * ## 为什么是「库存 / 周期」而不是「1 / 周期」
 * 「预计使用周期」的语义是**当前这批库存大概能用多少天**，所以 日均 = 库存 / 周期。
 * 这样 `剩余可用天数 = 库存 / 日均` 恰好等于周期本身 ——
 * 用户填 30 天，首次算出来的预计耗尽日就是今天 + 30 天，语义自洽、符合直觉。
 *
 * 若改成 `1 / 周期`，等于断言「每 1 个基础单位能用 周期 天」：
 * 对「包 / 瓶 / 块 / 卷」这类物品明显不合理，而且结果与库存脱钩 ——
 * 库存翻倍却不会让耗尽日推后，与常识冲突。所以不采用。
 *
 * ## 边界：宁可不估算，也不要给假日期
 * 周期缺失 / 非正数 / 库存 <= 0 时**原样返回**，不做估算。
 * 此时 runOutDate 与 buyDate 均为 null，提醒自然退化为只靠安全库存（C2）兜底。
 *
 * ## 与实测的关系
 * 只要有**任何**消耗样本（`hasData`）就立刻改用实测统计，不再看这个字段。
 * 估算结果标 `isEstimated: true`、`isReliable` 保持 false ——
 * 它是估值不是实测，但提醒层会照常按它算出的日期排提醒：
 * 用户既然填了周期，就是表达了「大概多久用完」的期望，提醒遵循这个期望才合理。
 */
function applyColdStartEstimate(params: {
  stats: ConsumptionStats;
  stock: number;
  estimatedCycleDays: number | null | undefined;
}): ConsumptionStats {
  if (params.stats.hasData) return params.stats;

  const cycleDays = params.estimatedCycleDays;
  if (cycleDays === null || cycleDays === undefined) return params.stats;
  if (!Number.isFinite(cycleDays) || cycleDays <= 0) return params.stats;
  if (!Number.isFinite(params.stock) || params.stock <= 0) return params.stats;

  const dailyAvg = roundTo(params.stock / cycleDays, 3);
  // 极端情况（库存极小 + 周期极长）会四舍五入到 0。
  // dailyAvg 为 0 在 computePrediction 里等同于「无法预测」，
  // 那还不如明确地保持 isEstimated: false，别让 UI 误以为有估算值。
  if (dailyAvg <= 0) return params.stats;

  return { ...params.stats, dailyAvg, isEstimated: true };
}

/** 一步到位：物品字段 + 消耗样本 → 预测量 */
export function predictItem(params: {
  item: PredictionItemInput;
  samples: readonly ConsumptionSample[];
  now?: Millis;
}): Prediction {
  const stats = computeConsumptionStats({
    samples: params.samples,
    windowDays: params.item.avgWindowDays,
    trackingStartedAt: params.item.trackingStartedAt,
    now: params.now,
  });

  return computePrediction({
    stock: params.item.stock,
    stats: applyColdStartEstimate({
      stats,
      stock: params.item.stock,
      estimatedCycleDays: params.item.estimatedCycleDays,
    }),
    remindDays: params.item.remindDays,
    leadDays: params.item.leadDays,
    now: params.now,
  });
}

/**
 * 批量取样本的窗口起点：取所有物品中**最大**的 `avgWindowDays`。
 *
 * 放在这里是为了让「页面列表」和「通知重排」共用同一个起点 ——
 * 两处各算一份的话，只要一方改了窗口算法，就会出现
 * 「页面说还能用 5 天、通知却说明天该买」这种自相矛盾。
 *
 * 多捞出来的旧样本不会被误算：`computeConsumptionStats` 会按每个物品
 * 自己的 `avgWindowDays` 再过滤一次（见 `listConsumptionSamplesByItem` 的说明）。
 * 真正危险的是取小了（子集）—— 那会漏掉本该计入的样本，日均偏低、耗尽日偏晚。
 */
export function maxSampleWindowStart(
  items: readonly PredictionItemInput[],
  now: Millis,
): Millis {
  let maxWindowDays = DEFAULT_WINDOW_DAYS;
  for (const item of items) {
    if (Number.isFinite(item.avgWindowDays) && item.avgWindowDays > maxWindowDays) {
      maxWindowDays = item.avgWindowDays;
    }
  }
  // 与 computeConsumptionStats 的窗口算法保持一致：窗口含今天，
  // 所以 N 天窗口是从 N-1 天前的那天 00:00 开始
  return startOfDayMs(subDaysMs(startOfDayMs(now), maxWindowDays - 1));
}

/**
 * 按剩余可用天数换算成「预计还能用 X 天」的展示值。
 * 库存为 0 返回 0；无法预测返回 null。
 */
export function remainingDaysOf(prediction: Prediction): number | null {
  return prediction.remainingDays;
}
