import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * 通知排期的 **web 空实现**。
 *
 * 为什么要有这个文件：Metro 在 web 平台会优先解析 `*.web.ts`，
 * 于是「web 打包」拿到的是这里的空壳，`scheduler.ts` 里的
 * `expo-notifications` 根本不会进 bundle —— 而不是「打进去但在运行时报错」。
 *
 * 空实现（而不是抛错）是因为调用方（`_layout`、写操作出口）不该关心平台：
 * 它们只管「数据变了就重排」，web 上这件事没有意义，静默不做即可。
 *
 * 这里**不能** import 任何 expo 运行时模块（下面那行是 `import type`，
 * 编译后会被完全擦掉，不会留下 require）。
 */
export function rescheduleAll(
  _db: SQLiteDatabase,
  _options?: { force?: boolean },
): Promise<void> {
  return Promise.resolve();
}

/** web 上没有通知，取消自然也是空操作 */
export function cancelAllScheduledJobs(_db: SQLiteDatabase): Promise<void> {
  return Promise.resolve();
}

/** web 上没有通知，处理器也无从谈起 */
export function configureNotificationHandler(): void {}
