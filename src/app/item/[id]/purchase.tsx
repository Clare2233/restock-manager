import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { EmptyState } from '@/components/common/empty-state';
import { FieldRow } from '@/components/common/field-row';
import { SectionCard } from '@/components/common/section-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { getReadyDatabase } from '@/db/client';
import { recordPurchase } from '@/db/repositories/movements.repo';
import { itemsStore } from '@/store/items.store';
import { useTheme } from '@/hooks/use-theme';
import { parseItemId, useItemDetail } from '@/hooks/use-item-detail';
import type { Millis } from '@/types/models';
import { fromISODate, isValidISODate, nowMs, startOfDayMs, subDaysMs, toISODate } from '@/utils/date';

const ICON_NOT_FOUND = { ios: 'questionmark.square', android: 'help_outline', web: 'help_outline' } as const;

/**
 * 补货入库（modal 表单）。
 *
 * 输入购买数量（必填）、单价 / 总价（二选一或都填）、购买日期（默认今天），
 * 提交调 `movements.repo` 的 `recordPurchase` —— 它内部负责：
 * 写一条 purchase 流水、重算库存、更新参考单价（last_price）、
 * 只填单价时自动补总价（月支出统计的口径）。
 *
 * 页面只做拼装与校验，不碰 SQL；提交成功后：
 * - `itemsStore.refreshItems()` 同步列表缓存（列表页 30 秒新鲜期内不会自己刷新）；
 * - `router.back()` 回详情页，`useItemDetail` 在重新获得焦点时自动重查，
 *   购买历史与预测随之更新，无需手动传值。
 */
export default function PurchaseScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const itemId = parseItemId(params.id);
  const { item, loading, error } = useItemDetail(itemId);

  const [quantityText, setQuantityText] = useState('1');
  const [unitPriceText, setUnitPriceText] = useState('');
  const [totalPriceText, setTotalPriceText] = useState('');
  const [dateText, setDateText] = useState(() => toISODate(nowMs()));
  // 校验时机与 ItemForm 一致：点过提交才开始显示错误，之后随输入实时更新
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const todayISO = toISODate(nowMs());
  const yesterdayISO = toISODate(subDaysMs(startOfDayMs(nowMs()), 1));

  // ---------------------------------------------------------------------------
  // 校验：空串 → null（没填），合法数字 → 数值，其余 → NaN（填错了）
  // ---------------------------------------------------------------------------
  const parsedQuantity = quantityText.trim() === '' ? Number.NaN : Number(quantityText.trim());
  const parsedUnitPrice =
    unitPriceText.trim() === '' ? null : Number.isFinite(Number(unitPriceText.trim())) ? Number(unitPriceText.trim()) : Number.NaN;
  const parsedTotalPrice =
    totalPriceText.trim() === '' ? null : Number.isFinite(Number(totalPriceText.trim())) ? Number(totalPriceText.trim()) : Number.NaN;

  const validDate = isValidISODate(dateText) ? dateText : null;
  const occurredAt: Millis | null = validDate ? fromISODate(validDate) : null;

  const errors: {
    quantity?: string;
    unitPrice?: string;
    totalPrice?: string;
    date?: string;
  } = {};
  if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    errors.quantity = '请填写大于 0 的数量';
  }
  if (parsedUnitPrice !== null && (!Number.isFinite(parsedUnitPrice) || parsedUnitPrice < 0)) {
    errors.unitPrice = '单价请填 0 或正数';
  }
  if (parsedTotalPrice !== null && (!Number.isFinite(parsedTotalPrice) || parsedTotalPrice < 0)) {
    errors.totalPrice = '总价请填 0 或正数';
  }
  if (!validDate) {
    errors.date = '日期格式是 YYYY-MM-DD，例如 2026-09-14';
  } else if (occurredAt !== null && occurredAt > startOfDayMs(nowMs())) {
    errors.date = '购买日期不能是未来的日期';
  }
  const hasErrors = Object.keys(errors).length > 0;

  const errorOf = (key: keyof typeof errors): string | undefined => (submitted ? errors[key] : undefined);

  const handleSubmit = async () => {
    setSubmitted(true);
    if (hasErrors || !item) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const db = await getReadyDatabase();
      await recordPurchase(db, {
        itemId: item.id,
        quantity: parsedQuantity,
        unitPrice: parsedUnitPrice,
        totalPrice: parsedTotalPrice,
        occurredAt: occurredAt ?? undefined,
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
              给「{item.name}」记一笔采购，库存会按流水重算
            </ThemedText>

            <SectionCard title="补货信息">
              <FieldRow
                label="购买数量"
                hint={errorOf('quantity') ?? `单位：${item.unit}，支持小数`}
                hintTone={errorOf('quantity') ? 'danger' : 'secondary'}>
                <TextInput
                  value={quantityText}
                  onChangeText={setQuantityText}
                  accessibilityLabel="购买数量"
                  placeholder="1"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="decimal-pad"
                  style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
                />
              </FieldRow>

              <FieldRow
                label="单价"
                hint={
                  errorOf('unitPrice') ??
                  `元 / ${item.unit}${
                    item.lastPrice != null ? `，上次 ${item.lastPrice} 元` : ''
                  }；只填单价会自动算总价`
                }
                hintTone={errorOf('unitPrice') ? 'danger' : 'secondary'}>
                <TextInput
                  value={unitPriceText}
                  onChangeText={setUnitPriceText}
                  accessibilityLabel="单价"
                  placeholder="留空则不记"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="decimal-pad"
                  style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
                />
              </FieldRow>

              <FieldRow
                label="总价"
                hint={errorOf('totalPrice') ?? '元；都填时以总价为准，都不填则不记支出'}
                hintTone={errorOf('totalPrice') ? 'danger' : 'secondary'}>
                <TextInput
                  value={totalPriceText}
                  onChangeText={setTotalPriceText}
                  accessibilityLabel="总价"
                  placeholder="留空则不记"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="decimal-pad"
                  style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
                />
              </FieldRow>

              <FieldRow
                label="购买日期"
                hint={errorOf('date') ?? '格式 YYYY-MM-DD，不能是未来'}
                hintTone={errorOf('date') ? 'danger' : 'secondary'}
                hideDivider>
                <TextInput
                  value={dateText}
                  onChangeText={setDateText}
                  accessibilityLabel="购买日期"
                  placeholder="2026-09-14"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="numbers-and-punctuation"
                  style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
                />
              </FieldRow>

              {/* 日期快捷键：最常见的「就是今天 / 昨天买的」一键填入 */}
              <View style={styles.dateShortcuts}>
                {(
                  [
                    { key: todayISO, label: '今天' },
                    { key: yesterdayISO, label: '昨天' },
                  ] as const
                ).map(({ key, label }) => {
                  const selected = dateText === key;
                  return (
                    <Pressable
                      key={label}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setDateText(key)}
                      style={({ pressed }) => [
                        styles.shortcut,
                        { backgroundColor: selected ? theme.text : theme.backgroundSelected },
                        pressed ? styles.pressed : null,
                      ]}>
                      <ThemedText type="small" themeColor={selected ? 'background' : 'text'}>
                        {label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </SectionCard>

            <View style={styles.actions}>
              <AppButton label="取消" onPress={() => router.back()} disabled={submitting} style={styles.action} />
              <AppButton
                label="入库"
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
  dateShortcuts: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingBottom: Spacing.three,
  },
  shortcut: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.five,
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
  pressed: {
    opacity: 0.7,
  },
});
