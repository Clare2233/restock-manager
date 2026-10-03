import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * 修改金额弹窗 —— 给购买流水补记 / 改金额（实付总额）。
 *
 * 样式与交互**照抄 `ConfirmDialog`**（同款 `Modal` + 半透明遮罩 + 双按钮），
 * 只多了中间的输入框：确认弹窗和操作弹窗长得一样，用户不用重新学。
 *
 * ## 为什么只有金额能改
 * 金额是统计属性：只进月支出，不参与库存计算，改它不会让账对不上。
 * 数量改了就必须重算库存，流水记录的「当时发生了什么」也就失真了 ——
 * 所以这里没有数量输入框，想改数量请删掉这条重记。
 *
 * ## 留空 = 清空
 * 空串按「不计入支出」处理（落库为 null），和补货页「留空则不记」是同一口径。
 *
 * ## 键盘
 * iOS 上原生窗口不随键盘收缩，靠 `KeyboardAvoidingView` 把自己顶上去；
 * Android 默认 adjustResize 会自己缩放窗口，再抬一层反而会把「保存」推出屏幕，
 * 所以只在 iOS 上给 behavior（与首页输入框同一套判断）。
 */

export type EditPriceDialogProps = {
  visible: boolean;
  /** 当前金额；null 表示这笔没填金额，输入框预填为空 */
  currentPrice: number | null;
  currencySymbol?: string;
  /** 保存进行中：保存键转 loading，取消与遮罩点击暂时失效 */
  loading?: boolean;
  /** 写库失败的原因，红字显示在输入框下方 */
  error?: string | null;
  /** 传入 null 表示清空金额 */
  onSave: (price: number | null) => void;
  onCancel: () => void;
};

/** 空串 → null（不记支出）；数字 → 数值；其余 → null 并置 invalid */
function parsePrice(text: string): { price: number | null; invalid: boolean } {
  const trimmed = text.trim();
  if (trimmed === '') return { price: null, invalid: false };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { price: null, invalid: true };
  if (parsed < 0) return { price: null, invalid: true };
  return { price: parsed, invalid: false };
}

export function EditPriceDialog({
  visible,
  currentPrice,
  currencySymbol = '¥',
  loading = false,
  error = null,
  onSave,
  onCancel,
}: EditPriceDialogProps) {
  const theme = useTheme();
  // 每次打开都用当前金额重新预填：上次没保存就关掉的话，不该留下上次的输入
  const [text, setText] = useState(currentPrice === null ? '' : String(currentPrice));

  useEffect(() => {
    if (visible) {
      setText(currentPrice === null ? '' : String(currentPrice));
    }
  }, [visible, currentPrice]);

  const { price, invalid } = parsePrice(text);
  const canDismissByBackdrop = !loading;
  const message = invalid ? '请填 0 或正数' : error;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* 遮罩单独一层，避免点击卡片内部冒泡触发关闭 */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={canDismissByBackdrop ? onCancel : undefined}
          accessibilityRole="button"
          accessibilityLabel="关闭对话框"
        />

        <ThemedView accessibilityViewIsModal style={styles.card}>
          <ThemedText style={styles.title}>修改金额</ThemedText>

          <View style={[styles.inputRow, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText themeColor="textSecondary">{currencySymbol}</ThemedText>
            <TextInput
              value={text}
              onChangeText={setText}
              accessibilityLabel="金额"
              placeholder="0.00"
              placeholderTextColor={theme.textSecondary}
              keyboardType="decimal-pad"
              editable={!loading}
              style={[styles.input, { color: theme.text }]}
            />
          </View>

          <ThemedText type="small" themeColor={message ? 'danger' : 'textSecondary'}>
            {message ?? '留空则不计入支出'}
          </ThemedText>

          <View style={styles.actions}>
            <View style={styles.actionSlot}>
              <AppButton
                label="取消"
                variant="secondary"
                onPress={onCancel}
                disabled={loading}
                fullWidth
              />
            </View>
            <View style={styles.actionSlot}>
              <AppButton
                label="保存"
                variant="primary"
                onPress={() => onSave(price)}
                loading={loading}
                disabled={invalid}
                fullWidth
              />
            </View>
          </View>
        </ThemedView>
      </KeyboardAvoidingView>
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
    gap: Spacing.three,
  },
  title: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: 600,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 600,
    padding: 0,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionSlot: {
    flex: 1,
  },
});
