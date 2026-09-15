import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import {
  NOTIFICATION_CHANNEL_ID,
  NOTIFICATION_CHANNEL_NAME,
  NOTIFICATION_CHANNEL_URGENT_ID,
  NOTIFICATION_CHANNEL_URGENT_NAME,
} from '@/constants/defaults';

/**
 * 通知权限 —— 全项目**唯一**允许调 expo-notifications 权限 API 的地方。
 *
 * 收口的原因：权限状态是全局的、有副作用的（会弹系统框），
 * 散落在各处调用就会出现「页面 A 刚问过、页面 B 又问一遍」，
 * 而且每处都要自己写一遍 Android/iOS 的差异，迟早不一致。
 * 排期（scheduler）、设置页、降级提示一律通过这里或 `useNotificationPermission` 拿状态。
 *
 * 平台差异，写在这里以免每个调用方重新踩一遍：
 * - **Android 13+**：不先建通知渠道，系统**根本不会弹**权限框。
 *   所以 `requestNotificationPermission()` 在 Android 上必须先 `ensureAndroidChannel()`。
 *   这也是它俩分开导出的原因 —— `ensureAndroidChannel()` 还要给排期用
 *   （排期前必须保证渠道存在，否则通知会掉进系统默认的 Miscellaneous 渠道）。
 * - **iOS**：官方要求看 `ios.status` 而不是根 `status`，因为 iOS 的权限更细
 *   （provisional / ephemeral 都能发通知，但根 status 未必是 granted）。
 *
 * 这里**不做**的事：
 * - 不设置 `setNotificationHandler`（决定「收到通知时怎么展示」），那是排期模块的事；
 * - 不跳系统设置（用 `Linking.openSettings()`），等设置页那步再补。
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

/** 只有这两个平台真的有本地通知 */
function isNativePlatform(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

/**
 * 建好两个 Android 通知渠道（已存在则更新）。iOS / web 上是 no-op。
 *
 * - `restock-reminders`（DEFAULT）：每日摘要。安静进抽屉，不弹 heads-up。
 * - `restock-urgent`（HIGH）：P0「已用完」。会响铃并悬浮显示。
 *
 * Android 的限制：**渠道建好之后只有 name / description 能改**，
 * importance 改了也不会对已存在的渠道生效（要生效只能卸载重装或换 ID）。
 * 所以这里的 importance 一旦发布就别动 —— 要调整请连带改渠道 ID。
 */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
    name: NOTIFICATION_CHANNEL_NAME,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_URGENT_ID, {
    name: NOTIFICATION_CHANNEL_URGENT_NAME,
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/**
 * 申请通知权限，返回申请后的状态。
 *
 * Android 上先建渠道再申请（否则 Android 13+ 不弹框），iOS 直接申请。
 * 已经 granted 时调用它不会有副作用 —— 系统直接返回当前状态，不会再弹一次。
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNativePlatform()) return 'unsupported';

  if (Platform.OS === 'android') {
    await ensureAndroidChannel();
  }

  return toState(await Notifications.requestPermissionsAsync());
}

/**
 * 读取当前权限状态，**不弹框、无副作用**。
 * 从系统设置返回后要重新读一次 —— 用户在系统里改过权限，App 内存里的状态是旧的。
 */
export async function readNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNativePlatform()) return 'unsupported';

  return toState(await Notifications.getPermissionsAsync());
}

/**
 * expo 的权限对象 → 我们自己的四态。
 *
 * 为什么 iOS 要单独走一遍：根 `status` 在 iOS 上不可靠
 * （官方文档明确要求看 `ios.status`）。
 */
function toState(result: Notifications.NotificationPermissionsStatus): NotificationPermissionState {
  if (Platform.OS === 'ios') {
    return fromIosStatus(result.ios?.status, result.granted);
  }

  if (result.granted) return 'granted';
  return result.status === 'undetermined' ? 'undetermined' : 'denied';
}

function fromIosStatus(
  status: Notifications.IosAuthorizationStatus | undefined,
  granted: boolean,
): NotificationPermissionState {
  switch (status) {
    case Notifications.IosAuthorizationStatus.AUTHORIZED:
      return 'granted';
    // provisional：不打扰用户地投递到通知中心。通知**能发**，只是不弹不响，
    // 按「已授权」处理，否则用户会看到「未授权」却明明收得到。
    case Notifications.IosAuthorizationStatus.PROVISIONAL:
      return 'granted';
    // ephemeral：临时授权（App Clip 场景），期限内可用
    case Notifications.IosAuthorizationStatus.EPHEMERAL:
      return 'granted';
    case Notifications.IosAuthorizationStatus.DENIED:
      return 'denied';
    case Notifications.IosAuthorizationStatus.NOT_DETERMINED:
      return 'undetermined';
    default:
      // 拿不到 ios.status 时退回根 status 的判断
      return granted ? 'granted' : 'denied';
  }
}
