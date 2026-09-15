import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/common/empty-state';
import { ItemCard } from '@/components/items/item-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ITEM_CATEGORIES } from '@/constants/categories';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useFilteredItems, useItems, useRefreshOnFocus } from '@/hooks/use-items';
import { useTheme } from '@/hooks/use-theme';
import type { ItemCategory } from '@/types/models';

const ICON_SEARCH = { ios: 'magnifyingglass', android: 'search', web: 'search' } as const;
const ICON_CLEAR = { ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' } as const;
const ICON_ADD = { ios: 'plus', android: 'add', web: 'add' } as const;
const ICON_EMPTY = { ios: 'shippingbox', android: 'inventory_2', web: 'inventory_2' } as const;
const ICON_NO_MATCH = { ios: 'magnifyingglass', android: 'search_off', web: 'search_off' } as const;

/**
 * 库存列表。
 *
 * 结构与首页不同：标题 / 搜索框 / 分类标签固定在顶部不随列表滚动 ——
 * 筛选控件一旦滚出屏幕，用户就得先滑回顶部才能改条件，
 * 在几十件物品的列表里这个来回很烦。
 *
 * 筛选**在内存里做**（见 `useFilteredItems`），不重新查库，
 * 所以敲字是即时的，不会一顿一顿。
 */
export default function InventoryScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { items, predictions, loaded, error, refresh, consumeOnce } = useItems();
  useRefreshOnFocus();

  const [search, setSearch] = useState('');
  const [categories, setCategories] = useState<readonly ItemCategory[]>([]);

  const visibleItems = useFilteredItems(items, { search, categories });
  const hasFilter = search.trim() !== '' || categories.length > 0;
  const initialLoading = !loaded && error === null;

  const toggleCategory = (category: ItemCategory) => {
    setCategories((prev) =>
      prev.includes(category) ? prev.filter((value) => value !== category) : [...prev, category],
    );
  };

  const clearFilters = () => {
    setSearch('');
    setCategories([]);
  };

  return (
    <ThemedView style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <View style={styles.titleRow}>
          <ThemedText type="subtitle">库存</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {loaded ? `${items.length} 件` : ''}
          </ThemedText>
        </View>

        <View style={[styles.searchBox, { backgroundColor: theme.backgroundElement }]}>
          <SymbolView name={ICON_SEARCH} size={18} tintColor={theme.textSecondary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="搜索物品"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {/* Android / Web 没有原生的清除按钮（iOS 的 clearButtonMode 不通用），自己补一个 */}
          {search !== '' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="清除搜索"
              onPress={() => setSearch('')}>
              <SymbolView name={ICON_CLEAR} size={18} tintColor={theme.textSecondary} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}>
          {ITEM_CATEGORIES.map(({ key, label }) => {
            const active = categories.includes(key);
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => toggleCategory(key)}>
                {/*
                  选中态用「反色」而不是换个灰度：主题里没有强调色，
                  仅靠深浅变化在小尺寸胶囊上很难一眼分辨选中与否。
                */}
                <ThemedView type={active ? 'text' : 'backgroundElement'} style={styles.chip}>
                  <ThemedText type="smallBold" themeColor={active ? 'background' : 'textSecondary'}>
                    {label}
                  </ThemedText>
                </ThemedView>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: BottomTabInset + Spacing.six },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {error !== null && loaded ? (
          <Pressable accessibilityRole="button" onPress={() => void refresh()}>
            <ThemedText type="small" themeColor="danger">
              刷新失败，显示的是上次的数据 · 点此重试
            </ThemedText>
          </Pressable>
        ) : null}

        {initialLoading ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator />
          </View>
        ) : error !== null && !loaded ? (
          <EmptyState
            icon={<SymbolView name={ICON_EMPTY} size={24} tintColor={theme.textSecondary} />}
            title="读不到库存数据"
            description={error}
            actionLabel="重试"
            onAction={() => void refresh()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<SymbolView name={ICON_EMPTY} size={24} tintColor={theme.textSecondary} />}
            title="还没有物品"
            description="先建一件常买的东西，之后就能记录消耗、预测什么时候该买"
            actionLabel="新建物品"
            onAction={() => router.push('/item/new')}
          />
        ) : visibleItems.length === 0 ? (
          // 「筛完是空的」和「一件都没有」必须分开说 ——
          // 否则用户会以为自己的数据丢了，而不是筛选条件太严
          <EmptyState
            icon={<SymbolView name={ICON_NO_MATCH} size={24} tintColor={theme.textSecondary} />}
            title="没有匹配的物品"
            description="换个关键词，或者取消分类筛选再看看"
            actionLabel="清除筛选"
            onAction={clearFilters}
          />
        ) : (
          <View style={styles.cardColumn}>
            {visibleItems.map((item) => {
              const prediction = predictions.get(item.id);
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
        )}
      </ScrollView>

      {/* 浮动新建按钮。放在 ScrollView 之外，滚动时不会跟着跑 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新建物品"
        onPress={() => router.push('/item/new')}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: theme.text,
            bottom: BottomTabInset + Spacing.three,
            opacity: pressed ? 0.8 : 1,
          },
        ]}>
        <SymbolView name={ICON_ADD} size={26} tintColor={theme.background} />
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    height: 44,
    borderRadius: Spacing.three,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    // Android 的 TextInput 默认有内边距，会让文字在 44 高的框里偏下
    paddingVertical: 0,
  },
  chipRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  chip: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.four,
  },
  scroll: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.two,
  },
  centerBlock: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
  cardColumn: {
    gap: Spacing.two,
  },
  fab: {
    position: 'absolute',
    right: Spacing.three,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
