import { getReadyDatabase } from '@/db/client';
import { rescheduleAll } from '@/notifications/scheduler';

/**
 * 重排的**防抖触发器**。
 *
 * 为什么要防抖：重排会读物品 + 消耗样本 + 通知历史再算一遍预测，
 * 而触发它的事件是成串来的 —— 一次「记录消耗」可能连续触发
 * 「写完流水 → 刷新列表 → 页面重聚焦」，连着跑三遍同样的计算纯属浪费。
 * 防抖之后一串事件只会落地成一次重排。
 *
 * 为什么放在独立模块而不是塞进 scheduler：防抖有**全局状态**（定时器 + 是否强制），
 * 而 `scheduler.ts` 的 `rescheduleAll` 必须保持「给我 db 我就算一次」的纯入口语义。
 * 两处触发源（切前台的 hook ~800ms、写操作出口 ~1.5s）共用这一份实现，
 * 只是防抖时长不同。
 *
 * 失败在这里 `console.warn` 兜住：重排是**旁路**功能，
 * 它失败不该让「记录消耗」这类主流程报错，也不该静默到没人知道。
 */

/** 写操作后的默认防抖时长。留足时间让一串联动刷新都落地 */
const DEFAULT_DELAY_MS = 1500;

let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * 待执行的重排是否需要「强制」。
 * 一串事件里只要有一次要求强制，整串就按强制执行 ——
 * 否则「跨天」那次强制会被后面紧跟的普通触发覆盖掉。
 */
let forceNext = false;

/** 数据变了 / 该重排了。重复调用只会把上一次的定时器顶掉 */
export function scheduleReschedule(options: { force?: boolean; delayMs?: number } = {}): void {
  forceNext = forceNext || Boolean(options.force);

  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const force = forceNext;
    forceNext = false;
    void run(force);
  }, options.delayMs ?? DEFAULT_DELAY_MS);
}

/** 取消还没落地的那次重排（组件卸载时用） */
export function cancelScheduledReschedule(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  forceNext = false;
}

async function run(force: boolean): Promise<void> {
  try {
    const db = await getReadyDatabase();
    await rescheduleAll(db, { force });
  } catch (error) {
    console.warn(
      '[notifications] 重排失败：',
      error instanceof Error ? error.message : String(error),
    );
  }
}
