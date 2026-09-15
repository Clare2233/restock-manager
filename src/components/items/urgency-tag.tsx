import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import {
  reminderReasonOf,
  STATUS_TONE_COLORS,
  type StatusTone,
} from '@/components/items/item-status';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  REMINDER_REASON_LABELS,
  type ReminderPriority,
} from '@/domain/reminder';

/**
 * 紧急程度标签：P0 已用完 / P1 低于安全库存 / P2 该补货了 / P3 即将用完。
 *
 * 用途：首页「待补货」列表、通知详情。它表达的是**提醒决策的优先级**，
 * 与 `StockBadge`（库存数量状态的稳态描述）互补：
 * - `StockBadge` 回答「库存还剩多少」，不受提醒开关/冷却期影响；
 * - `UrgencyTag` 回答「为什么现在要提醒你」，直接来自 `ReminderDecision`。
 *
 * ## 文案来自领域层，不自己写
 * 标签文字取 `REMINDER_REASON_LABELS[reason]`，reason 由优先级一一映射。
 * 这一点很关键：如果这里自己写一套措辞，列表里的标签就会和用户手机收到的
 * 通知对不上（同一件事两种叫法）。领域层是通知文案的唯一事实来源。
 *
 * ## props
 * - `priority`：**必填**，`ReminderDecision.priority`；
 *   传 `null`（即三个条件都没命中）时渲染中性的「正常」。
 * - `showCode`：是否显示 `P0`~`P3` 前缀。默认关闭 —— 对家里用的 App 来说
 *   「P2」是内部术语，普通用户看不懂；调试或做设置页时可以打开。
 * - `compact`：紧凑模式，用于卡片内部。
 * - `style`：外层样式微调。
 */
export type UrgencyTagProps = {
  priority: ReminderPriority | null;
  showCode?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** 优先级 → 色调：0 最重（实心红），3 最轻（淡橙），null 中性 */
const PRIORITY_TONES: Record<ReminderPriority, StatusTone> = {
  0: 'dangerSolid',
  1: 'danger',
  2: 'warning',
  3: 'warning',
};

export function UrgencyTag({
  priority,
  showCode = false,
  compact = false,
  style,
}: UrgencyTagProps) {
  const reason = reminderReasonOf(priority);
  const label = reason ? REMINDER_REASON_LABELS[reason] : '正常';
  const text = showCode && priority !== null ? `P${priority} ${label}` : label;
  const tone = STATUS_TONE_COLORS[priority === null ? 'neutral' : PRIORITY_TONES[priority]];

  return (
    <ThemedView
      type={tone.background}
      accessible
      accessibilityLabel={priority === null ? '无需补货' : `紧急程度 ${label}`}
      style={[styles.tag, compact ? styles.compact : styles.regular, style]}>
      <ThemedText
        type="smallBold"
        themeColor={tone.foreground}
        style={compact ? styles.compactLabel : undefined}>
        {text}
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  tag: {
    borderRadius: Spacing.five,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  regular: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  compact: {
    paddingHorizontal: Spacing.two - Spacing.half,
    paddingVertical: 0,
  },
  compactLabel: {
    fontSize: 12,
    lineHeight: 18,
  },
});
