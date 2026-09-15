import { StyleSheet, View } from 'react-native';

import { SpendBar } from '@/components/stats/spend-bar';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { CategorySpend } from '@/domain/spending';
import { formatMoney, formatPercent } from '@/utils/number';

/**
 * 分类支出明细列表。
 *
 * 每行三段：分类名 + 笔数（左）、金额 + 占比（右）、下面一条 `SpendBar`。
 * 排序与占比全部来自领域层的 `computeCategoryBreakdown`，这里不做任何再计算 ——
 * 保证这里的百分比和金额与「本月总支出」严格同源（同一个汇总结果的两个切片）。
 *
 * 为什么用占比条而不是饼图：家庭场景下分类只有 5 个，饼图需要额外图例、
 * 且小扇形难以点读；条形把「谁占得多」表达得更直接，也能顺带显示金额。
 */
export type CategoryBreakdownProps = {
  items: readonly CategorySpend[];
  /** 超过该行数的部分折叠？目前分类最多 5 类，保留参数以便将来扩展 */
  limit?: number;
};

export function CategoryBreakdown({ items, limit }: CategoryBreakdownProps) {
  const rows = limit === undefined ? items : items.slice(0, Math.max(0, limit));

  return (
    <View style={styles.container}>
      {rows.map((item) => (
        <View key={item.category} style={styles.row}>
          <View style={styles.header}>
            <ThemedText type="smallBold" style={styles.name}>
              {item.label}
            </ThemedText>
            <View style={styles.headerRight}>
              <ThemedText type="smallBold">{formatMoney(item.amount)}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {formatPercent(item.ratio)}
              </ThemedText>
            </View>
          </View>
          <SpendBar ratio={item.ratio} />
          <ThemedText type="small" themeColor="textSecondary">
            {item.purchaseCount} 笔采购
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.three,
  },
  row: {
    gap: Spacing.one,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
  },
  name: {
    flexShrink: 1,
  },
});
