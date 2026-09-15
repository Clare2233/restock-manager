import { Pressable, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { MonthKey } from '@/types/models';
import { formatMonthKeyCN, shiftMonthKey } from '@/utils/date';

/**
 * 月份切换器。
 *
 * 只负责「当前看哪个月」这件事：左右两个按钮 + 中间的月份标题，
 * 数据来源与查询全部在 `useMonthlyStats` 里。
 *
 * 两个约束：
 * - `maxMonthKey`（默认当月）之后的月份**不能往后翻** —— 未来还没有流水，
 *   翻过去只会看到一张空报表，比置灰更让人困惑；
 * - 「回到当月」做成点标题（而不是再放一个按钮）：
 *   这是移动端常见的复位手势，也省一格横向空间。
 */
export type MonthPickerProps = {
  monthKey: MonthKey;
  onChange: (monthKey: MonthKey) => void;
  /** 允许前进到的最晚月份，默认当月 */
  maxMonthKey?: MonthKey;
  /** 允许后退到的最早月份；不传则不限制 */
  minMonthKey?: MonthKey;
};

export function MonthPicker({
  monthKey,
  onChange,
  maxMonthKey,
  minMonthKey,
}: MonthPickerProps) {
  const canGoNext = maxMonthKey === undefined || monthKey < maxMonthKey;
  const canGoPrev = minMonthKey === undefined || monthKey > minMonthKey;
  const isLatest = !canGoNext;

  return (
    <View style={styles.container}>
      <AppButton
        label="上月"
        size="small"
        variant="secondary"
        disabled={!canGoPrev}
        onPress={() => onChange(shiftMonthKey(monthKey, -1))}
      />

      {/* 标题在最新月不长按时才可点：已经是当月还弹一下，会让人以为点错了 */}
      <Pressable
        disabled={maxMonthKey === undefined || isLatest}
        accessibilityRole="button"
        accessibilityLabel={isLatest ? undefined : '回到当月'}
        onPress={() => {
          if (maxMonthKey !== undefined) onChange(maxMonthKey);
        }}
        style={({ pressed }) => [styles.titleHit, pressed && styles.pressed]}>
        <ThemedText type="default" style={styles.title}>
          {formatMonthKeyCN(monthKey)}
        </ThemedText>
      </Pressable>

      <AppButton
        label="下月"
        size="small"
        variant="secondary"
        disabled={!canGoNext}
        onPress={() => onChange(shiftMonthKey(monthKey, 1))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleHit: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  title: {
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
});
