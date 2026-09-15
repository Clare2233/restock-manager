import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/common/empty-state';
import { SectionCard } from '@/components/common/section-card';
import { StatTile } from '@/components/common/stat-tile';
import { CategoryBreakdown } from '@/components/stats/category-breakdown';
import { MonthPicker } from '@/components/stats/month-picker';
import { SpendTrendChart } from '@/components/stats/spend-trend-chart';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import type { ItemSpend } from '@/domain/spending';
import { useTheme } from '@/hooks/use-theme';
import { useMonthlyStats } from '@/hooks/use-monthly-stats';
import { formatMonthKeyCN } from '@/utils/date';
import { formatMoney, formatPercent, formatQuantity } from '@/utils/number';

const ICON_CHART = { ios: 'chart.bar', android: 'bar_chart', web: 'bar_chart' } as const;

/** 单品支出排行的显示条数 */
const TOP_ITEM_LIMIT = 5;

/**
 * 统计页（`/(tabs)/stats`）。
 *
 * 四块内容，全部取自 `useMonthlyStats` 的一次汇总结果：
 * 1. 本月支出（总金额 + 较上月对比）+ 采购笔数（`StatTile`）
 * 2. 各类别支出（`CategoryBreakdown`：金额 / 占比 / 占比条）
 * 3. 近 6 个月支出趋势（`SpendTrendChart`，柱子可点 = 第二个月份入口）
 *    窗口固定锚定「今天所在月往前 6 个月」，翻月 / 点柱子都只改 `monthKey`、
 *    不移动窗口；选中月落在窗口外时窗口内无高亮柱。
 * 4. 单品支出排行 Top 5（点行进物品详情）
 *
 * 页面只做拼装：判定与聚合在 `useMonthlyStats` / `domain/spending.ts`，
 * 组件在 `components/stats/`。**没有引入任何图表库**，柱状图与占比条都是纯 View。
 *
 * 空态分两级：整份数据一条采购都没有 → 整页空态；
 * 只是当前月没有（历史有）→ 保留趋势图与对比，只在金额区提示，
 * 否则用户切到空白月会误以为数据丢了。
 */
export default function StatsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    loading,
    error,
    monthKey,
    maxMonthKey,
    setMonthKey,
    summary,
    comparison,
    trend,
    earliestMonthKey,
    hasAnyPurchases,
    reload,
  } = useMonthlyStats();

  // 空态只看「有没有过采购记录」。以下两种情况都不算空，只是当月没数据：
  // 趋势窗口固定为近 6 个月（只有更早数据的用户窗口内全 0）；
  // 可翻范围是按今天往前 12 个月钳出来的，中间必然存在没有采购的月份。
  const isEmptyMonth = !loading && summary !== null && summary.purchaseCount === 0;

  return (
    <ThemedView style={[styles.screen, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.pickerRow}>
          <MonthPicker
            monthKey={monthKey}
            onChange={setMonthKey}
            maxMonthKey={maxMonthKey}
            minMonthKey={earliestMonthKey ?? undefined}
          />
        </View>

        {loading ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator />
          </View>
        ) : error ? (
          <EmptyState
            icon={<SymbolView name={ICON_CHART} size={24} tintColor={theme.textSecondary} />}
            title="没能读到统计数据"
            description={error}
            actionLabel="重试"
            onAction={() => void reload()}
          />
        ) : !hasAnyPurchases && isEmptyMonth ? (
          <EmptyState
            icon={<SymbolView name={ICON_CHART} size={24} tintColor={theme.textSecondary} />}
            title="还没有采购记录"
            description="在详情页点「补货入库」并填上金额，这里就会按月汇总支出、分类占比和单品排行。"
          />
        ) : (
          <>
            {/* ---- 本月支出 ---- */}
            <View style={styles.tiles}>
              <StatTile
                style={styles.tile}
                label={`${formatMonthKeyCN(monthKey)}支出`}
                value={formatMoney(summary?.totalSpend ?? 0)}
                hint={comparisonHint(comparison)}
                icon={<SymbolView name={ICON_CHART} size={16} tintColor={theme.textSecondary} />}
              />
              <StatTile
                style={styles.tile}
                label="采购笔数"
                value={summary?.purchaseCount ?? 0}
                hint={
                  summary === null || summary.purchaseCount === 0
                    ? '当月没有采购'
                    : summary.missingAmountCount > 0
                      ? `${summary.missingAmountCount} 笔没记金额`
                      : '已记录金额'
                }
                tone={summary !== null && summary.missingAmountCount > 0 ? 'muted' : 'default'}
              />
            </View>

            {isEmptyMonth ? (
              <ThemedText type="small" themeColor="textSecondary">
                {formatMonthKeyCN(monthKey)}没有采购记录。
              </ThemedText>
            ) : null}

            {/* ---- 各类别支出 ---- */}
            {summary !== null && summary.byCategory.length > 0 ? (
              <SectionCard
                title="各类别支出"
                description={`${summary.byCategory.length} 个分类，共 ${formatMoney(summary.totalSpend)}`}>
                <CategoryBreakdown items={summary.byCategory} />
              </SectionCard>
            ) : null}

            {/* ---- 近 6 个月趋势（窗口固定，点柱子只换上面的统计区） ---- */}
            {hasAnyPurchases ? (
              <SectionCard
                title="支出趋势"
                description={`近 6 个月（${formatMonthKeyCN(maxMonthKey, false)}* 为当月），点柱子切换统计月份`}>
                <SpendTrendChart
                  points={trend}
                  selectedMonthKey={monthKey}
                  todayMonthKey={maxMonthKey}
                  onSelectMonth={setMonthKey}
                />
              </SectionCard>
            ) : null}

            {/* ---- 单品支出排行 Top 5 ---- */}
            {summary !== null && summary.byItem.length > 0 ? (
              <SectionCard
                title="单品支出排行"
                description={`${formatMonthKeyCN(monthKey)}花钱最多的 ${Math.min(
                  TOP_ITEM_LIMIT,
                  summary.byItem.length,
                )} 件`}>
                {summary.byItem.slice(0, TOP_ITEM_LIMIT).map((row, index) => (
                  <TopItemRow key={row.itemId} row={row} rank={index + 1} />
                ))}
              </SectionCard>
            ) : null}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

// ---------------------------------------------------------------------------
// 排行行
// ---------------------------------------------------------------------------

function TopItemRow({ row, rank }: { row: ItemSpend; rank: number }) {
  return (
    // typed routes 一律用对象形式：字符串形式在 Android / Web 上会丢导航
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看 ${row.name} 详情`}
      onPress={() => router.push({ pathname: '/item/[id]', params: { id: String(row.itemId) } })}
      style={({ pressed }) => [styles.topRow, pressed && styles.pressed]}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.rank}>
        {rank}
      </ThemedText>
      <View style={styles.topMain}>
        <ThemedText numberOfLines={1}>{row.name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {formatQuantity(row.quantity, row.unit)} · {row.purchaseCount} 笔
        </ThemedText>
      </View>
      <ThemedText type="smallBold">{formatMoney(row.amount)}</ThemedText>
    </Pressable>
  );
}

/** 较上月对比文案：无上月数据时明确说「没有可比的上月」，不用 +100% 误导 */
function comparisonHint(
  comparison: ReturnType<typeof useMonthlyStats>['comparison'],
): string {
  if (!comparison) return '';
  if (!comparison.hasPrevious || comparison.previousAmount === 0) {
    return `${formatMonthKeyCN(comparison.previousMonthKey)}没有可比支出`;
  }
  const direction = comparison.delta > 0 ? '多花' : comparison.delta < 0 ? '少花' : '持平';
  const amount = Math.abs(comparison.delta);
  const percent = comparison.ratio === null ? '' : ` (${formatPercent(Math.abs(comparison.ratio))})`;
  return comparison.delta === 0
    ? `与${formatMonthKeyCN(comparison.previousMonthKey)}持平`
    : `较上月${direction} ${formatMoney(amount)}${percent}`;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.five,
    gap: Spacing.three,
  },
  pickerRow: {
    paddingTop: Spacing.three,
  },
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
  tiles: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  tile: {
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  rank: {
    minWidth: 16,
    textAlign: 'center',
  },
  topMain: {
    flex: 1,
    gap: Spacing.half,
  },
  pressed: {
    opacity: 0.7,
  },
});
