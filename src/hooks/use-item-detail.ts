import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { getReadyDatabase } from '@/db/client';
import { deleteItem, getItemById } from '@/db/repositories/items.repo';
import {
  countMovementsByItem,
  listConsumptionSamples,
  listMovementsByItem,
} from '@/db/repositories/movements.repo';
import { predictItem, type Prediction } from '@/domain/prediction';
import { itemsStore } from '@/store/items.store';
import type { Item, StockMovement } from '@/types/models';
import { nowMs, startOfDayMs, subDaysMs } from '@/utils/date';

/** 消耗 / 购买历史各显示最近几条 */
export const HISTORY_LIMIT = 5;

/**
 * 物品详情页的数据入口 —— 页面**只**通过它拿数据，不直接碰 db / repo。
 *
 * 与列表页的 `use-items` 不同，详情页**不走 store 缓存**，每次都直查：
 * - 详情页是「写操作的落点」（消耗 / 补货 / 编辑 / 删除都从这里发起），
 *   写完必须看到最新数据，缓存新鲜期反而碍事；
 * - 查询范围只有一个物品，4 条小查询（物品 / 样本 / 两段流水 / 总数）开销可忽略，
 *   不值得为它维护第二份缓存和失效逻辑。
 *
 * 返回值比最小约定多了几项，都是页面拼装时实际需要的：
 * - `consumptions` / `purchases` 分开返回：两张历史卡各自渲染；
 * - `movementCount`：删除确认弹窗要写清「N 条流水会一并删除」；
 * - `error`：加载失败时页面提示用；
 * - `consumeOnce` / `remove`：详情页的两个写操作，写完各自负责同步
 *   store 缓存（列表页才能立刻看到结果）。
 *
 * 加载时机用 `useFocusEffect`：首次挂载和每次获得焦点都重新查一遍。
 * 刻意不再叠加 30 秒新鲜期判断 —— 见上，详情页要的就是「永远最新」。
 */
export interface ItemDetailResult {
  item: Item | null;
  prediction: Prediction | null;
  /** 消耗类流水（consume + discard，都让库存变少），时间倒序，最近 HISTORY_LIMIT 条 */
  consumptions: readonly StockMovement[];
  /** 购买流水，时间倒序，最近 HISTORY_LIMIT 条 */
  purchases: readonly StockMovement[];
  /** 盘点类流水（adjust，含「期初库存」），时间倒序，最近 HISTORY_LIMIT 条 */
  adjustments: readonly StockMovement[];
  /** 该物品全部流水的总数（含历史卡没展示的），删除确认弹窗用 */
  movementCount: number;
  /** 首次加载中。刷新时保持 false，页面不会闪回加载态 */
  loading: boolean;
  error: string | null;
  /** 重新查库（写操作之后、下拉刷新时用） */
  refresh: () => Promise<void>;
  /**
   * 「用一次」快捷扣减：走 store 的同一入口（列表页按钮与这里是同一条代码路径），
   * 写完同步刷新详情页自己的数据。失败不抛异常（store 内部已兜住，原因进其 error）。
   */
  consumeOnce: () => Promise<void>;
  /**
   * 删除当前物品。**会抛异常**，由页面决定怎么呈现失败（确认弹窗里转 loading）。
   * 删除成功后同步刷新 store，返回列表页时立刻生效，不会看到已删的物品。
   */
  remove: () => Promise<void>;
}

/** 路由参数里的 id 是字符串，先收敛成合法的整数主键，非法一律视为「查不到」 */
export function parseItemId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function useItemDetail(itemId: number | null): ItemDetailResult {
  const [item, setItem] = useState<Item | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [consumptions, setConsumptions] = useState<readonly StockMovement[]>([]);
  const [purchases, setPurchases] = useState<readonly StockMovement[]>([]);
  const [adjustments, setAdjustments] = useState<readonly StockMovement[]>([]);
  const [movementCount, setMovementCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 「先发后到」保护：连续快速刷新时，旧响应不得覆盖新数据（与 items.store 同一套做法）
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    if (itemId === null) {
    setItem(null);
    setPrediction(null);
    setConsumptions([]);
    setPurchases([]);
    setAdjustments([]);
    setMovementCount(0);
      setLoading(false);
      return;
    }

    const token = ++loadToken.current;
    try {
      const db = await getReadyDatabase();
      const fetched = await getItemById(db, itemId);
      if (token !== loadToken.current) return;

      if (!fetched) {
        setItem(null);
        setPrediction(null);
        setConsumptions([]);
        setPurchases([]);
        setAdjustments([]);
        setMovementCount(0);
        setError(null);
        setLoading(false);
        return;
      }

      // 预测窗口起点：与 items.store 的 sampleWindowStart 同一套算法（窗口含今天），
      // 少捞的样本是 bug，多捞的会被 computeConsumptionStats 自己过滤掉，所以窗口只取不省
      const now = nowMs();
      const windowDays = Math.max(1, fetched.avgWindowDays);
      const windowStartMs = startOfDayMs(subDaysMs(startOfDayMs(now), windowDays - 1));

      const [samples, consumeRows, purchaseRows, adjustRows, total] = await Promise.all([
        listConsumptionSamples(db, itemId, windowStartMs),
        // 消耗历史含 discard：丢弃同样让库存变少，用户需要知道东西「去哪了」
        listMovementsByItem(db, itemId, { limit: HISTORY_LIMIT, types: ['consume', 'discard'] }),
        listMovementsByItem(db, itemId, { limit: HISTORY_LIMIT, types: ['purchase'] }),
        // 盘点历史含「期初库存」：新建物品时填的期初库存就是一条 adjust 流水，
        // 不展示它的话用户会觉得「明明填了 5 个，历史里却什么都没有」
        listMovementsByItem(db, itemId, { limit: HISTORY_LIMIT, types: ['adjust'] }),
        countMovementsByItem(db, itemId),
      ]);
      if (token !== loadToken.current) return;

      setItem(fetched);
      // 整次加载共用同一个 now，与 store 的做法一致：避免「同屏两个今天」
      setPrediction(predictItem({ item: fetched, samples, now }));
      setConsumptions(consumeRows);
      setPurchases(purchaseRows);
      setAdjustments(adjustRows);
      setMovementCount(total);
      setError(null);
    } catch (cause) {
      if (token !== loadToken.current) return;
      // 已有数据时保留旧内容（宁可略旧，不要整页变错误），只把原因暴露出去
      setError(cause instanceof Error && cause.message ? cause.message : String(cause));
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [itemId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(() => load(), [load]);

  const consumeOnce = useCallback(async () => {
    if (itemId === null) return;
    // store 的入口内部已 try/catch，不会抛；列表页的「用一次」按钮走的就是它
    await itemsStore.consumeItemOnce(itemId);
    await load();
  }, [itemId, load]);

  const remove = useCallback(async () => {
    if (itemId === null) return;
    const db = await getReadyDatabase();
    await deleteItem(db, itemId);
    // 立刻刷新列表缓存：返回列表页时（30 秒新鲜期内）也能看到物品已消失
    await itemsStore.refreshItemsAfterMutation();
  }, [itemId]);

  return {
    item,
    prediction,
    consumptions,
    purchases,
    adjustments,
    movementCount,
    loading,
    error,
    refresh,
    consumeOnce,
    remove,
  };
}
