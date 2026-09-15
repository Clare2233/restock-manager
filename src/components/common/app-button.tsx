import { ActivityIndicator, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * 通用按钮。
 *
 * 说明：这个文件不在你列出的 5 个组件里，但 `EmptyState` 的「可选按钮」和
 * `ConfirmDialog` 的确认/取消都需要同一个按钮，先抽出来比在两个文件里各写一遍
 * Pressable + 样式更好维护（后续所有页面也都会用到它）。
 * 如果你希望严格只保留 5 个文件，我可以把它内联回去。
 *
 * 为什么不引入 UI 库：`Pressable` 是 RN 内置件，`activeOpacity` 用 opacity 实现，
 * 全项目统一为「按下时 `opacity: 0.7`」这一种按压反馈，不引入第三方按钮组件。
 *
 * 三种外观：
 * - `primary`   ：反色实心（浅色模式黑底白字 / 深色模式白底黑字）。
 *                 用 `theme.text` + `theme.background` 而不是引入强调色，
 *                 好处是两种模式下对比度天然达标，也和模板的极简黑白风格一致。
 * - `secondary` ：浅灰实心（`backgroundElement`），默认外观，用于「取消」这类非主操作。
 * - `danger`    ：红底白字，仅用于不可逆操作（删除 / 清空）。
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'normal' | 'small';

export type AppButtonProps = {
  /** 按钮文案 */
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** `normal` 高度 48（满足 44pt 最小点击区域），`small` 高度 36 */
  size?: ButtonSize;
  disabled?: boolean;
  /** 显示 loading 并同时禁用点击（异步操作防重复提交） */
  loading?: boolean;
  /** 撑满父容器宽度；并排按钮时配合外层 `flex: 1` 使用 */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function AppButton({
  label,
  onPress,
  variant = 'secondary',
  size = 'normal',
  disabled = false,
  loading = false,
  fullWidth = false,
  style,
  testID,
}: AppButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const backgroundColor =
    variant === 'primary'
      ? theme.text
      : variant === 'danger'
        ? theme.danger
        : theme.backgroundElement;

  const labelColor =
    variant === 'primary' ? theme.background : variant === 'danger' ? theme.onDanger : theme.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={label}
      disabled={isDisabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        size === 'small' ? styles.small : styles.normal,
        fullWidth ? styles.fullWidth : styles.autoWidth,
        { backgroundColor },
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}>
      {loading ? <ActivityIndicator size="small" color={labelColor} /> : null}
      <ThemedText
        type={size === 'small' ? 'smallBold' : 'default'}
        themeColor={
          variant === 'primary' ? 'background' : variant === 'danger' ? 'onDanger' : 'text'
        }
        // 文字颜色已由 themeColor 决定，这里只调字重与居中
        style={[styles.label, size === 'normal' && styles.labelNormal]}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.five,
  },
  normal: {
    paddingVertical: Spacing.three - Spacing.one,
    paddingHorizontal: Spacing.four,
  },
  small: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  autoWidth: {
    alignSelf: 'flex-start',
  },
  label: {
    fontWeight: 600,
    textAlign: 'center',
  },
  labelNormal: {
    fontSize: 16,
    lineHeight: 20,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.7,
  },
});
