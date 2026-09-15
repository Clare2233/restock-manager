import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * 带标题的分组卡片容器。
 *
 * 用途：把一组相关内容（如「即将用完」「本月支出」）视觉上框在一起，
 * 是各页面的主要排版单元。
 *
 * 取舍说明：
 * - 用**填充色**（`backgroundElement`）而不是描边来区分卡片层级 ——
 *   模板里所有面都是「圆角实心块」，没有任何 border，保持一致；
 * - 标题固定 16/600。没有用 `ThemedText type="subtitle"`（32px），
 *   那个尺寸在卡片里过大，是给页面大标题用的。
 */

export type SectionCardProps = {
  /** 卡片标题；不传则只渲染内容（此时也没有内边距修正） */
  title?: string;
  /** 标题下方的说明文案 */
  description?: string;
  /** 标题右侧操作区（如「全部」「添加」按钮、数量角标） */
  action?: ReactNode;
  children: ReactNode;
  /**
   * 内容区去掉内边距。内部是「整行列表」（配合 `FieldRow` / 分隔线）时用它，
   * 否则行跟卡片边缘之间会多出一层 padding，点按区域的视觉边界会很奇怪。
   */
  flush?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function SectionCard({
  title,
  description,
  action,
  children,
  flush = false,
  style,
}: SectionCardProps) {
  const hasHeader = Boolean(title) || Boolean(action);

  return (
    <ThemedView type="backgroundElement" style={[styles.card, style]}>
      {hasHeader ? (
        <View style={[styles.header, flush && styles.headerSpacing]}>
          <View style={styles.headerText}>
            {title ? <ThemedText style={styles.title}>{title}</ThemedText> : null}
            {description ? (
              <ThemedText type="small" themeColor="textSecondary">
                {description}
              </ThemedText>
            ) : null}
          </View>
          {action}
        </View>
      ) : null}

      <View style={flush ? undefined : styles.body}>{children}</View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  // flush 模式下卡片没有内边距，标题自己补上，内容区才能贴边
  headerSpacing: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    marginBottom: 0,
  },
  headerText: {
    flexShrink: 1,
    gap: Spacing.half,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    lineHeight: 22,
  },
  body: {
    marginTop: Spacing.three,
  },
});
