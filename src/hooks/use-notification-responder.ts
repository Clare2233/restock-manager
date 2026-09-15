import {
  addNotificationResponseReceivedListener,
  useLastNotificationResponse,
  type NotificationResponse,
} from 'expo-notifications';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

/**
 * 通知点击 → 页面跳转。
 *
 * ## data 约定（由 `scheduler.ts` 写入）
 * - `{ route: '/shopping' }`                  → 购物清单（每日摘要点进来最有用）
 * - `{ route: '/item/[id]', itemId: number }` → 该物品的详情页（P0「已用完」）
 *
 * 用「显式 route + 参数」而不是让响应端自己猜去哪：落地页是**产品决策**，
 * 由排期端写进 data，将来「摘要也想直达某件物品」只需改排期，不用动这里。
 *
 * ## 为什么必须等导航就绪
 * 冷启动时 `useLastNotificationResponse()` 会立刻带回「启动 App 的那次点击」，
 * 此刻导航容器往往还没 mount 完，`router.push` 会抛
 * 「Attempted to navigate before mounting the Root Layout」。
 * 所以先把目标存下来，等 `navigationRef.isReady()` 再跳（每 100ms 试一次，
 * 最多等 5 秒；等不到就放弃并 warn —— **无限重试**会把一次「点了没反应」
 * 变成一个永远空转的定时器，而实际原因（导航卡住）并不会因此消失）。
 * 本 hook 只在 `_layout` 的 ready 子树里挂载，正常情况第一次就通过。
 *
 * ## 去重
 * 同一次点击会**同时**走两条路：`useLastNotificationResponse`（冷启动）
 * 和 `addNotificationResponseReceivedListener`（之后的所有点击，冷启动那次也可能补一发）。
 * 不去重就会跳两次（详情页被压两层）。
 * 判据是 `notification.request.identifier`（每条通知唯一），
 * 记在**模块级**而不是 ref 里 —— 组件重挂载不该把记录清掉。
 */

/** 导航未就绪时的重试间隔 */
const READY_RETRY_MS = 100;

/** 等导航就绪的最多尝试次数（100ms × 50 = 5 秒），超过就放弃 */
const MAX_READY_ATTEMPTS = 50;

/** 去重记录的上限：只在异常情况下才会攒到这个量 */
const MAX_REMEMBERED = 100;

/** 已处理过的响应 */
const handledIds = new Set<string>();

interface NotificationTarget {
  route: string;
  itemId: number | null;
}

export function useNotificationResponder(): void {
  const router = useRouter();
  const navigationRef = useNavigationContainerRef();

  const lastResponse = useLastNotificationResponse();
  /**
   * 待跳转的目标 + 已尝试次数。
   * 两者放在同一个 state 里是有意的：重试次数**属于某一次点击**，
   * 用独立 state 的话，前一条通知把次数耗光之后，下一条会一进来就被判超时。
   */
  const [pending, setPending] = useState<{ target: NotificationTarget; attempt: number } | null>(
    null,
  );

  const queue = useCallback((response: NotificationResponse) => {
    if (markHandled(response)) return;
    const target = parseTarget(response);
    setPending(target === null ? null : { target, attempt: 0 });
  }, []);

  // 之后的所有点击（App 已在运行）
  useEffect(() => {
    const subscription = addNotificationResponseReceivedListener(queue);
    return () => subscription.remove();
  }, [queue]);

  // 冷启动：把「启动 App 的那次点击」带回来
  useEffect(() => {
    if (lastResponse) queue(lastResponse);
  }, [lastResponse, queue]);

  useEffect(() => {
    if (!pending) return;

    if (!navigationRef.isReady()) {
      if (pending.attempt + 1 >= MAX_READY_ATTEMPTS) {
        console.warn('[notifications] 等导航就绪超时，放弃跳转：', pending.target.route);
        setPending(null);
        return;
      }

      const timer = setTimeout(() => {
        setPending((value) =>
          value === null ? null : { ...value, attempt: value.attempt + 1 },
        );
      }, READY_RETRY_MS);
      return () => clearTimeout(timer);
    }

    pushTarget(router, pending.target);
    setPending(null);
  }, [pending, navigationRef, router]);
}

function markHandled(response: NotificationResponse): boolean {
  const id = response.notification.request.identifier;
  if (handledIds.has(id)) return true;

  if (handledIds.size >= MAX_REMEMBERED) handledIds.clear();
  handledIds.add(id);
  return false;
}

/**
 * 从 data 里解出落地页。
 *
 * 逐字段 `typeof` 校验而不是直接断言：data 由原生层回传，
 * 中间任何一环（旧版本排的通知、手工构造的 payload）都可能给出别的形状。
 * 解不出来就返回 null —— 不跳，也比跳进一个不存在的路由崩掉好。
 */
function parseTarget(response: NotificationResponse): NotificationTarget | null {
  const data = response.notification.request.content.data;
  if (typeof data !== 'object' || data === null) return null;

  const raw = data as { route?: unknown; itemId?: unknown };
  if (raw.route === '/shopping') return { route: '/shopping', itemId: null };

  if (raw.route === '/item/[id]') {
    const itemId = typeof raw.itemId === 'number' ? raw.itemId : Number(raw.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) return null;
    return { route: '/item/[id]', itemId };
  }

  return null;
}

/**
 * 跳转。两个分支各自写死字面量，好让 typed routes 能检查得到 ——
 * 拼成变量再传进去的话，类型检查就失效了。
 */
function pushTarget(router: ReturnType<typeof useRouter>, target: NotificationTarget): void {
  switch (target.route) {
    case '/shopping':
      router.push('/shopping');
      return;
    case '/item/[id]':
      if (target.itemId !== null) {
        router.push({ pathname: '/item/[id]', params: { id: String(target.itemId) } });
      }
      return;
    default:
      return;
  }
}
