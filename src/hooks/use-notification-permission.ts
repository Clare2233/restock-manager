import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  readNotificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/notifications/permissions';

/**
 * 通知权限的 React 入口 —— 设置页与「通知被关掉了」的降级提示都用它。
 *
 * 职责只有两个：把权限状态搬到 React 里，并在它会变的时机重新读。
 * 真正的平台差异全在 `@/notifications/permissions`，这里一行都没有。
 */
export interface UseNotificationPermissionResult {
  /** 当前权限状态。`unsupported` = 非原生平台，UI 应整块隐藏通知相关设置 */
  permission: NotificationPermissionState;
  /** 首次读取中。之后的刷新保持 false，免得设置项来回闪 */
  loading: boolean;
  /** 最近一次失败原因；只有真的抛异常时才非 null（被拒绝不算失败） */
  error: string | null;
  /** 是否已授权 */
  granted: boolean;
  /**
   * 申请权限。Android 上会先建渠道再弹系统框。
   * 返回申请后的状态；失败时返回当前已知状态，错误详情看 `error`。
   */
  request: () => Promise<NotificationPermissionState>;
  /** 重新读一次系统里的真实状态 */
  refresh: () => Promise<void>;
}

export function useNotificationPermission(): UseNotificationPermissionResult {
  const [permission, setPermission] = useState<NotificationPermissionState>('undetermined');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // request() 失败时要返回「此刻已知的状态」，不能用闭包里可能已经过期的 permission
  const permissionRef = useRef<NotificationPermissionState>(permission);

  const applyPermission = useCallback((next: NotificationPermissionState) => {
    permissionRef.current = next;
    setPermission(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyPermission(await readNotificationPermission());
      setError(null);
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [applyPermission]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 从系统设置页返回时状态必须重读：用户在系统里开关过权限，
  // App 进程往往还活着，缓存的状态会一直是旧的。
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const request = useCallback(async () => {
    try {
      applyPermission(await requestNotificationPermission());
      setError(null);
    } catch (cause) {
      setError(toMessage(cause));
    }
    return permissionRef.current;
  }, [applyPermission]);

  return {
    permission,
    loading,
    error,
    granted: permission === 'granted',
    request,
    refresh,
  };
}

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
