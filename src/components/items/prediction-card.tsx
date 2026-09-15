import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { FieldRow } from '@/components/common/field-row';
import { SectionCard } from '@/components/common/section-card';
import { ThemedText } from '@/components/themed-text';
import { MIN_RELIABLE_DAYS } from '@/constants/defaults';
import { Spacing } from '@/constants/theme';
import type { Prediction } from '@/domain/prediction';
import { formatDateCN } from '@/utils/date';
import { formatQuantity } from '@/utils/number';

/**
 * 消耗预测卡 —— 物品详情页的核心信息块。
 *
 * 回答四个问题：现在还剩多久、日均用多少、哪天用完、该哪天买。
 *
 * ## props
 * - `prediction`：预测结果，**必须来自 `predictItem` / `computePrediction`**。
 *   卡片不自己算任何东西 —— 算日均要读流水，那是数据层的活。
 *   这样详情页和列表页对同一物品的结论永远一致。
 * - `unit`：基础计量单位，只用于「日均消耗」的展示（`Prediction` 里没有单位）。
 * - `style`：外层样式微调。
 *
 * ## 最容易犯的错：把估算说成实测
 * 「日均消耗」有三种来源，混淆它们就是骗用户：
 * - `isEstimated`      —— 没流水，按用户填的「预计使用周期」推算
 * - `!isReliable`      —— 有流水，但记录跨度不够（日均会被放大，不可信）
 * - 其余                —— 真正的实测统计
 *
 * 所以数据来源文案**必须**随这三者变化，见 `resolveSourceText`。
 * 尤其是估算态下写「按实际消耗统计」会让用户以为系统在统计，而其实什么都没统计。
 *
 * ## 为什么用 flush 之外的普通 SectionCard
 * 卡里既有大字号主结论、又有「标签 → 值」明细行，需要卡片自身的内边距。
 * （`flush` 在本项目里是给「整行列表」用的，这里的首行不是纯列表行。）
 */

export type PredictionCardProps = {
  prediction: Prediction;
  unit: string;
  style?: StyleProp<ViewStyle>;
};

/** 数据是否可信所需的最小记录跨度；窗口被调小时阈值跟着降 */
function reliableThresholdOf(prediction: Prediction): number {
  return Math.min(MIN_RELIABLE_DAYS, prediction.stats.windowDays);
}

/**
 * 数据来源说明。三种口径必须分清，顺序也不能换：
 * `isEstimated` 时 `isReliable` 必然也是 false，先判估算才能避免说成「积累中」。
 *
 * 实测分支用 `spanDays`（实际充当分母的天数）而不是 `windowDays`：
 * 窗口配的是 30 天，但只采到 10 天的样本时，说「按近 30 天统计」是错的。
 */
function resolveSourceText(prediction: Prediction): string {
  if (prediction.isEstimated) return '按预计周期估算';
  if (!prediction.isReliable) return '用量数据积累中';
  return `按近 ${prediction.stats.spanDays} 天实际消耗统计`;
}

/**
 * 主结论：当前最要紧的一句话。
 *
 * 判断顺序与 `ItemCard.resolveRunOutText` 刻意保持一致 —— 同一个物品，
 * 列表卡片和详情页不能一个说「库存已用完」、另一个说「今天可能用完」。
 * `stock <= 0` 必须排在 `remainingDays === 0` 前面，因为库存见底时两者会同时成立。
 */
function resolveHeadline(prediction: Prediction): string {
  if (prediction.stock <= 0) return '库存已用完';
  if (prediction.remainingDays === null) return '暂时无法预测';
  if (prediction.remainingDays === 0) return '今天可能用完';
  return `还能用 ${prediction.remainingDays} 天`;
}

/**
 * 主结论的补充说明：**解释为什么没有日期**。
 * 只说「暂时无法预测」会让用户以为是 bug，说清原因才知道该做什么。
 */
function resolveHeadlineHint(prediction: Prediction): string | undefined {
  if (prediction.stock <= 0) return '补货后预测会重新开始';
  if (prediction.remainingDays !== null) return undefined;
  if (prediction.stats.hasData) {
    const threshold = reliableThresholdOf(prediction);
    return `消耗记录还不满 ${threshold} 天，暂时只按安全库存提醒`;
  }
  return '记录几次消耗后就能算出预计耗尽日';
}

/**
 * 相对天数文案，作为绝对日期的补充（「10月8日」旁边写「还有 5 天」）。
 * 绝对日期用于记日程，相对天数用于感知紧迫程度，两者互补。
 */
function resolveDaysHint(days: number | null): string | undefined {
  if (days === null) return undefined;
  if (days < 0) return `已过 ${Math.abs(days)} 天`;
  if (days === 0) return '今天';
  return `还有 ${days} 天`;
}

export function PredictionCard({ prediction, unit, style }: PredictionCardProps) {
  const headlineHint = resolveHeadlineHint(prediction);

  // 日均 <= 0 表示「没有可用速率」而不是「用量为零」——
  // 显示成 '0 ml/天' 会被读成「永远用不完」，那是错的。
  const dailyAvgText =
    prediction.dailyAvg > 0
      ? `${formatQuantity(prediction.dailyAvg, unit, 3)}/天`
      : '暂无数据';

  // 日期为 null 时一律给人类可读的降级文案，绝不把 null / NaN 漏到界面上
  const runOutText =
    prediction.runOutDate !== null ? formatDateCN(prediction.runOutDate) : '暂无';
  const buyText = prediction.buyDate !== null ? formatDateCN(prediction.buyDate) : '暂无';

  return (
    <SectionCard title="消耗预测" description={resolveSourceText(prediction)} style={style}>
      <View style={styles.summary}>
        <ThemedText style={styles.headline}>{resolveHeadline(prediction)}</ThemedText>
        {headlineHint ? (
          <ThemedText type="small" themeColor="textSecondary">
            {headlineHint}
          </ThemedText>
        ) : null}
      </View>

      <FieldRow
        label="日均消耗"
        value={dailyAvgText}
        hint={prediction.isEstimated ? '有消耗记录后会自动改用实测统计' : undefined}
      />
      <FieldRow
        label="预计耗尽日"
        value={runOutText}
        hint={resolveDaysHint(prediction.daysUntilRunOut)}
      />
      <FieldRow
        label="建议购买日"
        value={buyText}
        hint={resolveDaysHint(prediction.daysUntilBuy)}
        hideDivider
      />
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  summary: {
    gap: Spacing.one,
    // 明细行自带 paddingVertical，这里只补一点点，避免主结论被顶开太远
    paddingBottom: Spacing.one,
  },
  headline: {
    // 与 ItemCard 的库存数字同字号，让「还能用多久」在所有页面权重一致
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
  },
});
