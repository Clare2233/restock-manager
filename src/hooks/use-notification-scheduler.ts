import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import {
  cancelScheduledReschedule,
  scheduleReschedule,
} from '@/notifications/reschedule-debounce';
import { nowMs, toISODate } from '@/utils/date';

/**
 * 通知重排的 AppState 触发器。
 *
 * ## 只监听 'active'
 * 后台没有重排的必要：通知由系统带外触发，我们排在不在前台都不影响它响；
 * 而在后台做重排反而会白白读一遍库。所以只有回到前台才重排。
 *
 * ## 为什么跨天要 force
 * 重排靠「计划签名」短路（签名没变就什么都不做）。
 * 跨过午夜时，很多东西的含义都变了（今天的 P0 去重窗口、摘要的 fire point），
 * 但**签名未必变** —— 比如昨天排的摘要时刻与今天算出来的正好是同一个值，
 * 那次重排就会被短路掉。所以主动记一个业务日，发现跨天就强制跑一遍。
 *
 * 注意「补计入账」在签名判断**之前**，所以即使被短路，已发通知的账也照记；
 * force 只是让「按新的一天重新算计划」这件事一定发生。
 *
 * ## 卸载
 * 摘掉监听 + 取消还没落地的那次防抖。已经在跑的那次重排取消不掉
 * （`scheduler` 的 inflight 是模块私有的），但它是纯 DB 操作、不碰 React 状态，
 * 跑完无害。
 */

/** 切回前台后的防抖时长：够把「解锁 → 恢复 → 重聚焦」这一串事件并成一次 */
const ACTIVE_DEBOUNCE_MS = 800;

export function useNotificationScheduler(): void {
  /** 上次重排时是**哪一天**（'YYYY-MM-DD'，本地时区） */
  const lastDayRef = useRef<string | null>(null);

  useEffect(() => {
    // 挂载时 `_layout` 已经排过一次，这里只记下业务日，不重复排
    lastDayRef.current = toISODate(nowMs());

    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active') return;

      const today = toISODate(nowMs());
      const crossedMidnight = lastDayRef.current !== null && lastDayRef.current !== today;
      lastDayRef.current = today;

      scheduleReschedule({ force: crossedMidnight, delayMs: ACTIVE_DEBOUNCE_MS });
    });

    return () => {
      subscription.remove();
      cancelScheduledReschedule();
    };
  }, []);
}
