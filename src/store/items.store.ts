import { useSyncExternalStore } from 'react';

import { getReadyDatabase } from '@/db/client';
import { listItems } from '@/db/repositories/items.repo';
import { listConsumptionSamplesByItem, recordQuickConsume } from '@/db/repositories/movements.repo';
import { maxSampleWindowStart, predictItem, type Prediction } from '@/domain/prediction';
import { scheduleReschedule } from '@/notifications/reschedule-debounce';
import type { Item, Millis } from '@/types/models';
import { nowMs } from '@/utils/date';

/**
 * 物品列表的内存缓存。
 *
 * ## 为什么是手写的，而不是 Zustand
 * 需求里点名要 Zustand，但 `package.json` 里并没有这个依赖，
 * 而本批次的硬性约束是**不引入任何新依赖**。这里用 React 自带的
 * `useSyncExternalStore` 实现，对外形状（`getState` / `subscribe` /
 * 一组 action / 一个 hook）与 Zustand 一致，
 * 将来若真要用 Zustand，改动只发生在本文件内部。
 *
 * `useSyncExternalStore` 而不是「useState + 模块变量」的原因：前者是 React 官方
 * 为「外部可变数据源」设计的订阅原语，天然处理并发渲染下的**撕裂**
 * （同一次渲染里两个组件读到不同版本的数据），手写订阅很容易漏掉这一点。
 *
 * ## 为什么「物品」和「预测」必须放在同一个快照里
 * 预测是由物品字段 + 消耗流水算出来的纯函数结果。若分成两份缓存分别更新，
 * 就会出现「库存已经刷新、预测还是旧的」这种中间态 ——
 * 卡片上的库存数字和「还能用几天」会当场互相矛盾。
 * 所以它们永远在同一次加载里一起产出、一起替换。
 */

export type ItemsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ItemsState {
  /** 全部未归档物品（按用户在物品资料里定的顺序，即 repo 的默认排序） */
  items: readonly Item[];
  /** itemId → 预测结果；与 `items` 同一次加载产出，不会不同步 */
  predictions: ReadonlyMap<number, Prediction>;
  status: ItemsStatus;
  /**
   * 最近一次失败原因。
   * 注意语义会随数据状态变化：没有旧数据时它是「加载失败」，
   * 有旧数据时它是「刷新失败」—— 后者列表仍在，只是内容可能略旧。
   */
  error: string | null;
  /** 最近一次成功加载的时间戳；null = 从未成功过 */
  loadedAt: Millis | null;
}

const INITIAL_STATE: ItemsState = {
  items: [],
  predictions: new Map<number, Prediction>(),
  status: 'idle',
  error: null,
  loadedAt: null,
};

let state: ItemsState = INITIAL_STATE;
const listeners = new Set<() => void>();

/**
 * 加载序号。每次发起加载自增，落库结果回来时若序号已被超出，
 * 说明有更新的加载在路上，本次结果直接丢弃 ——
 * 否则「先发后到」的旧响应会覆盖新数据。
 */
let loadToken = 0;

function emit(next: ItemsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text === 'undefined' || text === '' ? '未知错误' : text;
}

/**
 * 加载物品列表 + 预测。
 *
 * - 已有缓存且 `force` 为 false → 直接返回，不查库（切回 tab 不该重新查一遍）
 * - 首次加载才把 `status` 置为 `'loading'`；后续刷新**静默进行**，
 *   列表不会闪成 loading 态（这是「有缓存」的最大价值）
 */
async function fetchItems(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force) {
    // 已有数据 → 复用缓存；首次加载还在路上 → 并发去重
    if (state.loadedAt !== null || state.status === 'loading') return;
  }

  const token = ++loadToken;

  if (state.loadedAt === null) {
    emit({ ...state, status: 'loading', error: null });
  }

  try {
    const db = await getReadyDatabase();
    const items = await listItems(db);
    // 整批用同一个 now：逐个物品各取一次 nowMs() 的话，
    // 跨越午夜的那一瞬间会出现同一屏里两个物品的「今天」不是同一天
    const now = nowMs();
    const samplesByItem =
      items.length > 0
        ? await listConsumptionSamplesByItem(db, maxSampleWindowStart(items, now))
        : new Map();

    const predictions = new Map<number, Prediction>();
    for (const item of items) {
      predictions.set(
        item.id,
        predictItem({ item, samples: samplesByItem.get(item.id) ?? [], now }),
      );
    }

    if (token !== loadToken) return;
    emit({ items, predictions, status: 'ready', error: null, loadedAt: now });
  } catch (error) {
    if (token !== loadToken) return;
    emit({
      ...state,
      // 有旧数据就继续显示（宁可略旧，也不要整屏变错误页），
      // 只把原因暴露出去让页面决定怎么提示
      status: state.loadedAt === null ? 'error' : 'ready',
      error: toErrorMessage(error),
    });
  }
}

/** 带缓存的加载：没数据才查库 */
export function fetchItemsCached(): Promise<void> {
  return fetchItems();
}

/** 强制重新查库。下拉刷新、进入页面、缓存过期都用它 —— **纯读操作** */
export function refreshItems(): Promise<void> {
  return fetchItems({ force: true });
}

/**
 * **写操作**完成后的统一收尾：刷新列表缓存 + 触发通知重排。
 *
 * 消耗 / 补货 / 新建 / 编辑 / 删除都调它，而不是各自去调 `rescheduleAll`：
 * 重排的触发逻辑（防抖 1.5s、force、失败兜底）只在
 * `@/notifications/reschedule-debounce` 里有一份，页面侧永远只多一行。
 *
 * 刻意**不**挂在 `refreshItems` 上：那也是「下拉刷新 / 30 秒缓存过期」的入口，
 * 那些是纯读操作，不该顺带把预测重算一遍。
 */
export async function refreshItemsAfterMutation(): Promise<void> {
  await refreshItems();
  scheduleReschedule();
}

/**
 * 「用一次」快捷扣减：写流水 → 重算库存 → 重新加载。
 *
 * 不抛异常，失败原因进 `state.error` 由页面统一呈现 ——
 * 这样调用方（卡片上的圆形按钮）不必各自包 try/catch，
 * 也就不会有哪个入口漏掉错误处理而静默失败。
 */
export async function consumeItemOnce(itemId: number): Promise<void> {
  try {
    const db = await getReadyDatabase();
    await recordQuickConsume(db, { itemId });
    await refreshItemsAfterMutation();
  } catch (error) {
    emit({ ...state, error: toErrorMessage(error) });
  }
}

/** 只读地取当前快照 */
export function getItemsState(): ItemsState {
  return state;
}

/** 订阅状态变化，返回取消订阅函数 */
export function subscribeItems(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 状态快照 hook。
 * `getItemsState` 只在状态真正变化时才换引用，所以不会产生无谓的重渲染。
 * 第三个参数（server snapshot）让 Web 端 SSR 也能跑通，原生端用不到。
 */
export function useItemsState(): ItemsState {
  return useSyncExternalStore(subscribeItems, getItemsState, getItemsState);
}

/** 聚合导出，调用方按 `itemsStore.refreshItems()` 使用，便于将来替换成别的实现 */
export const itemsStore = {
  getState: getItemsState,
  subscribe: subscribeItems,
  fetchItems: fetchItemsCached,
  refreshItems,
  refreshItemsAfterMutation,
  consumeItemOnce,
};
