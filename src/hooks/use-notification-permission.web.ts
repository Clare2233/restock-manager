import type { NotificationPermissionState } from '@/notifications/permissions';

/**
 * 通知权限 hook 的 **web 空实现**（与 `scheduler.web.ts` 同理）。
 *
 * UI 里到处都是 `useNotificationPermission()`，不可能让每个调用方
 * 自己判断平台 —— 所以在平台层把「不支持」伪装成一个普通状态返回。
 *
 * `loading` 直接给 `false` 而不是先 true 再 false：
 * 原生版那个 true 是为了盖住「读权限」这一瞬的空档，web 上压根没有这一瞬，
 * 给 true 反而让设置项白闪一下。
 *
 * 返回值结构与原生版**逐字段一致**（含 `request` / `refresh`），
 * 这样设置页的「去系统设置」「开启权限」两个按钮在 web 上就是简单地不出现
 * （它们由 `permission === 'denied' | 'undetermined'` 控制），
 * 不需要页面额外判断平台。
 */
export interface UseNotificationPermissionResult {
  permission: NotificationPermissionState;
  loading: boolean;
  error: string | null;
  granted: boolean;
  request: () => Promise<NotificationPermissionState>;
  refresh: () => Promise<void>;
}

export function useNotificationPermission(): UseNotificationPermissionResult {
  return {
    permission: 'unsupported',
    loading: false,
    error: null,
    granted: false,
    request: () => Promise.resolve('unsupported'),
    refresh: () => Promise.resolve(),
  };
}
