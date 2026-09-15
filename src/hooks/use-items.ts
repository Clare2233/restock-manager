import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { Prediction } from '@/domain/prediction';
import { compareByUrgency, evaluateReminder, type ReminderDecision } from '@/domain/reminder';
import { getDataEpoch } from '@/store/data-epoch';
import { itemsStore, useItemsState } from '@/store/items.store';
import type { Item, ItemCategory } from '@/types/models';
import { nowMs } from '@/utils/date';

/**
 * 物品数据的读取入口 —— 页面**只**通过它拿数据，不直接碰 db / repo。
 *
 * 数据本体缓存在 `store/items.store`，本文件负责三件事：
 * 1. 把 store 的状态翻译成页面好用的形状（`useItems`）；
 * 2. 派生业务视图（`useRestockEntries` 待补货队列）；
 * 3. 派生筛选结果（`useFilteredItems`）。
 */

/**
 * 缓存新鲜期。页面获得焦点时，只有数据比它更旧才重新查库。
 * 取 30 秒是为了「切到别的 tab 再切回来」不白查一遍库，
 * 同时保证「去别的页面记了流水再回来」能立刻看到新数据。
 */
const REFRESH_STALE_MS = 30_000;

export interface UseItemsResult {
  items: readonly Item[];
  predictions: ReadonlyMap<number, Prediction>;
  /** 首次加载中（还没有任何数据可显示）。刷新时保持 false，列表不会闪白 */
  loading: boolean;
  /** 至少成功加载过一次。用它区分「加载中」与「加载完了、确实一件物品都没有」 */
  loaded: boolean;
  /** 最近一次失败原因；`loaded` 为 true 时它是「刷新失败」而非「加载失败」 */
  error: string | null;
  /** 强制重新查库 */
  refresh: () => Promise<void>;
  /** 「用一次」快捷扣减；写完自动刷新，失败原因进 `error` */
  consumeOnce: (itemId: number) => Promise<void>;
}

export function useItems(): UseItemsResult {
  const state = useItemsState();

  useEffect(() => {
    // 首次挂载触发加载。已有缓存时 store 内部直接返回，不会重复查库
    void itemsStore.fetchItems();
  }, []);

  return useMemo(
    () => ({
      items: state.items,
      predictions: state.predictions,
      loading: state.status === 'loading',
      loaded: state.loadedAt !== null,
      error: state.error,
      refresh: itemsStore.refreshItems,
      consumeOnce: itemsStore.consumeItemOnce,
    }),
    [state],
  );
}

/**
 * 页面获得焦点时按需刷新缓存。首页与库存页各调用一次。
 *
 * 为什么必须有：`runOutDate` / `buyDate` 是**加载那一刻**按「今天」算出来的绝对日期。
 * 应用跨过午夜还开着的话，它们会比实际早一天，提醒就会提前一天到。
 * 切回页面时校对一次，把这种漂移收敛掉。
 *
 * 首次加载走 `fetchItems`（带缓存，与 `useItems` 的挂载加载并发去重），
 * 只有数据确实过期才 `refreshItems` 强查 —— 避免挂载瞬间重复查两遍库。
 *
 * ## 上面那条过期判断不够用的时候：数据被**整体替换**
 *
 * 备份导入 / 清空数据走的路径不经过任何写操作，`items.store` 无从知道数据换了。
 * 这时 30 秒的过期判断会放行旧缓存：刚导入完，首页还显示半个月前的物品。
 * 所以这里再比一次 `store/data-epoch` 的世代号 —— 变了就无条件强查。
 */
export function useRefreshOnFocus(): void {
  /**
   * **必须是每个调用方一份，不能是模块级变量**：首页与库存页各调一次这个 hook，
   * 若共用一份「上次看到的世代号」，先聚焦的页面会把这次 bump 消耗掉，
   * 后聚焦的那个页面就永远看不到数据变过了。
   *
   * 初值取「挂载时的世代号」而不是 0：只关心挂载之后发生的变化。
   */
  const seenEpochRef = useRef(getDataEpoch());

  useFocusEffect(
    useCallback(() => {
      const { loadedAt } = itemsStore.getState();

      // 数据被整体替换过 → 缓存一定不该再用
      const currentEpoch = getDataEpoch();
      const dataReplaced = seenEpochRef.current !== currentEpoch;
      seenEpochRef.current = currentEpoch;
      if (dataReplaced) {
        void itemsStore.refreshItems();
        return;
      }

      if (loadedAt === null) {
        void itemsStore.fetchItems();
        return;
      }
      if (nowMs() - loadedAt > REFRESH_STALE_MS) {
        void itemsStore.refreshItems();
      }
    }, []),
  );
}

export interface RestockEntry {
  item: Item;
  prediction: Prediction;
  /** 命中的条件与优先级，来自领域层的 `evaluateReminder` */
  decision: ReminderDecision;
}

/**
 * 首页「今日待补货」队列。
 *
 * 判定完全交给领域层的 `evaluateReminder`（与卡片标签、将来的通知是同一套逻辑），
 * 这里只做过滤 + 排序，不自己写任何阈值：
 * - 过滤 `priority !== null`，即 C1（耗尽日）/ C2（安全库存）/ C3（购买日）至少命中一个
 * - 排序直接用领域层自己的 `compareByUrgency`
 *
 * **刻意不传 `lastFiredAt` / `snoozedUntil`**，与 `resolveUrgencyPriority` 保持一致：
 * 这里表达的是「现在的库存状态」，不是「该不该再推一条通知」。
 * 否则用户点过「稍后提醒」之后，物品会从这个列表里消失，
 * 看起来像库存问题解决了 —— 但它只是被静音了。同理 `now` 也用默认值，
 * 好让这里的判断与 `ItemCard` 内部的标签计算在同一时刻下进行，两者不会打架。
 */
export function useRestockEntries(
  items: readonly Item[],
  predictions: ReadonlyMap<number, Prediction>,
): RestockEntry[] {
  return useMemo(() => {
    const entries: RestockEntry[] = [];
    for (const item of items) {
      const prediction = predictions.get(item.id);
      if (!prediction) continue;
      const decision = evaluateReminder({ item, prediction });
      if (decision.priority === null) continue;
      entries.push({ item, prediction, decision });
    }
    return entries.sort((a, b) => compareByUrgency(a.decision, b.decision));
  }, [items, predictions]);
}

export interface ItemFilters {
  /** 名称模糊匹配；两端空白忽略、大小写不敏感 */
  search?: string;
  /** 选中的分类；空数组或不传 = 不限分类 */
  categories?: readonly ItemCategory[];
}

/**
 * 纯函数版本。`useFilteredItems` 与将来的「按分类统计」都复用它。
 * 多个分类之间是**或**的关系（选中「清洁 + 纸品」= 两类都要看）。
 */
export function filterItems(items: readonly Item[], filters: ItemFilters): Item[] {
  const keyword = filters.search?.trim().toLowerCase() ?? '';
  const categories = filters.categories ?? [];

  return items.filter((item) => {
    if (categories.length > 0 && !categories.includes(item.category)) return false;
    if (keyword === '') return true;
    return item.name.toLowerCase().includes(keyword);
  });
}

/**
 * 库存页的筛选结果。
 *
 * **在内存里筛，不重新查库**：物品总量是「一个家庭的存货」量级，
 * 本地过滤是瞬时的；而每敲一个字都查一次库，输入框会明显发涩。
 * `categories` 请在页面用 state 持有（切换时才换引用），否则每次渲染
 * 都会传进来一个新数组，这里的 memo 会失效。
 */
export function useFilteredItems(items: readonly Item[], filters: ItemFilters): Item[] {
  const { search, categories } = filters;
  return useMemo(
    () => filterItems(items, { search, categories }),
    // categories 由调用方保证引用稳定（只有增删分类时才变）
    [items, search, categories],
  );
}
