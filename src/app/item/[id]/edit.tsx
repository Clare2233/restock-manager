import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/common/empty-state';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ItemForm, type ItemFormValues } from '@/components/items/item-form';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { getReadyDatabase } from '@/db/client';
import { updateItemCore } from '@/db/repositories/items.repo';
import { itemsStore } from '@/store/items.store';
import { useTheme } from '@/hooks/use-theme';
import { parseItemId, useItemDetail } from '@/hooks/use-item-detail';

const ICON_NOT_FOUND = { ios: 'questionmark.square', android: 'help_outline', web: 'help_outline' } as const;

/**
 * 编辑物品。
 *
 * 复用 `ItemForm` 的编辑模式（传 `item` 即进入编辑态：不显示期初库存输入、
 * 当前库存只读展示——改库存必须走流水，见 item-form 的说明）。
 * 表单校验（必填、天数、周期）都在 `ItemForm` 内部完成，`onSubmit`
 * 拿到的已是收敛后的 `ItemFormValues`，这里只做落库与导航：
 *
 * - `ItemFormValues` 含 `initialStock`（仅新建模式产出），编辑模式下不会有值，
 *   显式逐字段组装 `UpdateItemInput`，避免把多余字段带进 patch；
 * - `updateItemCore` 只改资料字段，不碰 `stock`（库存的唯一入口是流水）；
 * - 保存成功后 `itemsStore.refreshItems()` 同步列表缓存，再回详情页，
 *   `useItemDetail` 重新聚焦时自动重查。
 */
export default function EditItemScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const itemId = parseItemId(params.id);
  const { item, loading, error } = useItemDetail(itemId);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSave = async (values: ItemFormValues) => {
    if (!item) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const db = await getReadyDatabase();
      await updateItemCore(db, item.id, {
        name: values.name,
        category: values.category,
        unit: values.unit,
        safetyStock: values.safetyStock,
        remindDays: values.remindDays,
        leadDays: values.leadDays,
        estimatedCycleDays: values.estimatedCycleDays,
        note: values.note,
      });
      // 列表页 30 秒新鲜期内不会自己重查，写完必须显式同步缓存
      await itemsStore.refreshItemsAfterMutation();
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
            {/* 编辑对象切换时用 key 强制重挂载，避免残留上一个物品的输入 */}
            <ItemForm key={item.id} item={item} onSubmit={(values) => void handleSave(values)} submitting={submitting} />

            {submitError ? (
              <ThemedText type="small" themeColor="danger">
                {submitError}
              </ThemedText>
            ) : null}
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
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
});
