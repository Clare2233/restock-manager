import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * 首页底部的 AI 输入框（第四批次）。
 *
 * 位置由调用方决定：**挂在 ScrollView 外面、ThemedView 内部贴底**，
 * 这样内容再多也不会把它顶走。底部留 `BottomTabInset` 是必须的 ——
 * 否则会被标签栏压住一截（Android 的标签栏比 iOS 高，所以这个值是 Platform 相关的）。
 *
 * 交互刻意保持「一句话」的最小形态：
 * - 单行输入，回车即发送（`submitBehavior="submit"` 让键盘显示「发送」键）；
 * - 发送按钮在空输入时禁用，避免用户对着空白发一次请求；
 * - 解析中按钮位置换成转圈，同时输入框禁用 —— 请求进行中再发一次只会得到两张卡片。
 */

const ICON_SEND = { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' } as const;

export type AiInputBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  /** 解析中：转圈并禁用输入 */
  loading: boolean;
  /** 解析失败的提示文案，null = 没有错误 */
  error: string | null;
  /** 卡片展开时收起输入框，避免两层输入叠在一起 */
  hidden?: boolean;
};

export function AiInputBar({
  value,
  onChangeText,
  onSubmit,
  loading,
  error,
  hidden = false,
}: AiInputBarProps) {
  const theme = useTheme();
  const canSend = value.trim() !== '' && !loading;

  if (hidden) return null;

  return (
    <View
      style={[
        styles.wrapper,
        {
          backgroundColor: theme.background,
          borderTopColor: theme.backgroundSelected,
          paddingBottom: BottomTabInset,
        },
      ]}>
      <View style={styles.inner}>
        {error !== null ? (
          <ThemedText type="small" themeColor="danger" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        <View style={styles.row}>
          <TextInput
            value={value}
            onChangeText={onChangeText}
            onSubmitEditing={canSend ? onSubmit : undefined}
            editable={!loading}
            accessibilityLabel="自然语言录入"
            placeholder="说一句，比如「今天用了一卷纸」"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
          />

          {/* 解析中把发送键换成转圈：位置不变，用户不会以为按钮消失了 */}
          {loading ? (
            <View style={styles.sendSlot}>
              <ActivityIndicator size="small" />
              <ThemedText type="small" themeColor="textSecondary">
                解析中…
              </ThemedText>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={onSubmit}
              style={({ pressed }) => [
                styles.send,
                { backgroundColor: canSend ? theme.text : theme.backgroundSelected },
                pressed && canSend ? styles.pressed : null,
              ]}>
              <SymbolView
                name={ICON_SEND}
                size={18}
                tintColor={canSend ? theme.background : theme.textSecondary}
              />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  input: {
    flex: 1,
    borderRadius: Spacing.five,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    lineHeight: 20,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendSlot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one,
  },
  error: {
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.7,
  },
});
