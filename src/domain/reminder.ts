import { DEFAULT_RE_REMIND_INTERVAL_DAYS, DEFAULT_RESTOCK_COVER_DAYS } from '@/constants/defaults';
import type { Prediction } from '@/domain/prediction';
import { ceilToPack, normalizePackSize } from '@/domain/units';
import type { ISODate, Millis } from '@/types/models';
import { MS_PER_DAY, addDaysMs, nowMs, toISODate } from '@/utils/date';

/**
 * 提醒判定 —— 纯函数。
 *
 * ## 三个触发条件（满足任一即提醒）
 *   C1  今天 >= 建议购买日
 *   C2  安全库存 > 0 且 当前库存 <= 安全库存
 *   C3  预计耗尽日 <= 今天 + 提前提醒天数
 *
 * ## 优先级（同一物品只发一条通知，取最高优先级的原因）
 *   P0  stock <= 0            → 「已用完」，立即提醒，不受冷却与静默期限制
 *   P1  C2 命中               → 「低于安全库存」
 *   P2  C1 命中               → 「该补货了」
 *   P3  C3 命中               → 「即将用完」
 *
 * ## 日期从哪来：C1 / C3 只在两种情况下才有日期可用
 * C1 与 C3 都依赖 `runOutDate` / `buyDate`。这两个日期是否有值，
 * 统一由 `computePrediction` 决定（见 prediction.ts 顶部取舍 3）：
 *
 * 1. **实测日均可信**（`isReliable`）—— 记录跨度已满 MIN_RELIABLE_DAYS 天。
 *    主力路径，C1 / C3 正常按日期触发。
 *
 * 2. **冷启动估算**（`isEstimated`）—— 完全没有消耗流水，但用户填了
 *    「预计使用周期」，预测层用 `库存 / 周期` 推一个估算日均，
 *    从而给出初始的耗尽日与建议购买日。
 *
 *    这是有意为之：用户填了周期，就是表达了「大概多久用完」的期望，
 *    提醒遵循这个期望才合理，否则「预计使用周期」只是个装饰。
 *    一旦有了真实消耗流水，估算立即作废、自动切回实测（见 applyColdStartEstimate）。
 *
 * 3. **其余情况日期为空** —— 周期没填、库存为 0、或**日均虽算得出来但不可信**
 *    （例如只记了 1 天消耗，`spanDays = 1` 会把日均放大得离谱）。
 *    此时 `runOutDate` / `buyDate` 均为 null，C1 与 C3 不可能命中，
 *    只剩 C2 生效 —— 这正是我们要的降级行为。
 *
 * **C2 不受上述规则影响**：安全库存是用户自己设的明确信号，永远照常触发；
 * 库存见底（P0）同理，它是确定的事实而非预测。
 *
 * ## 冷却与静默期
 * - 冷却：已提醒过、且距上次提醒未满 `reRemindIntervalDays` 天 → 不再重复打扰；
 * - 静默期：用户点过「稍后提醒」→ 在 snoozedUntil 之前保持安静；
 * - **P0 例外**：库存已经见底是确定事实，跳过这两道限制立即提醒。
 */

export type ReminderCondition = 'C1_BUY_DATE' | 'C2_SAFETY_STOCK' | 'C3_RUN_OUT_SOON';

export type ReminderReason =
  | 'out_of_stock'
  | 'below_safety'
  | 'buy_date_reached'
  | 'run_out_soon';

/** 被抑制（不通知）的原因；null 表示正常通知 */
export type SuppressionReason =
  | 'notify_disabled'
  | 'archived'
  | 'no_trigger'
  | 'snoozed'
  | 'cooldown';

export type ReminderPriority = 0 | 1 | 2 | 3;

/** 判定只需要物品的这几个字段，方便单测构造轻量对象 */
export interface ReminderItemInput {
  id: number;
  name: string;
  stock: number;
  safetyStock: number;
  remindDays: number;
  quickConsumeQty: number;
  packSize: number;
  packUnit: string | null;
  unit: string;
  notifyEnabled: boolean;
  isArchived: boolean;
}

export interface ReminderDecision {
  itemId: number;
  shouldNotify: boolean;
  reason: ReminderReason | null;
  /** null = 三个条件都没命中 */
  priority: ReminderPriority | null;
  /** 命中的条件（可能多个），供 UI 展示判断依据 */
  matched: ReminderCondition[];
  suppressedBy: SuppressionReason | null;
  /** 首次应该提醒的业务日；scheduler 用它结合 notifyTime 排通知 */
  nextTriggerDate: ISODate | null;
  /** 建议补货量（基础单位，已向上取整到整包） */
  suggestedQty: number;
}

export const REMINDER_REASON_LABELS: Record<ReminderReason, string> = {
  out_of_stock: '已用完',
  below_safety: '低于安全库存',
  buy_date_reached: '该补货了',
  run_out_soon: '即将用完',
};

export const REMINDER_CONDITION_LABELS: Record<ReminderCondition, string> = {
  C1_BUY_DATE: '已到建议购买日',
  C2_SAFETY_STOCK: '库存低于安全库存',
  C3_RUN_OUT_SOON: '预计耗尽日临近',
};

/** 库存是否已见底 */
export function isOutOfStock(item: Pick<ReminderItemInput, 'stock'>): boolean {
  return item.stock <= 0;
}

/**
 * 首次应提醒的业务日。
 * 用于「还没到提醒时，通知该排在哪一天」——注意这里只给日期，
 * 具体时刻由 scheduler 用 item.notifyTime 拼装。
 */
export function resolveReminderDate(params: {
  item: ReminderItemInput;
  prediction: Prediction;
  now?: Millis;
}): ISODate | null {
  const now = params.now ?? nowMs();
  const today = toISODate(now);
  const { item, prediction } = params;

  // 已经需要立刻提醒的情况，触发日就是今天
  if (isOutOfStock(item)) return today;
  if (item.safetyStock > 0 && item.stock <= item.safetyStock) return today;

  return prediction.buyDate;
}

/**
 * 建议补货量：日均可用时覆盖未来 `coverDays` 天的用量，向上取整到整包。
 *
 * ## 判据与 `computePrediction` 严格一致（见 prediction.ts 顶部取舍 3）
 * 只有**可信实测**（`isReliable`）或**冷启动估算**（`isEstimated`）
 * 才允许把日均换算成具体数量。
 *
 * 否则会出现精神分裂：预测卡上写着「暂时无法预测」，旁边却给出一个
 * 由不可信日均算出来的精确数字（「建议买 27 个」）——
 * 用户完全没有依据判断这个数字从哪来，最后连预测卡一起不信。
 *
 * 所以此时退化为「补到安全库存」，至少 1 个采购单位（仍按整包向上取整）。
 * 安全库存是用户自己设的明确信号，与他之后会收到的「低于安全库存」提醒
 * 依据完全相同，不会自相矛盾。
 *
 * 注意这个条件同时覆盖「完全没有消耗数据」的情况：
 * 旧的「安全库存 × RESTOCK_SAFETY_MULTIPLIER」兜底已随之移除。
 */
export function computeSuggestedRestockQty(params: {
  prediction: Prediction;
  packSize?: number | null;
  coverDays?: number;
  safetyStock?: number;
}): number {
  const packSize = normalizePackSize(params.packSize);
  const coverDays = Math.max(1, Math.trunc(params.coverDays ?? DEFAULT_RESTOCK_COVER_DAYS));
  const { dailyAvg, stock, isReliable, isEstimated } = params.prediction;
  const safetyStock = Math.max(params.safetyStock ?? 0, 0);

  const rateIsUsable = dailyAvg > 0 && (isReliable || isEstimated);

  if (!rateIsUsable) {
    return ceilToPack(Math.max(safetyStock, 1), packSize);
  }

  return ceilToPack(Math.max(dailyAvg * coverDays - stock, 0), packSize);
}

/** 判定单个物品是否需要提醒，以及为什么 */
export function evaluateReminder(params: {
  item: ReminderItemInput;
  prediction: Prediction;
  now?: Millis;
  /** 上次提醒时间（来自 notification_history），用于冷却 */
  lastFiredAt?: Millis | null;
  /** 静默截止时间（用户点了「稍后提醒」） */
  snoozedUntil?: Millis | null;
  /** 重复提醒间隔天数；默认取全局设置 */
  reRemindIntervalDays?: number;
}): ReminderDecision {
  const now = params.now ?? nowMs();
  const { item, prediction } = params;
  const today = toISODate(now);

  const matched: ReminderCondition[] = [];
  if (prediction.buyDate !== null && today >= prediction.buyDate) {
    matched.push('C1_BUY_DATE');
  }
  if (item.safetyStock > 0 && item.stock <= item.safetyStock) {
    matched.push('C2_SAFETY_STOCK');
  }
  if (prediction.runOutDate !== null) {
    const deadline = toISODate(addDaysMs(now, Math.max(0, Math.trunc(item.remindDays))));
    // ISO 日期字符串按字典序比较即等价于按时间比较
    if (prediction.runOutDate <= deadline) {
      matched.push('C3_RUN_OUT_SOON');
    }
  }

  let reason: ReminderReason | null = null;
  let priority: ReminderPriority | null = null;
  if (isOutOfStock(item)) {
    reason = 'out_of_stock';
    priority = 0;
  } else if (matched.includes('C2_SAFETY_STOCK')) {
    reason = 'below_safety';
    priority = 1;
  } else if (matched.includes('C1_BUY_DATE')) {
    reason = 'buy_date_reached';
    priority = 2;
  } else if (matched.includes('C3_RUN_OUT_SOON')) {
    reason = 'run_out_soon';
    priority = 3;
  }

  const base = {
    itemId: item.id,
    reason,
    priority,
    matched,
    nextTriggerDate: resolveReminderDate({ item, prediction, now }),
    suggestedQty: computeSuggestedRestockQty({
      prediction,
      packSize: item.packSize,
      safetyStock: item.safetyStock,
    }),
  };

  if (priority === null) {
    return { ...base, shouldNotify: false, suppressedBy: 'no_trigger' };
  }
  if (item.isArchived) {
    return { ...base, shouldNotify: false, suppressedBy: 'archived' };
  }
  if (!item.notifyEnabled) {
    return { ...base, shouldNotify: false, suppressedBy: 'notify_disabled' };
  }

  // P0 是确定事实，跳过降温机制
  if (priority > 0) {
    const snoozedUntil = params.snoozedUntil ?? null;
    if (snoozedUntil !== null && snoozedUntil > now) {
      return { ...base, shouldNotify: false, suppressedBy: 'snoozed' };
    }

    const intervalDays = Math.max(
      1,
      Math.trunc(params.reRemindIntervalDays ?? DEFAULT_RE_REMIND_INTERVAL_DAYS),
    );
    const lastFiredAt = params.lastFiredAt ?? null;
    if (lastFiredAt !== null && now - lastFiredAt < intervalDays * MS_PER_DAY) {
      return { ...base, shouldNotify: false, suppressedBy: 'cooldown' };
    }
  }

  return { ...base, shouldNotify: true, suppressedBy: null };
}

/**
 * 紧急度排名，用于首页/库存页排序：数字越小越紧急。
 * 没有触发条件的物品排在最后（4）。
 */
export function reminderUrgencyRank(decision: ReminderDecision): number {
  return decision.priority ?? 4;
}

/** 紧急度比较器：先按优先级，再按触发日，最后按 id 保证稳定排序 */
export function compareByUrgency(a: ReminderDecision, b: ReminderDecision): number {
  const rankDiff = reminderUrgencyRank(a) - reminderUrgencyRank(b);
  if (rankDiff !== 0) return rankDiff;

  const dateA = a.nextTriggerDate ?? '9999-12-31';
  const dateB = b.nextTriggerDate ?? '9999-12-31';
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;

  return a.itemId - b.itemId;
}

/** 是否需要提醒（不关心原因的快捷判断） */
export function shouldNotify(decision: ReminderDecision): boolean {
  return decision.shouldNotify;
}
