import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { EmptyState } from '@/components/common/empty-state';
import { FieldRow } from '@/components/common/field-row';
import { SectionCard } from '@/components/common/section-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { getReadyDatabase } from '@/db/client';
import { recordConsume } from '@/db/repositories/movements.repo';
import { formatStock } from '@/domain/units';
import { itemsStore } from '@/store/items.store';
import { useTheme } from '@/hooks/use-theme';
import { parseItemId, useItemDetail } from '@/hooks/use-item-detail';

const ICON_NOT_FOUND = { ios: 'questionmark.square', android: 'help_outline', web: 'help_outline' } as const;

/**
 * 手动记录消耗（modal 表单）。
 *
 * 输入消耗数量（必填，默认 1）与可选备注，提交调 `movements.repo` 的
 * `recordConsume` —— 数量传正数，repo 内部取负写 consume 流水并重算库存。
 *
 * 页面只做拼装与校验，不碰 SQL；提交成功后：
 * - `itemsStore.refreshItems()` 同步列表缓存（列表页 30 秒新鲜期内不会自己刷新）；
 * - `router.back()` 回详情页，`useItemDetail` 重新聚焦时自动重查，
 *   消耗历史与预测随之更新。
 *
 * 校验时机与 purchase.tsx 一致：点过提交才显示错误，之后随输入实时更新。
 * 除了「大于 0」之外还前置校验「不超过当前库存」—— 数据层同样会拦，
 * 但在这里拦能给出带单位的明确报错，而不是让用户看到一条干巴巴的失败。
 */
export default function ConsumeScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const itemId = parseItemId(params.id);
  const { item, loading, error } = useItemDetail(itemId);

  const [quantityText, setQuantityText] = useState('1');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 空串 → NaN（没填），合法数字 → 数值，其余 → NaN（填错了）
  const parsedQuantity = quantityText.trim() === '' ? Number.NaN : Number(quantityText.trim());

  const errors: { quantity?: string } = {};
  if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    errors.quantity = '请填写大于 0 的数量';
  } else if (item && parsedQuantity > item.stock) {
    errors.quantity = `不能超过当前库存 ${formatStock(item.stock, item.unit)}`;
  }
  const hasErrors = Object.keys(errors).length > 0;
  const errorOf = (): string | undefined => (submitted ? errors.quantity : undefined);

  const handleSubmit = async () => {
    setSubmitted(true);
    if (hasErrors || !item) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const db = await getReadyDatabase();
      await recordConsume(db, {
        itemId: item.id,
        quantity: parsedQuantity,
        note: note.trim() || null,
      });
      // 列表页 30 秒新鲜期内不会自己重查，写完必须显式同步缓存
      await itemsStore.refreshItemsAfterMutation();
      // 回详情页：useItemDetail 重新获得焦点时自动重查，历史与预测都会更新
      router.back();
    } catch (cause) {
      setSubmitError(cause instanceof Error && cause.message ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {loading ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator />
          </View>
        ) : !item ? (
          <EmptyState
            icon={<SymbolView name={ICON_NOT_FOUND} size={24} tintColor={theme.textSecondary} />}
            title="物品不存在或已删除"
            description={error ?? '返回上一页重新进入'}
            actionLabel="返回"
            onAction={() => router.back()}
          />
        ) : (
          <>
            <ThemedText type="small" themeColor="textSecondary">
              给「{item.name}」记一笔消耗，当前库存 {formatStock(item.stock, item.unit)}
            </ThemedText>

            <SectionCard title="消耗信息">
              <FieldRow
                label="消耗数量"
                hint={errorOf() ?? `单位：${item.unit}，支持小数`}
                hintTone={errorOf() ? 'danger' : 'secondary'}>
                <TextInput
                  value={quantityText}
                  onChangeText={setQuantityText}
                  accessibilityLabel="消耗数量"
                  placeholder="1"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="decimal-pad"
                  style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
                />
              </FieldRow>

              {/* 备注是整块多行输入，参照 ItemForm 的 FormBlock 布局：
                  FieldRow 的右侧内容区不撑满，塞多行框会被压成窄条 */}
              <View style={styles.noteBlock}>
                <ThemedText>备注</ThemedText>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  accessibilityLabel="消耗备注"
                  placeholder="例如：擦了一次车，用掉半瓶"
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  style={[
                    styles.input,
                    styles.noteInput,
                    { backgroundColor: theme.backgroundSelected, color: theme.text },
                  ]}
                />
                <ThemedText type="small" themeColor="textSecondary">
                  留空则不记录
                </ThemedText>
              </View>
            </SectionCard>

            <View style={styles.actions}>
              <AppButton label="取消" onPress={() => router.back()} disabled={submitting} style={styles.action} />
              <AppButton
                label="记一笔"
                variant="primary"
                onPress={() => void handleSubmit()}
                loading={submitting}
                style={styles.action}
              />
            </View>

            {submitError ? <ThemedText type="small" themeColor="danger">{submitError}</ThemedText> : null}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    gap: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    lineHeight: 20,
    minWidth: 120,
    textAlign: 'right',
  },
  noteBlock: {
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  noteInput: {
    width: '100%',
    minHeight: 88,
    // Android 下多行输入默认垂直居中，显式顶对齐
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  action: {
    flex: 1,
  },
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
});
