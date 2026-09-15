import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { SectionCard } from '@/components/common/section-card';
import { MovementRow } from '@/components/items/movement-row';
import { PredictionCard } from '@/components/items/prediction-card';
import { StockBadge } from '@/components/items/stock-badge';
import { resolveStockLevel } from '@/components/items/item-status';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ITEM_CATEGORIES } from '@/constants/categories';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { formatStock } from '@/domain/units';
import { useTheme } from '@/hooks/use-theme';
import { parseItemId, useItemDetail } from '@/hooks/use-item-detail';

const ICON_NOT_FOUND = { ios: 'questionmark.square', android: 'help_outline', web: 'help_outline' } as const;
const ICON_NO_CONSUME = { ios: 'minus.circle', android: 'remove_circle', web: 'remove_circle' } as const;
const ICON_NO_PURCHASE = { ios: 'plus.circle', android: 'add_circle', web: 'add_circle' } as const;

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * 物品详情页。
 *
 * 自上而下：头部（名称 + 库存徽章）→ 预测卡 → 两个主操作 → 三段历史 → 编辑/删除。
 * 页面只做拼装：数据来自 `useItemDetail`，写操作也经它（内部走 repo + store），
 * 判定口径（徽章档位、预测）与列表页复用同一批函数，两个页面不会互相打架。
 */
export default function ItemDetailScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const itemId = parseItemId(params.id);

  const {
    item,
    prediction,
    consumptions,
    purchases,
    adjustments,
    movementCount,
    loading,
    error,
    consumeOnce,
    remove,
  } = useItemDetail(itemId);

  const [consuming, setConsuming] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleConsumeOnce = async () => {
    if (!item || item.stock <= 0) return;
    setConsuming(true);
    try {
      await consumeOnce();
    } finally {
      setConsuming(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await remove();
      setDeleteVisible(false);
      // 列表页获得焦点时会自己显示刷新后的数据（store 已在 remove 里同步）
      router.back();
    } catch (cause) {
      setDeleteVisible(false);
      Alert.alert('删除失败', toErrorMessage(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ThemedView style={styles.screen}>
      {/* 载入完成后用物品名做标题；加载中 / 不存在时用通用标题兜底 */}
      <Stack.Screen options={{ title: item?.name ?? '物品详情' }} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {loading ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator />
          </View>
        ) : !item || !prediction ? (
          <EmptyState
            icon={<SymbolView name={ICON_NOT_FOUND} size={24} tintColor={theme.textSecondary} />}
            title="物品不存在或已删除"
            description={error ?? '它可能刚被删掉，返回上一页看看别的物品'}
            actionLabel="返回"
            onAction={() => router.back()}
          />
        ) : (
          <>
            {/* ---- 头部：名称 + 库存徽章 + 一行概况 ---- */}
            <View style={styles.header}>
              <ThemedText type="subtitle" numberOfLines={2}>
                {item.name}
              </ThemedText>
              <View style={styles.headerMeta}>
                {/* 与列表卡片同口径：resolveStockLevel 内部走 evaluateReminder */}
                <StockBadge level={resolveStockLevel({ item, prediction })} />
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  {formatStock(item.stock, item.unit)}
                  {' · '}
                  {ITEM_CATEGORIES.find(({ key }) => key === item.category)?.label ?? item.category}
                </ThemedText>
              </View>
            </View>

            <PredictionCard prediction={prediction} unit={item.unit} />

            {/* ---- 两个主操作 ---- */}
            <View style={styles.actions}>
              <View style={styles.actionSlot}>
                <AppButton
                  label="用一次"
                  variant="primary"
                  onPress={() => void handleConsumeOnce()}
                  disabled={item.stock <= 0}
                  loading={consuming}
                />
              </View>
              <View style={styles.actionSlot}>
                <AppButton
                  label="补货入库"
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/item/[id]/purchase',
                      params: { id: String(item.id) },
                    })
                  }
                />
              </View>
            </View>

            {/* ---- 消耗历史 ---- */}
            {/* 「手动记录」入口放在这张卡的标题右侧而不是主操作行：
                主行已有「用一次 + 补货入库」两个等宽按钮，再塞一个会挤成三等分；
                手动消耗是低频操作，挂在消耗历史旁边语义也更贴 */}
            <SectionCard
              title="消耗历史"
              description={`最近 ${consumptions.length} 条`}
              action={
                <AppButton
                  label="手动记录"
                  size="small"
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/item/[id]/consume',
                      params: { id: String(item.id) },
                    })
                  }
                />
              }>
              {consumptions.length === 0 ? (
                <EmptyState
                  compact
                  icon={
                    <SymbolView name={ICON_NO_CONSUME} size={20} tintColor={theme.textSecondary} />
                  }
                  title="还没有消耗记录"
                  description="点「用一次」或手动记录后，这里会显示最近的消耗"
                />
              ) : (
                consumptions.map((movement, index) => (
                  <MovementRow
                    key={movement.id}
                    movement={movement}
                    unit={item.unit}
                    hideDivider={index === consumptions.length - 1}
                  />
                ))
              )}
            </SectionCard>

            {/* ---- 购买历史 ---- */}
            <SectionCard title="购买历史" description={`最近 ${purchases.length} 条`}>
              {purchases.length === 0 ? (
                <EmptyState
                  compact
                  icon={
                    <SymbolView name={ICON_NO_PURCHASE} size={20} tintColor={theme.textSecondary} />
                  }
                  title="还没有购买记录"
                  description="点「补货入库」记一笔，之后就能算出月支出"
                />
              ) : (
                purchases.map((movement, index) => (
                  <MovementRow
                    key={movement.id}
                    movement={movement}
                    unit={item.unit}
                    hideDivider={index === purchases.length - 1}
                  />
                ))
              )}
            </SectionCard>

            {/* ---- 库存调整（盘点 / 期初库存） ---- */}
            {/* 没有调整记录就不渲染整张卡：盘点是低频操作，
                常态下多一张空卡片只会稀释另外两张历史卡的密度 */}
            {adjustments.length > 0 ? (
              <SectionCard title="库存调整" description={`最近 ${adjustments.length} 条`}>
                {adjustments.map((movement, index) => (
                  <MovementRow
                    key={movement.id}
                    movement={movement}
                    unit={item.unit}
                    hideDivider={index === adjustments.length - 1}
                  />
                ))}
              </SectionCard>
            ) : null}

            {/* ---- 底部：编辑 / 删除 ---- */}
            <View style={styles.actions}>
              <View style={styles.actionSlot}>
                <AppButton
                  label="编辑"
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/item/[id]/edit',
                      params: { id: String(item.id) },
                    })
                  }
                />
              </View>
              <View style={styles.actionSlot}>
                <AppButton
                  label="删除"
                  variant="danger"
                  onPress={() => setDeleteVisible(true)}
                />
              </View>
            </View>
          </>
        )}
      </ScrollView>

      {/* 删除确认：写清后果（流水数），确认键红色并带 loading，防止连点重复提交 */}
      <ConfirmDialog
        visible={deleteVisible}
        title={`删除「${item?.name ?? ''}」？`}
        message={`该物品的 ${movementCount} 条流水会一并删除，无法恢复。`}
        confirmLabel="删除"
        destructive
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteVisible(false)}
      />
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
  header: {
    gap: Spacing.one,
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionSlot: {
    flex: 1,
  },
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
});
