import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { SectionCard } from '@/components/common/section-card';
import { UrgencyTag } from '@/components/items/urgency-tag';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { formatStock } from '@/domain/units';
import { useTheme } from '@/hooks/use-theme';
import type { RestockEntry } from '@/hooks/use-items';
import { useShoppingList } from '@/hooks/use-shopping-list';
import type { ShoppingListItem, ShoppingResolvedStatus } from '@/types/models';
import { formatDateCN } from '@/utils/date';

const ICON_CART = { ios: 'cart', android: 'shopping_cart', web: 'shopping_cart' } as const;

const RESOLVED_LABELS: Record<ShoppingResolvedStatus, string> = {
  bought: '已买',
  skipped: '已跳过',
};

/**
 * 购物清单页（独立 Stack 页，/shopping）。
 *
 * 自上而下：建议购买（自动条目）→ 手写待买条目 → 已买/已跳过的历史。
 * 页面只做拼装：数据与动作全部来自 `useShoppingList`（内部走 store + repo），
 * 判定口径复用领域层的 `evaluateReminder`，与首页「今日待补货」必然一致。
 *
 * 自动条目**不落库**（策略 1，见 shopping.repo.ts）：由预测实时算出，
 * 只有用户操作过的 bought / skipped 才写入抑制记录。
 *
 * 「已买」的动作链：先落 bought 抑制记录（条目立即从自动列表消失），
 * 再跳该物品的补货入库 modal（/item/[id]/purchase，与详情页同一个表单）。
 * 用户在 modal 里取消也没关系 —— 入库后物品不再命中提醒条件，条目照样
 * 不会回来；真没买就清空历史，物品会重新出现。
 */
export default function ShoppingScreen() {
  const theme = useTheme();
  const {
    loading,
    loaded,
    error,
    autoEntries,
    pendingManual,
    history,
    acting,
    skipAuto,
    markBoughtAuto,
    resolveManual,
    clearHistory,
  } = useShoppingList();

  const [clearVisible, setClearVisible] = useState(false);

  const handleBought = async (entry: RestockEntry) => {
    await markBoughtAuto(entry);
    // 抑制记录已落库，跳补货表单让用户顺手入库（数量建议已按整包取整）
    router.push({
      pathname: '/item/[id]/purchase',
      params: { id: String(entry.item.id) },
    });
  };

  const showSpinner = loading && !loaded;
  const isEmpty =
    !showSpinner && autoEntries.length === 0 && pendingManual.length === 0 && history.length === 0;

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        {showSpinner ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator />
          </View>
        ) : isEmpty ? (
          <EmptyState
            icon={<SymbolView name={ICON_CART} size={24} tintColor={theme.textSecondary} />}
            title="清单还是空的"
            description="命中补货条件的物品会自动出现在这里；也可以去物品详情页点「补货入库」提前囤货。"
          />
        ) : (
          <>
            {error ? (
              <ThemedText type="small" themeColor="danger">
                {error}
              </ThemedText>
            ) : null}

            {/* ---- 建议购买（自动条目） ---- */}
            {autoEntries.length > 0 ? (
              <SectionCard title="建议购买" description={`${autoEntries.length} 件物品命中补货条件`}>
                {autoEntries.map((entry) => (
                  <AutoEntryRow
                    key={entry.item.id}
                    entry={entry}
                    acting={acting}
                    onBought={() => void handleBought(entry)}
                    onSkip={() => void skipAuto(entry)}
                  />
                ))}
              </SectionCard>
            ) : history.length > 0 || pendingManual.length > 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                暂时没有要买的东西
              </ThemedText>
            ) : null}

            {/* ---- 手写待买条目 ---- */}
            {/* 本期没有手动添加的入口，这个区只为导入 / 种子数据兜底；
                没有条目就不渲染，避免常态下多一张空卡 */}
            {pendingManual.length > 0 ? (
              <SectionCard title="自己记的" description={`${pendingManual.length} 条待买`}>
                {pendingManual.map((row) => (
                  <ManualEntryRow
                    key={row.id}
                    row={row}
                    acting={acting}
                    onBought={() => void resolveManual(row, 'bought')}
                    onSkip={() => void resolveManual(row, 'skipped')}
                  />
                ))}
              </SectionCard>
            ) : null}

            {/* ---- 历史 ---- */}
            {history.length > 0 ? (
              <SectionCard
                title="已买 / 已跳过"
                description={`${history.length} 条记录`}
                action={
                  <AppButton
                    label="清空"
                    size="small"
                    onPress={() => setClearVisible(true)}
                  />
                }>
                {history.map((row) => (
                  <HistoryRow key={`h-${row.id}`} row={row} />
                ))}
              </SectionCard>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* 清空历史 = 删除全部 bought/skipped 记录（含自动抑制 + 手写），
          不可恢复，所以和删除物品一样走确认弹窗；
          清空后仍命中提醒的物品会重新出现在「建议购买」里 */}
      <ConfirmDialog
        visible={clearVisible}
        title="清空历史？"
        message={`已买和已跳过的 ${history.length} 条记录会被删除，仍需补货的物品会重新出现在清单里。`}
        confirmLabel="清空"
        destructive
        onConfirm={() => {
          setClearVisible(false);
          void clearHistory();
        }}
        onCancel={() => setClearVisible(false)}
      />
    </ThemedView>
  );
}

// ---------------------------------------------------------------------------
// 行组件：只做展示，动作由页面接住再转给 hook
// ---------------------------------------------------------------------------

function AutoEntryRow({
  entry,
  acting,
  onBought,
  onSkip,
}: {
  entry: RestockEntry;
  acting: string | null;
  onBought: () => void;
  onSkip: () => void;
}) {
  const { item, decision } = entry;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitle}>
          <ThemedText numberOfLines={1} style={styles.flex}>
            {item.name}
          </ThemedText>
          {/* UrgencyTag 的文案来自领域层，与用户收到的通知同一套措辞 */}
          <UrgencyTag priority={decision.priority} compact />
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          建议买 {formatStock(decision.suggestedQty, item.unit)}
        </ThemedText>
      </View>
      <View style={styles.rowActions}>
        <AppButton
          label="已买"
          size="small"
          variant="primary"
          loading={acting === `auto-${item.id}`}
          disabled={acting !== null && acting !== `auto-${item.id}`}
          onPress={onBought}
        />
        <AppButton
          label="跳过"
          size="small"
          disabled={acting !== null && acting !== `auto-${item.id}`}
          onPress={onSkip}
        />
      </View>
    </View>
  );
}

function ManualEntryRow({
  row,
  acting,
  onBought,
  onSkip,
}: {
  row: ShoppingListItem;
  acting: string | null;
  onBought: () => void;
  onSkip: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <ThemedText numberOfLines={1}>{row.name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {formatStock(row.quantity, row.unit ?? '')}
        </ThemedText>
      </View>
      <View style={styles.rowActions}>
        <AppButton
          label="已买"
          size="small"
          variant="primary"
          loading={acting === `manual-${row.id}`}
          disabled={acting !== null && acting !== `manual-${row.id}`}
          onPress={onBought}
        />
        <AppButton
          label="跳过"
          size="small"
          disabled={acting !== null && acting !== `manual-${row.id}`}
          onPress={onSkip}
        />
      </View>
    </View>
  );
}

function HistoryRow({ row }: { row: ShoppingListItem }) {
  const status = row.status === 'pending' ? null : RESOLVED_LABELS[row.status];
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <ThemedText numberOfLines={1}>{row.name}</ThemedText>
        {row.resolvedAt !== null ? (
          <ThemedText type="small" themeColor="textSecondary">
            {formatDateCN(row.resolvedAt)}
          </ThemedText>
        ) : null}
      </View>
      {status !== null ? (
        <ThemedText type="small" themeColor="textSecondary">
          {status}
        </ThemedText>
      ) : null}
    </View>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  rowMain: {
    flex: 1,
    gap: Spacing.half,
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  flex: {
    flexShrink: 1,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
});
