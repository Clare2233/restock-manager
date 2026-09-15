import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ItemForm, type ItemFormValues } from '@/components/items/item-form';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { getReadyDatabase } from '@/db/client';
import { createItem } from '@/db/repositories/items.repo';
import { itemsStore } from '@/store/items.store';

/**
 * 新建物品。
 *
 * 复用 `ItemForm` 的新建模式（不传 `item`）：比编辑模式多一个「当前库存」
 * 输入框，填了会以一条「期初库存」adjust 流水落库（流水是唯一事实来源）。
 * 必填 / 数值校验都在 `ItemForm` 内部完成，这里只做落库与导航：
 *
 * - `createItem` 含事务，返回完整领域模型（这里只需要成功与否）；
 * - 成功后 `itemsStore.refreshItems()` 同步列表缓存，再 `router.back()`
 *   回到来源页（首页空状态或库存页）——物品列表以 store 为准，
 *   不需要把新物品逐层传回去。
 */
export default function NewItemScreen() {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async (values: ItemFormValues) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const db = await getReadyDatabase();
      await createItem(db, values);
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
        <ItemForm onSubmit={(values) => void handleSubmit(values)} submitting={submitting} />

        {submitError ? (
          <ThemedText type="small" themeColor="danger">
            {submitError}
          </ThemedText>
        ) : null}
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
});
