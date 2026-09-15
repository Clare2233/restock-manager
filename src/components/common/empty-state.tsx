import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * 空状态占位：图标 + 文案 + 可选按钮。
 *
 * 用途：列表没有数据时（还没有物品 / 清单为空 / 本月没有记录）替代空白页面。
 * 空状态一定要解释**为什么空**以及**下一步做什么**，所以 `description`
 * 和 `actionLabel` 不是装饰，是引导用户走出空状态的关键。
 *
 * 图标通过 `icon` 传入（`ReactNode`）而不是内部写死一套 SymbolView 名称映射：
 * 每个空场景该配什么图标由调用方决定，组件不用背平台差异表。
 * 传入的图标请自行带 `tintColor={theme.textSecondary}`，与整体色调一致。
 *
 * 注意：容器用 `View` 而不是 `ThemedView` —— `ThemedView` 默认会填充
 * `theme.background`，嵌在 `SectionCard`（灰底）里会变成一个突兀的异色方块。
 * 这与模板里 `hint-row.tsx` / `collapsible.tsx` 的做法一致（布局用 View，只有真正的面才用 ThemedView）。
 */

export type EmptyStateProps = {
  /** 主文案，一句话说明当前为什么是空的 */
  title: string;
  /** 补充说明，告诉用户下一步可以做什么 */
  description?: string;
  /** 图标节点（建议用 `SymbolView`，尺寸 24~28） */
  icon?: ReactNode;
  /** 按钮文案；与 `onAction` 同时存在才会渲染按钮 */
  actionLabel?: string;
  onAction?: () => void;
  /** 紧凑模式：内边距更小、标题更小，用于卡片内部的小空状态 */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function EmptyState({
  title,
  description,
  icon,
  actionLabel,
  onAction,
  compact = false,
  style,
}: EmptyStateProps) {
  return (
    <View style={[styles.container, compact ? styles.compact : styles.regular, style]}>
      {icon ? (
        <ThemedView
          type="backgroundElement"
          style={[styles.iconCircle, compact && styles.iconCircleCompact]}>
          {icon}
        </ThemedView>
      ) : null}

      <View style={[styles.textBlock, compact && styles.textBlockCompact]}>
        <ThemedText type={compact ? 'smallBold' : 'default'} style={styles.title}>
          {title}
        </ThemedText>
        {description ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.description}>
            {description}
          </ThemedText>
        ) : null}
      </View>

      {actionLabel && onAction ? (
        <AppButton label={actionLabel} variant="secondary" size="small" onPress={onAction} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  regular: {
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  compact: {
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.two,
    gap: Spacing.two,
  },
  iconCircle: {
    width: Spacing.six,
    height: Spacing.six,
    borderRadius: Spacing.six / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleCompact: {
    width: Spacing.five,
    height: Spacing.five,
    borderRadius: Spacing.five / 2,
  },
  textBlock: {
    alignItems: 'center',
    gap: Spacing.one,
  },
  textBlockCompact: {
    gap: Spacing.half,
  },
  title: {
    textAlign: 'center',
    fontWeight: 600,
  },
  description: {
    textAlign: 'center',
  },
});
