import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * 确认对话框：删除 / 清空等不可逆操作前复用。
 *
 * 用 RN 内置的 `Modal`，不引入任何 UI 库。
 *
 * 几个细节都是有意为之：
 * - `onRequestClose` 必须接上，否则 Android 物理返回键无法关闭弹窗（RN 会报警告且行为异常）；
 * - 点击遮罩关闭：默认开启，但 `loading` 时强制关闭，避免用户在异步操作中途退出导致状态错乱；
 * - 确认键在 `loading` 时自动禁用（`AppButton` 内部处理），防止重复提交；
 * - 卡片底色用 `ThemedView` 默认的 `background`（浅色白 / 深色黑），
 *   与半透明遮罩之间在两种模式下都有足够对比度，不会出现「弹窗糊在背景上」。
 */

export type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  /** 详细说明，建议写清后果（如「该物品的 32 条流水会一并删除」） */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 不可逆操作用红色确认键 */
  destructive?: boolean;
  /** 确认操作进行中：确认键转 loading，取消与遮罩点击暂时失效 */
  loading?: boolean;
  /** 点击遮罩是否关闭，默认 true */
  dismissOnBackdropPress?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  style?: StyleProp<ViewStyle>;
};

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  destructive = false,
  loading = false,
  dismissOnBackdropPress = true,
  onConfirm,
  onCancel,
  style,
}: ConfirmDialogProps) {
  const canDismissByBackdrop = dismissOnBackdropPress && !loading;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        {/* 遮罩单独一层，避免点击卡片内部冒泡触发关闭 */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={canDismissByBackdrop ? onCancel : undefined}
          accessibilityRole="button"
          accessibilityLabel="关闭对话框"
        />

        <ThemedView
          accessibilityViewIsModal
          style={[styles.card, style]}>
          <View style={styles.textBlock}>
            <ThemedText style={styles.title}>{title}</ThemedText>
            {message ? (
              <ThemedText type="small" themeColor="textSecondary">
                {message}
              </ThemedText>
            ) : null}
          </View>

          <View style={styles.actions}>
            <View style={styles.actionSlot}>
              <AppButton
                label={cancelLabel}
                variant="secondary"
                onPress={onCancel}
                disabled={loading}
                fullWidth
              />
            </View>
            <View style={styles.actionSlot}>
              <AppButton
                label={confirmLabel}
                variant={destructive ? 'danger' : 'primary'}
                onPress={onConfirm}
                loading={loading}
                fullWidth
              />
            </View>
          </View>
        </ThemedView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  card: {
    width: '100%',
    maxWidth: 340,
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.four,
  },
  textBlock: {
    gap: Spacing.two,
  },
  title: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: 600,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionSlot: {
    flex: 1,
  },
});
