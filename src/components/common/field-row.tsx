import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * 表单行：左侧 label + 右侧内容 + 可选副文案。
 *
 * 用途：详情页的「属性 → 值」展示行，以及编辑表单里「标签 + 输入控件」的行布局。
 * 它只管**布局**，输入控件本身由调用方通过 `children` 传入（TextField / Switch / Picker 都行）。
 *
 * 行为约定：
 * - 内容优先取 `children`，没有则渲染 `value`（`value` 适合纯文本/数字）；
 * - 传了 `onPress` 整行可点击，并默认在右侧显示箭头（`showChevron` 可强制开关）；
 * - `disabled` 时整行变淡且点不动，用于「后台正在忙」（导出/清空进行中）。
 *   不隐藏行是为了保持列表稳定 —— 行数忽多忽少会让别的行上下跳动；
 * - `hint` 在整行下方左对齐，用于补充说明或校验错误；
 * - 分隔线默认显示，**列表最后一行请传 `hideDivider`**，否则卡片底部会多一条悬空线。
 *
 * 分隔线用 `theme.backgroundSelected`（模板里已有的略深中性色），
 * 而不是新增 border token —— 深浅两种模式下都比底色深一档，刚好够用。
 */

export type FieldRowProps = {
  label: string;
  /** 右侧自定义内容（输入框、开关等） */
  children?: ReactNode;
  /** 右侧纯文本值；`children` 优先 */
  value?: ReactNode;
  /** 行下方的副文案 */
  hint?: string;
  /**
   * 副文案的语气。
   * `danger` 用于表单校验错误 —— 错误和帮助文案共用同一行位置，
   * 只有颜色不同，所以用同一个 `hint` 通道 + 一个语气参数，
   * 比再开一个 `error` prop 更不容易出现「两个都传」的矛盾状态。
   */
  hintTone?: 'secondary' | 'danger';
  onPress?: () => void;
  /** 禁用点击（比 `onPress` 不存在更强的表态：行还在，只是这一刻点不了） */
  disabled?: boolean;
  /** 是否显示右侧箭头；默认跟随 `onPress` 是否存在 */
  showChevron?: boolean;
  /** 隐藏底部分隔线（列表最后一行用） */
  hideDivider?: boolean;
  /** label 左侧的图标节点 */
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function FieldRow({
  label,
  children,
  value,
  hint,
  hintTone = 'secondary',
  onPress,
  disabled = false,
  showChevron,
  hideDivider = false,
  icon,
  style,
}: FieldRowProps) {
  const theme = useTheme();
  const withChevron = showChevron ?? Boolean(onPress);

  const body = (
    <>
      <View style={styles.labelBlock}>
        {icon}
        <ThemedText style={styles.label}>{label}</ThemedText>
      </View>

      <View style={styles.contentBlock}>
        {children ?? (value !== undefined ? <ThemedText>{value}</ThemedText> : null)}
        {withChevron ? (
          <SymbolView
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            size={12}
            tintColor={theme.textSecondary}
          />
        ) : null}
      </View>
    </>
  );

  return (
    <View style={[styles.wrapper, style]}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [
            styles.row,
            pressed && !disabled && styles.pressed,
            disabled && styles.disabled,
          ]}>
          {body}
        </Pressable>
      ) : (
        <View style={styles.row}>{body}</View>
      )}

      {hint ? (
        <ThemedText
          type="small"
          themeColor={hintTone === 'danger' ? 'danger' : 'textSecondary'}
          style={styles.hint}>
          {hint}
        </ThemedText>
      ) : null}

      {hideDivider ? null : (
        <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  labelBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  label: {
    flexShrink: 1,
  },
  contentBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  hint: {
    marginTop: -Spacing.one,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
});
