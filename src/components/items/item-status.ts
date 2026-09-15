import type { ThemeColor } from '@/constants/theme';
import { DEFAULT_RESTOCK_COVER_DAYS, RESTOCK_SAFETY_MULTIPLIER } from '@/constants/defaults';
import type { Prediction } from '@/domain/prediction';
import {
  evaluateReminder,
  type ReminderItemInput,
  type ReminderPriority,
  type ReminderReason,
} from '@/domain/reminder';
import type { Millis } from '@/types/models';
import { clampNumber } from '@/utils/number';

/**
 * 物品类组件的「展示层派生」工具 —— 纯函数 + 常量，不含 JSX。
 *
 * 为什么单独一个文件：`ItemCard` / `StockBadge` / `UrgencyTag` 需要**同一套**
 * 「这件东西现在有多紧急、该用什么颜色」的结论。如果各自在组件里算一遍，
 * 迟早出现「卡片显示告急、标签显示偏低」这种自相矛盾。
 *
 * ## 关键取舍：紧急程度不在展示层自己定义，而是复用领域层的判定结果
 *
 * 库存有 4 档（正常/偏低/告急/用完），但**没有任何一个阈值是这里新造的**：
 * 全部来自 `domain/reminder.ts` 已验收的 `evaluateReminder()`：
 *
 *   P0 stock <= 0                    → 用完
 *   P1 C2 命中（跌破安全库存）        → 告急
 *   P2 C1 命中（已到建议购买日）      → 偏低
 *   P3 C3 命中（即将用完）           → 偏低
 *   三个条件都没命中                  → 正常
 *
 * 界线是「库存**数量**是否已跌破用户自己设的安全线」：
 * P0/P1 是数量已经不够（硬事实），P2/P3 是时间维度上该准备了。
 *
 * 这样做的收益：徽章与用户实际收到的补货通知**永远一致**，不会有一套 UI 口径、
 * 一套通知口径。代价：本文件依赖领域层，但只依赖纯函数，不碰数据库。
 */

/** 库存状态档位 */
export type StockLevel = 'normal' | 'low' | 'critical' | 'out';

export const STOCK_LEVEL_LABELS: Record<StockLevel, string> = {
  normal: '正常',
  low: '偏低',
  critical: '告急',
  out: '用完',
};

/**
 * 标签色调。
 * 只描述「视觉重量」，不描述业务含义 —— 业务含义由 StockLevel / 优先级表达。
 * solid 是最重的一档（实心红），只用来说明「已经确定出问题了」。
 */
export type StatusTone = 'neutral' | 'warning' | 'danger' | 'dangerSolid';

/**
 * 色调 → theme token 键。
 * 返回的是**键名**而不是颜色值，这样调用方可以直接喂给
 * `<ThemedView type={...}>` / `<ThemedText themeColor={...}>`，
 * 既不用 useTheme，也不会把 hex 写进组件。
 */
export const STATUS_TONE_COLORS: Record<
  StatusTone,
  { background: ThemeColor; foreground: ThemeColor }
> = {
  neutral: { background: 'backgroundSelected', foreground: 'textSecondary' },
  warning: { background: 'warningSoft', foreground: 'warning' },
  danger: { background: 'dangerSoft', foreground: 'danger' },
  dangerSolid: { background: 'danger', foreground: 'onDanger' },
};

export const STOCK_LEVEL_TONES: Record<StockLevel, StatusTone> = {
  normal: 'neutral',
  low: 'warning',
  critical: 'danger',
  out: 'dangerSolid',
};

/**
 * 进度条填充色。
 * 与标签刻意分开：标签的 `neutral` 是灰底灰字，而「正常」的进度条用主文字色
 * 才显得「满、健康」；用灰色会让人误以为库存不足。
 */
export const STOCK_LEVEL_BAR_COLORS: Record<StockLevel, ThemeColor> = {
  normal: 'text',
  low: 'warning',
  critical: 'danger',
  out: 'danger',
};

/** 优先级 → 领域层的原因（一一对应，用于取通知同一套文案） */
const PRIORITY_REASON: Record<ReminderPriority, ReminderReason> = {
  0: 'out_of_stock',
  1: 'below_safety',
  2: 'buy_date_reached',
  3: 'run_out_soon',
};

/** 由优先级取原因；null（无条件命中）返回 null */
export function reminderReasonOf(priority: ReminderPriority | null): ReminderReason | null {
  return priority === null ? null : PRIORITY_REASON[priority];
}

/** 由优先级取库存档位 */
export function stockLevelOfPriority(priority: ReminderPriority | null): StockLevel {
  switch (priority) {
    case 0:
      return 'out';
    case 1:
      return 'critical';
    case 2:
    case 3:
      return 'low';
    default:
      return 'normal';
  }
}

/**
 * 物品 + 预测 → 紧急程度优先级（`UrgencyTag` / 「待补货」列表用）。
 * 内部直接调领域层的 `evaluateReminder`，所以和通知判定共用同一套条件。
 *
 * 注意这里**不传** lastFiredAt / snoozedUntil：标签表达的是「现在的状态」，
 * 不该被冷却期或「稍后提醒」影响 —— 用户点过稍后提醒，不代表库存就不告急了。
 */
export function resolveUrgencyPriority(params: {
  item: ReminderItemInput;
  prediction: Prediction;
  now?: Millis;
}): ReminderPriority | null {
  return evaluateReminder({
    item: params.item,
    prediction: params.prediction,
    now: params.now,
  }).priority;
}

/** 物品 + 预测 → 库存档位（`StockBadge` 用）。由优先级换算，口径必然一致。 */
export function resolveStockLevel(params: {
  item: ReminderItemInput;
  prediction: Prediction;
  now?: Millis;
}): StockLevel {
  return stockLevelOfPriority(resolveUrgencyPriority(params));
}

/**
 * 进度条的「参考库存量」＝ 补满一次大概会是多少。
 *
 * 口径与领域层的建议补货量**完全一致**（见 `computeSuggestedRestockQty`），
 * 复用的也是同两个常量，没有新造系数：
 *   有日均 → 覆盖未来 `coverDays` 天的用量
 *   无日均 → 安全库存 × 2
 *
 * 这样「刚补完货」的进度条是满的，之后随消耗逐渐变空，符合直觉。
 */
export function referenceStockLevel(params: {
  prediction: Prediction;
  safetyStock: number;
  coverDays?: number;
}): number {
  const coverDays = Math.max(1, Math.trunc(params.coverDays ?? DEFAULT_RESTOCK_COVER_DAYS));
  if (params.prediction.dailyAvg > 0) {
    return params.prediction.dailyAvg * coverDays;
  }
  return Math.max(params.safetyStock, 0) * RESTOCK_SAFETY_MULTIPLIER;
}

/**
 * 进度条填充比例（0~1）。
 *
 * 两个边界都是有意的：
 * - 参考量为 0（既没有消耗数据、也没设安全库存）时，只要有库存就返回满格。
 *   此时显示空进度条会误导成「快用完了」，而事实只是「还没开始统计」。
 * - 库存超过参考量时夹到 1，不做超出满格的特效。
 */
export function resolveStockFill(params: {
  prediction: Prediction;
  safetyStock: number;
  coverDays?: number;
}): number {
  const reference = referenceStockLevel(params);
  if (reference <= 0) {
    return params.prediction.stock > 0 ? 1 : 0;
  }
  return clampNumber(params.prediction.stock / reference, 0, 1);
}
