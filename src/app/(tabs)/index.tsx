import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/common/empty-state';
import { SectionCard } from '@/components/common/section-card';
import { ItemCard } from '@/components/items/item-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useItems, useRefreshOnFocus, useRestockEntries } from '@/hooks/use-items';
import { useNotificationPermission } from '@/hooks/use-notification-permission';
import { useTheme } from '@/hooks/use-theme';

/** 「全部物品」概览最多显示几件，再多就交给「查看全部」 */
const OVERVIEW_LIMIT = 5;

// 对象形式给全三个平台：传字符串的话 Android / Web 会静默留白
const ICON_ALL_GOOD = { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' } as const;
const ICON_CART = { ios: 'cart.fill', android: 'shopping_cart', web: 'shopping_cart' } as const;
const ICON_EMPTY = { ios: 'shippingbox', android: 'inventory_2', web: 'inventory_2' } as const;
const ICON_CHEVRON = { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' } as const;

function resolveSubtitle(loaded: boolean, restockCount: number): string {
  if (!loaded) return '正在读取本地库存…';
  if (restockCount === 0) return '暂时没有要买的东西';
  return `有 ${restockCount} 件该补货了`;
}

/**
 * 首页。
 *
 * 三段结构，从上到下按「急迫程度」递减：
 * 1. 今日待补货 —— 只有命中了提醒条件的物品才出现，用 `badge="urgency"` 说明**为什么该买**
 * 2. 购物清单入口 —— 把要买的凑成一趟
 * 3. 全部物品概览 —— 前 5 件，用 `badge="stock"` 说明**还剩多少**
 *
 * 数据全部来自 `useItems`（内部走 store 缓存），页面本身不碰 db / repo。
 */
export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { items, predictions, loading, loaded, error, refresh, consumeOnce } = useItems();
  const restock = useRestockEntries(items, predictions);
  const { permission } = useNotificationPermission();
  useRefreshOnFocus();

  // 「一件数据都还没有、也没出错」才算首屏加载。
  // 不能只看 loading：store 刚挂载时是 idle，用 loading 判断会先闪一下空状态。
  const initialLoading = !loaded && error === null;

  const overview = items.slice(0, OVERVIEW_LIMIT);
  const hasMoreItems = items.length > OVERVIEW_LIMIT;

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.three,
            // 底部留出标签栏的高度，否则最后一张卡片会被标签栏压住
            paddingBottom: BottomTabInset + Spacing.five,
          },
        ]}
        showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <ThemedText type="subtitle">今天</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {resolveSubtitle(loaded, restock.length)}
          </ThemedText>
        </View>

        {/* 已经有数据时刷新失败：不清空列表（那会把可用信息也一起丢掉），只提示一句 */}
        {error !== null && loaded ? (
          <Pressable accessibilityRole="button" onPress={() => void refresh()}>
            <ThemedText type="small" themeColor="danger">
              刷新失败，显示的是上次的数据 · 点此重试
            </ThemedText>
          </Pressable>
        ) : null}

        <SectionCard
          title="今日待补货"
          action={
            restock.length > 0 ? (
              <ThemedText type="smallBold" themeColor="textSecondary">
                {`${restock.length} 件`}
              </ThemedText>
            ) : undefined
          }>
          {/*
            权限被系统关掉时，通知再怎么排都不会响，而这块的标题又写着「今日待补货」——
            用户只会以为「这 App 压根不提醒」。所以在这里明说一句，并给一个直达入口。
            只认 `denied`：未询问时沉默即可，主动要权限是设置页的事。
          */}
          {permission === 'denied' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="打开系统设置开启通知"
              onPress={() => void Linking.openSettings()}
              style={({ pressed }) => [
                styles.noticeBar,
                { backgroundColor: theme.backgroundSelected, opacity: pressed ? 0.7 : 1 },
              ]}>
              <ThemedText type="small" themeColor="danger" style={styles.noticeText}>
                系统通知已关闭，点此开启
              </ThemedText>
              <SymbolView name={ICON_CHEVRON} size={16} tintColor={theme.textSecondary} />
            </Pressable>
          ) : null}

          {initialLoading ? (
            <View style={styles.centerBlock}>
              <ActivityIndicator />
            </View>
          ) : error !== null && !loaded ? (
            <EmptyState
              compact
              title="读不到库存数据"
              description={error}
              actionLabel="重试"
              onAction={() => void refresh()}
            />
          ) : restock.length === 0 ? (
            <EmptyState
              compact
              icon={<SymbolView name={ICON_ALL_GOOD} size={24} tintColor={theme.textSecondary} />}
              title="暂时不用买"
              description="所有物品都在安全库存之上，短期内也用不完"
            />
          ) : (
            <View style={styles.cardColumn}>
              {restock.map(({ item, prediction }) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  prediction={prediction}
                  badge="urgency"
                  onPress={() =>
                    router.push({ pathname: '/item/[id]', params: { id: String(item.id) } })
                  }
                  onQuickConsume={() => void consumeOnce(item.id)}
                />
              ))}
            </View>
          )}
        </SectionCard>

        {/* 快捷入口：这里特意做成整卡可点，而不只是一个文字链接 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开购物清单"
          onPress={() => router.push('/shopping')}
          style={({ pressed }) => [
            styles.entry,
            { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
          ]}>
          <View style={[styles.entryIcon, { backgroundColor: theme.backgroundSelected }]}>
            <SymbolView name={ICON_CART} size={20} tintColor={theme.text} />
          </View>
          <View style={styles.entryText}>
            <ThemedText>购物清单</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              把要买的凑成一趟
            </ThemedText>
          </View>
          {/* 主题里没有强调色，链接一律靠 chevron 表达「可进入」，不引入系统外的蓝 */}
          <SymbolView name={ICON_CHEVRON} size={16} tintColor={theme.textSecondary} />
        </Pressable>

        {loaded && items.length > 0 ? (
          <SectionCard
            title="全部物品"
            action={
              hasMoreItems ? (
                <Pressable accessibilityRole="button" onPress={() => router.push('/inventory')}>
                  <ThemedText type="link" themeColor="textSecondary">
                    查看全部
                  </ThemedText>
                </Pressable>
              ) : undefined
            }>
            <View style={styles.cardColumn}>
              {overview.map((item) => {
                const prediction = predictions.get(item.id);
                // 预测与物品同一次加载产出，理论上不会缺；缺了说明状态不同步，跳过比渲染半张卡片强
                if (!prediction) return null;
                return (
                  <ItemCard
                    key={item.id}
                    item={item}
                    prediction={prediction}
                    onPress={() =>
                    router.push({ pathname: '/item/[id]', params: { id: String(item.id) } })
                  }
                    onQuickConsume={() => void consumeOnce(item.id)}
                  />
                );
              })}
            </View>
          </SectionCard>
        ) : null}

        {loaded && items.length === 0 ? (
          <SectionCard title="全部物品">
            <EmptyState
              icon={<SymbolView name={ICON_EMPTY} size={24} tintColor={theme.textSecondary} />}
              title="还没有物品"
              description="先建一件常买的东西，之后就能记录消耗、预测什么时候该买"
              actionLabel="新建物品"
              onAction={() => router.push('/item/new')}
            />
          </SectionCard>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
  },
  header: {
    gap: Spacing.one,
  },
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
  cardColumn: {
    gap: Spacing.two,
  },
  noticeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
    marginBottom: Spacing.three,
  },
  noticeText: {
    flexShrink: 1,
  },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  entryIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryText: {
    flex: 1,
    gap: Spacing.half,
  },
});
