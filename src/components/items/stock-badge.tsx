import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import {
  STOCK_LEVEL_LABELS,
  STOCK_LEVEL_TONES,
  STATUS_TONE_COLORS,
  type StockLevel,
} from '@/components/items/item-status';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * 库存状态徽章：正常 / 偏低 / 告急 / 用完。
 *
 * 用途：物品卡片、物品详情页头部，一眼看出这个物品要不要管。
 *
 * ## props
 * - `level`：**必填**，库存档位。组件是「哑」的 —— 只负责画，不负责算。
 *   档位请用 `resolveStockLevel({ item, prediction })` 得到，
 *   这样和补货通知的判定口径严格一致（判定逻辑见 `item-status.ts`）。
 * - `label`：覆盖默认文案（默认取 `STOCK_LEVEL_LABELS`）。
 * - `compact`：紧凑模式（更小的字号与内边距），用于卡片内部。
 * - `style`：外层样式微调。
 *
 * ## 为什么不硬编码颜色
 * 四档色调全部经 `STATUS_TONE_COLORS` 映射到 theme token，直接传给
 * `ThemedView type` / `ThemedText themeColor` —— 组件里没有一个 hex，
 * 深色模式与将来的换肤都自动生效。
 *
 * 四档的视觉重量是递进的：灰底灰字 → 橙底橙字 → 淡红底红字 → 实心红，
 * 所以「用完」和「告急」即便同属红色系也能一眼区分。
 */
export type StockBadgeProps = {
  level: StockLevel;
  /** 覆盖默认文案 */
  label?: string;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function StockBadge({ level, label, compact = false, style }: StockBadgeProps) {
  const text = label ?? STOCK_LEVEL_LABELS[level];
  const tone = STATUS_TONE_COLORS[STOCK_LEVEL_TONES[level]];

  return (
    <ThemedView
      type={tone.background}
      accessible
      accessibilityLabel={`库存${text}`}
      style={[styles.badge, compact ? styles.compact : styles.regular, style]}>
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
  badge: {
    // 大圆角让短文案呈胶囊形；高度不足时 RN 会自动夹到一半高度
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
