import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { MonthKey } from '@/types/models';
import { formatMonthKeyCN } from '@/utils/date';
import { clampNumber } from '@/utils/number';

/**
 * 月度支出趋势柱状图（纯 View 实现，不引图表库）。
 *
 * 每根柱子是一个固定宽、可变高的 View：外层容器给固定高度，
 * 柱子内部再嵌一个顶部对齐的填充块，高度 = `amount / maxAmount × 100%`。
 * 选择这种实现方式而不是引三方图表库的原因见其他 stats 组件 —— 本项目
 * 目前只有「近 6 个月」这一个图表需求，引入图表库会连带一堆配置与依赖。
 *
 * ## 窗口是固定的，选中月只是高亮
 *
 * `points` 就是窗口本身（由页面按「今天所在月往前 6 个月」给出），
 * 组件**不根据 `selectedMonthKey` 重算窗口** —— 点柱子只回调 `onSelectMonth`，
 * 窗口一根柱子都不会变。用户翻到很早的月份时，近期 6 个月仍留在原位可作参照。
 *
 * 高亮规则：选中月**落在窗口内** → 那根柱子主色；落在窗口外 → 窗口内全部中性色
 * （没有一根匹配，自然就没有高亮，不需要额外分支）。
 *
 * 其他两点：
 * - 今天所在月的标签加 `*` 标记，与是否选中无关（它是「当下」的锚，不是选择态）；
 * - **零支出的月份留一根极矮的柱子**（`MIN_BAR_RATIO`），不做「无柱」：
 *   完全空会让那个月在水面上消失，用户会以为数据漏了而不是当月没花钱。
 *
 * 柱子整列可点（`Pressable` 包住柱体 + 标签），避免 20pt 宽的柱子难以命中；
 * 中性色的柱子同样可点 —— 能点到的月份范围不该被颜色暗示限制。
 */
export interface MonthSpendPoint {
  monthKey: MonthKey;
  amount: number;
}

export type SpendTrendChartProps = {
  /** 图表窗口（从早到晚）。只由「今天所在月」决定，与选中月无关 */
  points: readonly MonthSpendPoint[];
  /** 当前选中月：只影响高亮，不影响窗口 */
  selectedMonthKey: MonthKey;
  /** 今天所在月：标签加 `*` 标记，与选中态无关 */
  todayMonthKey: MonthKey;
  /** 点击柱子：只切换统计区显示的月份，窗口不动 */
  onSelectMonth: (monthKey: MonthKey) => void;
  /** 柱区最高像素 */
  height?: number;
};

const MIN_BAR_RATIO = 0.04;
const BAR_WIDTH = 20;

export function SpendTrendChart({
  points,
  selectedMonthKey,
  todayMonthKey,
  onSelectMonth,
  height = 96,
}: SpendTrendChartProps) {
  const theme = useTheme();
  const maxAmount = points.reduce((max, point) => Math.max(max, point.amount), 0);

  return (
    <View style={styles.container}>
      <View style={[styles.plot, { height }]}>
        {points.map((point) => {
          const ratio = maxAmount > 0 ? clampNumber(point.amount / maxAmount, 0, 1) : 0;
          const barHeight = Math.max(ratio, MIN_BAR_RATIO);
          const isSelected = point.monthKey === selectedMonthKey;
          const isToday = point.monthKey === todayMonthKey;
          const fillColor: ThemeColor = isSelected ? 'text' : 'backgroundSelected';

          return (
            <Pressable
              key={point.monthKey}
              accessibilityRole="button"
              accessibilityLabel={`${formatMonthKeyCN(point.monthKey)} 支出`}
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelectMonth(point.monthKey)}
              style={styles.column}>
              {/* 高度百分比必须相对一个已知高度的父容器，所以柱子先占满、
                  填充块用 justifyContent:'flex-end' 从底部长出来 */}
              <View style={styles.columnMeter}>
                <View
                  style={[
                    styles.bar,
                    {
                      height: `${barHeight * 100}%`,
                      backgroundColor: theme[fillColor],
                    },
                  ]}
                />
              </View>
              <ThemedText
                type="small"
                themeColor={isSelected ? 'text' : 'textSecondary'}
                style={styles.label}>
                {`${formatMonthKeyCN(point.monthKey, false)}${isToday ? '*' : ''}`}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  plot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 4,
  },
  column: {
    flex: 1,
    alignItems: 'center',
    height: '100%',
    gap: 4,
  },
  columnMeter: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {
    width: BAR_WIDTH,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
  },
});
