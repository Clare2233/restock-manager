import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatQuantity } from '@/utils/number';

/**
 * 统计数字卡片：标签 + 数值 + 单位。
 *
 * 用途：首页与统计页顶部的关键指标（待补货 N 件 / 本月支出 ¥xxx / 库存告急 N 件）。
 *
 * 约定：
 * - `value` 传数字时用 `formatQuantity` 自动去掉多余小数（`12.00` → `12`）；
 *   传字符串时原样渲染 —— 金额这类需要固定两位小数的场景，
 *   请在调用方用 `formatMoney()` 格式化后再传，组件不猜你的口径。
 * - `unit` 是小一号的后缀（如「件」「天」），与数值基线对齐。
 * - `tone="danger"` 只用来表达「需要注意」，不要用它做装饰性着色。
 * - 默认自带 `backgroundElement` 底色；如果外层已经是 `SectionCard`，
 *   传 `flat` 去掉底色，否则会两块灰底叠加。
 */

export type StatTileTone = 'default' | 'danger' | 'muted';

export type StatTileProps = {
  /** 指标名称 */
  label: string;
  /** 指标值；数字会被自动格式化，字符串原样显示 */
  value: string | number;
  /** 数值后缀单位 */
  unit?: string;
  /** 数值下方的补充说明（如「较上月 +12%」） */
  hint?: string;
  tone?: StatTileTone;
  /** 右上角图标节点 */
  icon?: ReactNode;
  onPress?: () => void;
  /** 去掉自带底色，用于嵌在卡片内部 */
  flat?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  icon,
  onPress,
  flat = false,
  style,
}: StatTileProps) {
  const theme = useTheme();
  const text = typeof value === 'number' ? formatQuantity(value) : value;

  const valueColor =
    tone === 'danger' ? theme.danger : tone === 'muted' ? theme.textSecondary : theme.text;

  const content = (
    <>
      <View style={styles.headerRow}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
          {label}
        </ThemedText>
        {icon}
      </View>

      <View style={styles.valueRow}>
        <ThemedText style={[styles.value, { color: valueColor }]} numberOfLines={1}>
          {text}
        </ThemedText>
        {unit ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.unit}>
            {unit}
          </ThemedText>
        ) : null}
      </View>

      {hint ? (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
          {hint}
        </ThemedText>
      ) : null}
    </>
  );

  const containerStyle = [styles.tile, flat && styles.flat, style];

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${text}`}
        onPress={onPress}
        style={({ pressed }) => [
          ...containerStyle,
          flat ? undefined : { backgroundColor: theme.backgroundElement },
          pressed && styles.pressed,
        ]}>
        {content}
      </Pressable>
    );
  }

  // 不可点击时用 ThemedView 拿到主题底色；flat 时不需要背景，交给外层
  if (flat) {
    return <View style={containerStyle}>{content}</View>;
  }

  return (
    <ThemedView type="backgroundElement" style={containerStyle}>
      {content}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
    minWidth: 0,
  },
  flat: {
    padding: 0,
  },
  pressed: {
    opacity: 0.7,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  label: {
    flexShrink: 1,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.one,
  },
  value: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 600,
  },
  unit: {
    paddingBottom: Spacing.half,
  },
});
