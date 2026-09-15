/**
 * 通知权限的 **web 空实现**（与 `scheduler.web.ts` 同理）。
 *
 * Metro 在 web 平台优先解析 `*.web.ts`，于是 web bundle 里既没有
 * `expo-notifications`，也没有 `react-native` —— 「打进去再运行时判断」
 * 和「根本不打进去」是两件事，这里选后者。
 *
 * ## 必须与 `permissions.ts` 保持同名导出
 * 那边导出什么，这边就得有什么（**类型也包括在内**）。
 * 少了任何一个，web 上会变成「能编译、运行时 undefined」——
 * 因为 Metro 是**按文件名替换整个模块**的，不做合并，
 * 缺的那个名字在 web 里就是彻底不存在，而不是自动回退到原生实现。
 *
 * 状态恒为 `unsupported`：UI 靠它整块隐藏通知相关的设置，
 * 这与 `permissions.ts` 里「非原生平台返回 unsupported」的语义一致。
 */

export type NotificationPermissionState =
  /** 还没问过用户 */
  | 'undetermined'
  /** 已授权，可以排通知 */
  | 'granted'
  /** 问过且被拒绝。再调 request 也不会弹框，只能引导去系统设置 */
  | 'denied'
  /** 平台不支持（web） */
  | 'unsupported';

/** web 上没有 Android 渠道 */
export function ensureAndroidChannel(): Promise<void> {
  return Promise.resolve();
}

/** web 上无处申请，恒为 unsupported */
export function requestNotificationPermission(): Promise<NotificationPermissionState> {
  return Promise.resolve('unsupported');
}

/** web 上恒为 unsupported。不做「读一下再说」，读也读不出别的结果 */
export function readNotificationPermission(): Promise<NotificationPermissionState> {
  return Promise.resolve('unsupported');
}
