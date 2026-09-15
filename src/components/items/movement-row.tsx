import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { MovementType, StockMovement } from '@/types/models';
import { diffInCalendarDays, formatClock, formatDateCN, nowMs, startOfDayMs } from '@/utils/date';
import { formatMoney, formatSignedQuantity } from '@/utils/number';

/**
 * 流水行 —— 物品详情页的流水列表项 / 首页的最近动态。
 *
 * 布局：左侧「类型图标 + 类型名 + 时间」，右侧「数量 + 金额」（上下两行，右对齐）。
 *
 * ## props
 * - `movement`：流水（领域模型，来自数据层）。
 * - `unit`：基础计量单位。流水数量与库存同单位，`StockMovement` 里不含单位。
 * - `currencySymbol`：金额前缀，默认 `¥`。设置页可改成别的符号。
 * - `hideDivider`：隐藏底部分隔线。列表最后一行传 true，避免卡片末尾多出一条线。
 * - `style`：外层样式微调。
 *
 * ## 为什么数量和金额放在同一侧的上下两行，而不是硬拆成「中 / 右」两列
 * 金额**只有购买流水才有**。如果做成两列，非购买的行里数量列会往右挤到最边上，
 * 同一个列表里数量的水平位置就会半行靠左、半行靠右，扫读时对不上。
 * 堆叠成右侧一列之后，数量在所有行里都严格同位，金额有就显示、没有就留空。
 *
 * ## 数量的正负号：由类型决定，但不是一律取绝对值
 * 规则来自需求（与 `types/models.ts` 的全局约定一致）：
 * - `consume`  → 强制负号（消耗就是减少）
 * - `purchase` → 强制正号（购买就是增加）
 * - `adjust`   → **保留原符号**：盘点是双向的，可能盘盈也可能盘亏
 * - `discard`  → **保留原符号**：同样是双向调整，不能想当然地当成消耗
 *
 * 所以不能简单地用 `Math.abs()` 统一处理，也不能直接信任 `quantity`
 * ——备份导入这类来源的符号未必可靠，而类型是可信的。两种信息各取一半。
 */
export type MovementRowProps = {
  movement: StockMovement;
  unit: string;
  currencySymbol?: string;
  /** 隐藏底部分隔线，列表最后一行传 true */
  hideDivider?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * 符号名类型直接从组件上取，而不是自己写成 `string`。
 *
 * 自己写 `string` 会失去校验：符号名打错在真机上只会**静默留白**，不报错。
 * 取 `SymbolView` 的 `name` 联合类型后，写错的名称在 `tsc` 阶段就会被拦下。
 */
type SymbolName = ComponentProps<typeof SymbolView>['name'];

/**
 * 流水类型的展示元数据。
 *
 * 图标名必须给全 `ios` / `android` / `web` 三个键：
 * `expo-symbols` 传字符串时**只在 iOS 渲染**，Android / Web 会静默留白。
 * Android / Web 走 Material Symbols，这里选的都是两版符号库里都稳定的名称。
 *
 * 导出出去是为了让将来的流水筛选器 / 月度统计复用同一套文案，
 * 避免「这里叫进货、那里叫购买」。
 */
export const MOVEMENT_TYPE_META: Record<MovementType, { label: string; symbol: SymbolName }> = {
  consume: {
    label: '消耗',
    symbol: { ios: 'minus.circle', android: 'remove_circle', web: 'remove_circle' },
  },
  purchase: {
    label: '进货',
    symbol: { ios: 'plus.circle', android: 'add_circle', web: 'add_circle' },
  },
  adjust: {
    label: '盘点',
    symbol: { ios: 'slider.horizontal.3', android: 'tune', web: 'tune' },
  },
  discard: {
    label: '丢弃',
    symbol: { ios: 'trash', android: 'delete', web: 'delete' },
  },
};

/** 按类型决定显示用的有符号数量，见组件顶部说明 */
function resolveSignedQuantity(movement: StockMovement): number {
  switch (movement.type) {
    case 'consume':
      return -Math.abs(movement.quantity);
    case 'purchase':
      return Math.abs(movement.quantity);
    default:
      // adjust / discard 保留原符号
      return movement.quantity;
  }
}

/**
 * 「今天 14:30」/「昨天 09:05」/「9月10日 20:11」。
 * 近两天用相对说法，更远才报日期 —— 流水列表里绝大多数是最近发生的。
 */
function resolveTimeText(occurredAt: number): string {
  const clock = formatClock(occurredAt);
  const dayDiff = diffInCalendarDays(startOfDayMs(nowMs()), startOfDayMs(occurredAt));
  if (dayDiff === 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `昨天 ${clock}`;
  return `${formatDateCN(occurredAt)} ${clock}`;
}

/**
 * 金额文案，**仅购买流水有**。优先实付总额（记账主体），
 * 没有总额时退化为单价并标出单位 —— 「¥12.50/ml」比一个孤零零的「¥12.50」清楚得多。
 */
function resolveMoneyText(
  movement: StockMovement,
  unit: string,
  currencySymbol: string,
): string | null {
  if (movement.type !== 'purchase') return null;
  if (movement.totalPrice !== null) return formatMoney(movement.totalPrice, currencySymbol);
  if (movement.unitPrice !== null) {
    return `${formatMoney(movement.unitPrice, currencySymbol)}/${unit}`;
  }
  return null;
}

export function MovementRow({
  movement,
  unit,
  currencySymbol = '¥',
  hideDivider = false,
  style,
}: MovementRowProps) {
  const theme = useTheme();
  const meta = MOVEMENT_TYPE_META[movement.type];

  const signedQuantity = resolveSignedQuantity(movement);
  const quantityText = formatSignedQuantity(signedQuantity, unit);
  const timeText = resolveTimeText(movement.occurredAt);
  const moneyText = resolveMoneyText(movement, unit, currencySymbol);

  return (
    // 外层只负责底部分隔线，内层才是行本身 —— 与 FieldRow 的「行 + 分隔线」结构一致
    <View style={style}>
      <View
        accessibilityLabel={`${meta.label} ${quantityText}，${timeText}${
          moneyText ? `，金额 ${moneyText}` : ''
        }`}
        style={styles.row}>
        <View style={[styles.iconCircle, { backgroundColor: theme.backgroundSelected }]}>
          <SymbolView name={meta.symbol} size={18} tintColor={theme.text} />
        </View>

        <View style={styles.main}>
          <ThemedText numberOfLines={1}>{meta.label}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {timeText}
          </ThemedText>
        </View>

        <View style={styles.right}>
          <ThemedText style={styles.quantity}>{quantityText}</ThemedText>
          {moneyText ? (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              {moneyText}
            </ThemedText>
          ) : null}
        </View>
      </View>

      {hideDivider ? null : (
        <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  main: {
    flex: 1,
    gap: Spacing.half,
  },
  right: {
    alignItems: 'flex-end',
    gap: Spacing.half,
    flexShrink: 1,
  },
  quantity: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 600,
  },
});
