import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  resolveStockFill,
  resolveStockLevel,
  resolveUrgencyPriority,
  STOCK_LEVEL_BAR_COLORS,
} from '@/components/items/item-status';
import { StockBadge } from '@/components/items/stock-badge';
import { UrgencyTag } from '@/components/items/urgency-tag';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { Prediction } from '@/domain/prediction';
import { formatStock } from '@/domain/units';
import { useTheme } from '@/hooks/use-theme';
import type { Item } from '@/types/models';
import { formatDateCN } from '@/utils/date';

/**
 * 物品卡片：库存页 / 首页列表的列表项。
 *
 * 左侧从上到下：名称 → 当前库存 → 进度条 → 预计耗尽日 + 库存状态徽章；
 * 右侧是独立的「用一次」圆形按钮。
 *
 * ## props
 * - `item`：物品（领域模型，来自数据层）。
 * - `prediction`：该物品的预测结果。卡片**不自己算预测** —— 算日均要读流水，
 *   属于数据层的活；这里只消费结果，保证列表里同一物品的预测和详情页一致。
 * - `onPress`：点卡片主体 → 进物品详情页。不传则卡片不可点。
 * - `onQuickConsume`：点右侧圆形按钮 → 快捷记一次消耗。
 *   库存 <= 0 时按钮自动禁用，避免扣出负库存这种不可能的数据。
 * - `badge`：右下角标签显示哪一种，默认 `'stock'`（见 `ItemCardProps`）。
 * - `style`：外层样式微调。
 *
 * ## 两个点击区域为什么能分开（兄弟层级，不做嵌套）
 * 早期版本把圆形按钮嵌在外层 Pressable 里面，真机上点按钮会把外层的
 * `onPress` 一起触发（跳进详情页）—— 嵌套的可触摸组件在 Android / Web
 * 上都不能保证「只有最深的赢」，事件冒泡不可靠。
 *
 * 现在是三个**兄弟**节点，不存在嵌套，也就不存在冒泡：
 * 1. 背景层：`absoluteFill` 的 Pressable，负责整卡点击与按压反馈，卡片底色归它管；
 * 2. 内容层：`pointerEvents="none"` 的纯展示区，触摸直接落到背景层
 *    （不设这个，普通 View 会挡住下层兄弟的命中测试，主体区域变成死区）；
 * 3. 圆形按钮：普通兄弟节点，绘制在背景层之上，触摸天然只归它。
 *
 * 手指落在哪一层，哪一层的 Pressable 就是唯一响应者 ——
 * 这是结构上的保证，不依赖任何平台对嵌套触摸的处理方式。
 *
 * ## 进度条
 * 纯 `View` 实现，不引库：外层是轨道，内层用 `flexGrow` 表示填充比例，
 * 没有用百分比字符串，避免 `width: '42%'` 这类类型转换。
 * 填充比例的取值口径见 `resolveStockFill`（与领域层建议补货量同一套常量）。
 */
export type ItemCardProps = {
  item: Item;
  prediction: Prediction;
  onPress?: () => void;
  onQuickConsume?: () => void;
  /**
   * 右下角标签显示什么：
   * - `'stock'`（默认）：库存状态徽章，回答「还剩多少」→ 全部物品列表
   * - `'urgency'`：紧急程度标签，回答「为什么该买」→ 首页「待补货」列表
   *
   * 详情页两个都要：头部用 `StockBadge`，预测卡用 `UrgencyTag`。
   * 两枚标签读的是同一个 `evaluateReminder` 结果，不会互相矛盾。
   */
  badge?: 'stock' | 'urgency';
  style?: StyleProp<ViewStyle>;
};

/** 圆形按钮直径，44 满足最小可点区域 */
const QUICK_SIZE = 44;

/**
 * 「预计耗尽日」文案。
 * 刻意区分三种「没有确切日期」的情况，而不是统一显示空白或假的日期：
 * 还没开始统计 ≠ 今天就用完 ≠ 已经用完。
 */
function resolveRunOutText(item: Item, prediction: Prediction): string {
  if (item.stock <= 0) return '库存已用完';
  if (prediction.runOutDate === null) return '用量数据积累中';
  if (prediction.remainingDays === 0) return '今天可能用完';
  return `预计 ${formatDateCN(prediction.runOutDate)} 用完`;
}

export function ItemCard({
  item,
  prediction,
  onPress,
  onQuickConsume,
  badge = 'stock',
  style,
}: ItemCardProps) {
  const theme = useTheme();

  const level = resolveStockLevel({ item, prediction });
  const fill = resolveStockFill({ prediction, safetyStock: item.safetyStock });
  const barColor = theme[STOCK_LEVEL_BAR_COLORS[level]];
  const runOutText = resolveRunOutText(item, prediction);
  // 仅在需要时才多算一次（进度条颜色始终需要 level，所以 level 无条件计算）
  const urgencyPriority =
    badge === 'urgency' ? resolveUrgencyPriority({ item, prediction }) : null;

  const quickDisabled = item.stock <= 0;
  const stockText = formatStock(item.stock, item.unit);
  // 整卡按压态：背景层负责探测，样式提上来作用到整卡（和旧版整卡 0.7 透明度一致）
  const [cardPressed, setCardPressed] = useState(false);

  return (
    <View style={[styles.card, cardPressed && onPress ? styles.pressed : null, style]}>
      {/* 背景层：整卡可点，压在最底层；卡片底色与按压变暗都归它 */}
      <Pressable
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={`${item.name}，库存 ${stockText}，${runOutText}`}
        disabled={!onPress}
        onPress={onPress}
        onPressIn={() => setCardPressed(true)}
        onPressOut={() => setCardPressed(false)}
        style={[styles.backdrop, { backgroundColor: theme.backgroundElement }]}
      />

      {/* 内容层：纯展示。pointerEvents="none" 让触摸穿透到背景层，主体区域才不会变成死区 */}
      <View style={styles.main} pointerEvents="none">
        <ThemedText numberOfLines={1} style={styles.name}>
          {item.name}
        </ThemedText>

        <ThemedText numberOfLines={1} style={styles.stock}>
          {stockText}
        </ThemedText>

        <View style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
          <View style={[styles.fill, { flexGrow: fill, backgroundColor: barColor }]} />
          {/* 右侧留白段：flexGrow 恒为 1-fill，两段之和为 1，比例才准确 */}
          <View style={[styles.fill, { flexGrow: 1 - fill }]} />
        </View>

        <View style={styles.footer}>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={1}
            style={styles.footerText}>
            {runOutText}
          </ThemedText>
          {badge === 'urgency' ? (
            <UrgencyTag priority={urgencyPriority} compact />
          ) : (
            <StockBadge level={level} compact />
          )}
        </View>
      </View>

      {/* 圆形按钮：普通兄弟节点，绘制在背景层之上，触摸天然只归它一个 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.name} 用一次`}
        accessibilityState={{ disabled: quickDisabled }}
        disabled={quickDisabled}
        onPress={onQuickConsume}
        style={({ pressed }) => [
          styles.quick,
          pressed && !quickDisabled ? styles.pressed : null,
          quickDisabled ? styles.disabled : null,
        ]}>
        <View style={[styles.quickCircle, { backgroundColor: theme.backgroundSelected }]}>
          <SymbolView
            name={{ ios: 'minus', android: 'remove', web: 'remove' }}
            size={20}
            tintColor={theme.text}
          />
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.quickLabel}>
          用一次
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  // 背景层：铺满整卡。底色在这里，圆角也要带一份（父容器的圆角不裁剪子背景）
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  main: {
    flex: 1,
    gap: Spacing.one,
  },
  name: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 600,
  },
  stock: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  fill: {
    // flexBasis 0 + flexGrow 控制比例，不需要百分比宽度
    flexBasis: 0,
    height: '100%',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginTop: Spacing.half,
  },
  footerText: {
    flexShrink: 1,
  },
  quick: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
  },
  quickCircle: {
    width: QUICK_SIZE,
    height: QUICK_SIZE,
    borderRadius: QUICK_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: {
    fontSize: 11,
    lineHeight: 14,
  },
});
