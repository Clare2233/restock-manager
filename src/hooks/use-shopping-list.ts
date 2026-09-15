import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { getReadyDatabase } from '@/db/client';
import {
  clearResolved,
  listAutoOverrides,
  listManualItems,
  setItemStatus,
  upsertAutoOverride,
} from '@/db/repositories/shopping.repo';
import { useItems, useRefreshOnFocus, useRestockEntries, type RestockEntry } from '@/hooks/use-items';
import type { ShoppingListItem, ShoppingResolvedStatus } from '@/types/models';

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * 购物清单页的数据入口 —— 页面**只**通过它拿数据，不直接碰 db / repo。
 *
 * 数据分两路，口径完全不同：
 *
 * 1. **自动条目（不落库，实时算）**：物品与预测来自 `useItems`（store 缓存），
 *    「哪些该买」复用 `useRestockEntries` —— 与首页「今日待补货」、
 *    `UrgencyTag`、补货通知是**同一套** `evaluateReminder` 判定，
 *    这里只额外过滤掉已有抑制记录的物品。建议数量直接用领域层算好的
 *    `decision.suggestedQty`，不在 UI 层重复造公式。
 *
 * 2. **抑制记录 / 手写条目（落库）**：`listAutoOverrides` + `listManualItems`，
 *    用 `useFocusEffect` 每次聚焦都直查（量小、且必须反映刚发生的标记操作）。
 *    `listAutoOverrides` 一次拿全，页面里派生成 Map 过滤 + 历史区展示两用，
 *    不再多查一遍 `getAutoOverrideMap`。
 *
 * 抑制记录（策略 1）的写入口也在这里：
 * - 「已买」→ `upsertAutoOverride(status 'bought')`；页面随后跳补货表单入库。
 *   用户取消入库也没关系：补货后物品不再命中提醒条件，条目照样消失；
 *   真没买的话清空历史就会重新出现 —— 两条路径都不产生幽灵条目。
 * - 「跳过」→ `upsertAutoOverride(status 'skipped')`，条目从自动列表消失。
 * - 清空历史 → `clearResolved`（清掉全部 bought/skipped，含手写条目），
 *   仍命中提醒的物品会重新出现在自动列表，符合「清空 = 重新评估」的直觉。
 */
export interface UseShoppingListResult {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** 自动条目：命中提醒条件且未被抑制，已按紧急度排好序 */
  autoEntries: readonly RestockEntry[];
  /** 手写待买条目（本期没有创建入口，仅导入 / 种子数据可能有） */
  pendingManual: readonly ShoppingListItem[];
  /** 已买 / 已跳过的历史（手写已处理 + 自动抑制记录），时间倒序 */
  history: readonly ShoppingListItem[];
  /** 正在执行操作条目的 key（`auto-N` / `manual-N`），用于按钮防连点 */
  acting: string | null;
  /** 跳过自动条目：落 skipped 抑制记录并刷新 */
  skipAuto: (entry: RestockEntry) => Promise<void>;
  /** 已买自动条目：落 bought 抑制记录并刷新；调用方随后自行跳补货表单 */
  markBoughtAuto: (entry: RestockEntry) => Promise<void>;
  /** 手写条目标记已买 / 已跳过 */
  resolveManual: (row: ShoppingListItem, status: ShoppingResolvedStatus) => Promise<void>;
  /** 清空全部已处理条目（bought / skipped） */
  clearHistory: () => Promise<void>;
}

export function useShoppingList(): UseShoppingListResult {
  const { items, predictions, loading, loaded, error: itemsError } = useItems();
  // 跨午夜时 buyDate 会漂移一天，聚焦时按新鲜期校对一次（与首页 / 库存页同款）
  useRefreshOnFocus();

  const [autoRows, setAutoRows] = useState<readonly ShoppingListItem[]>([]);
  const [manualItems, setManualItems] = useState<readonly ShoppingListItem[]>([]);
  const [dbError, setDbError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const db = await getReadyDatabase();
      const [overrides, manual] = await Promise.all([
        listAutoOverrides(db),
        listManualItems(db),
      ]);
      setAutoRows(overrides);
      setManualItems(manual);
      setDbError(null);
    } catch (cause) {
      setDbError(toErrorMessage(cause));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const overrideItemIds = useMemo(() => {
    const ids = new Set<number>();
    for (const row of autoRows) {
      if (row.itemId !== null) ids.add(row.itemId);
    }
    return ids;
  }, [autoRows]);

  const restockEntries = useRestockEntries(items, predictions);

  const autoEntries = useMemo(
    () => restockEntries.filter((entry) => !overrideItemIds.has(entry.item.id)),
    [restockEntries, overrideItemIds],
  );

  const pendingManual = useMemo(
    () => manualItems.filter((row) => row.status === 'pending'),
    [manualItems],
  );

  const history = useMemo(() => {
    const rows = manualItems.filter((row) => row.status !== 'pending');
    return [...rows, ...autoRows].sort(
      (a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0),
    );
  }, [manualItems, autoRows]);

  const skipAuto = useCallback(
    async (entry: RestockEntry) => {
      const key = `auto-${entry.item.id}`;
      setActing(key);
      try {
        const db = await getReadyDatabase();
        await upsertAutoOverride(db, {
          itemId: entry.item.id,
          name: entry.item.name,
          unit: entry.item.unit,
          quantity: entry.decision.suggestedQty,
          priority: entry.decision.priority ?? 3,
          status: 'skipped',
        });
        await load();
      } catch (cause) {
        setDbError(toErrorMessage(cause));
      } finally {
        setActing(null);
      }
    },
    [load],
  );

  const markBoughtAuto = useCallback(
    async (entry: RestockEntry) => {
      const key = `auto-${entry.item.id}`;
      setActing(key);
      try {
        const db = await getReadyDatabase();
        await upsertAutoOverride(db, {
          itemId: entry.item.id,
          name: entry.item.name,
          unit: entry.item.unit,
          quantity: entry.decision.suggestedQty,
          priority: entry.decision.priority ?? 3,
          status: 'bought',
        });
        await load();
      } catch (cause) {
        setDbError(toErrorMessage(cause));
      } finally {
        setActing(null);
      }
    },
    [load],
  );

  const resolveManual = useCallback(
    async (row: ShoppingListItem, status: ShoppingResolvedStatus) => {
      const key = `manual-${row.id}`;
      setActing(key);
      try {
        const db = await getReadyDatabase();
        await setItemStatus(db, row.id, status);
        await load();
      } catch (cause) {
        setDbError(toErrorMessage(cause));
      } finally {
        setActing(null);
      }
    },
    [load],
  );

  const clearHistory = useCallback(async () => {
    try {
      const db = await getReadyDatabase();
      await clearResolved(db);
      await load();
    } catch (cause) {
      setDbError(toErrorMessage(cause));
    }
  }, [load]);

  return {
    loading,
    loaded,
    error: itemsError ?? dbError,
    autoEntries,
    pendingManual,
    history,
    acting,
    skipAuto,
    markBoughtAuto,
    resolveManual,
    clearHistory,
  };
}
