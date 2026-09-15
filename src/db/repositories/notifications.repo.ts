import type { SQLiteDatabase } from 'expo-sqlite';
import { mapNotificationHistory, mapNotificationJob } from '@/db/mappers';
import type {
  NotificationHistory,
  NotificationHistoryRow,
  NotificationJob,
  NotificationJobRow,
  ReminderKind,
  UpsertNotificationJobInput,
} from '@/types/models';
import { nowMs } from '@/utils/date';
import type { Millis } from '@/types/models';

/**
 * 通知仓库，管两张表：
 * - `notification_jobs`    ：已交给系统调度的通知，保存 OS 返回的 identifier 用于取消/重排；
 * - `notification_history` ：触发历史，用于**冷却期**与「稍后提醒」的静默期。
 *
 * 为什么必须存 identifier：`cancelAllScheduledNotificationsAsync()` 是核弹级操作，
 * 用户在设置里关掉通知再打开、或只改一个物品的时间时，全量取消会连带
 * 干掉别的模块（例如未来的每日摘要）已排好的通知。逐条取消更精准。
 */

/** Core 后缀 = 不开事务，供已有事务的调用方（如重排流程）复用 */

// ---------------------------------------------------------------------------
// notification_jobs
// ---------------------------------------------------------------------------

export async function upsertJobCore(
  db: SQLiteDatabase,
  input: UpsertNotificationJobInput,
): Promise<void> {
  // item_id 为 NULL 时，UNIQUE(item_id, kind) 不会触发冲突
  // （SQLite 认为 NULL 互不相等），因此先删后插保证语义一致。
  if (input.itemId === null) {
    await db.runAsync('DELETE FROM notification_jobs WHERE item_id IS NULL AND kind = ?', [
      input.kind,
    ]);
  }
  await db.runAsync(
    `INSERT INTO notification_jobs (item_id, kind, notification_id, fire_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, kind) DO UPDATE SET
       notification_id = excluded.notification_id,
       fire_at         = excluded.fire_at,
       reason          = excluded.reason,
       created_at      = excluded.created_at`,
    [
      input.itemId,
      input.kind,
      input.notificationId,
      input.fireAt,
      input.reason ?? null,
      nowMs(),
    ],
  );
}

export async function upsertJob(
  db: SQLiteDatabase,
  input: UpsertNotificationJobInput,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await upsertJobCore(db, input);
  });
}

export async function listJobs(db: SQLiteDatabase): Promise<NotificationJob[]> {
  const rows = await db.getAllAsync<NotificationJobRow>(
    'SELECT * FROM notification_jobs ORDER BY fire_at ASC',
  );
  return rows.map(mapNotificationJob);
}

/**
 * 已到点的待发任务（`fire_at <= deadlineMs`，从早到晚）。
 *
 * 这是「补计入账」的入口：本地通知**由系统带外触发**，
 * App 不在前台时拿不到任何回调（远程通知才有 headless task）。
 * 所以不能靠「收到通知」写历史，只能在下一次重排时反查：
 * 表里 `fire_at` 已经过去的条目就是「系统已经发出去了」，据此补写历史、
 * 让冷却机制开始计时。详见 scheduler 的「已发即入历史」。
 */
export async function listDueJobs(
  db: SQLiteDatabase,
  deadlineMs: Millis,
): Promise<NotificationJob[]> {
  const rows = await db.getAllAsync<NotificationJobRow>(
    'SELECT * FROM notification_jobs WHERE fire_at <= ? ORDER BY fire_at ASC',
    [deadlineMs],
  );
  return rows.map(mapNotificationJob);
}

export async function getJob(
  db: SQLiteDatabase,
  itemId: number | null,
  kind: ReminderKind,
): Promise<NotificationJob | null> {
  const row =
    itemId === null
      ? await db.getFirstAsync<NotificationJobRow>(
          'SELECT * FROM notification_jobs WHERE item_id IS NULL AND kind = ?',
          [kind],
        )
      : await db.getFirstAsync<NotificationJobRow>(
          'SELECT * FROM notification_jobs WHERE item_id = ? AND kind = ?',
          [itemId, kind],
        );
  return row ? mapNotificationJob(row) : null;
}

/** 删除某物品某类型的待发任务（也用于「本物品的所有任务」清理） */
export async function deleteJobCore(
  db: SQLiteDatabase,
  itemId: number | null,
  kind?: ReminderKind,
): Promise<void> {
  if (itemId === null) {
    if (kind) {
      await db.runAsync('DELETE FROM notification_jobs WHERE item_id IS NULL AND kind = ?', [
        kind,
      ]);
    } else {
      await db.runAsync('DELETE FROM notification_jobs WHERE item_id IS NULL');
    }
    return;
  }
  if (kind) {
    await db.runAsync('DELETE FROM notification_jobs WHERE item_id = ? AND kind = ?', [
      itemId,
      kind,
    ]);
  } else {
    await db.runAsync('DELETE FROM notification_jobs WHERE item_id = ?', [itemId]);
  }
}

export async function deleteJob(
  db: SQLiteDatabase,
  itemId: number | null,
  kind?: ReminderKind,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await deleteJobCore(db, itemId, kind);
  });
}

export async function clearJobs(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM notification_jobs');
}

export async function countJobs(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    'SELECT COUNT(*) AS total FROM notification_jobs',
  );
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// notification_history
// ---------------------------------------------------------------------------

/**
 * 记一条触发历史。同一物品/类型/毫秒重复写入会被忽略（唯一索引）。
 *
 * `itemId` 为 null 表示「不属于任何物品」的通知 —— 目前只有每日摘要。
 * 注意 SQLite 认为 NULL 互不相等，所以 `UNIQUE(item_id, kind, fired_at)`
 * 对这种行**不生效**：同参数的摘要历史会被写进去多次。不影响正确性，
 * 因为摘要的读取口径一律是 MAX(fired_at)（见 `getLastDigestFiredAt`）。
 */
export async function insertHistory(
  db: SQLiteDatabase,
  params: { itemId: number | null; kind: ReminderKind; firedAt: number },
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO notification_history (item_id, kind, fired_at, dismissed, snoozed_until)
     VALUES (?, ?, ?, 0, NULL)`,
    [params.itemId, params.kind, params.firedAt],
  );
}

/** 最近一次触发时间（冷却判定）；不传 kind 表示不限类型 */
export async function getLastFiredAt(
  db: SQLiteDatabase,
  itemId: number | null,
  kind?: ReminderKind,
): Promise<number | null> {
  if (itemId === null) return null;
  const row = kind
    ? await db.getFirstAsync<{ fired_at: number | null }>(
        `SELECT MAX(fired_at) AS fired_at FROM notification_history
          WHERE item_id = ? AND kind = ?`,
        [itemId, kind],
      )
    : await db.getFirstAsync<{ fired_at: number | null }>(
        'SELECT MAX(fired_at) AS fired_at FROM notification_history WHERE item_id = ?',
        [itemId],
      );
  return row?.fired_at ?? null;
}

/**
 * 最近一次「每日摘要」的触发时间。
 *
 * 为什么不能复用 `getLastFiredAt`：它在 `itemId === null` 时直接 return null
 * （那条短路来自「没有所属物品就谈不上冷却」的直觉）。但每日摘要恰恰是
 * `item_id IS NULL` 的那一行 —— 摘要一天只能发一条（发了就不再排当天），
 * 走的正好是这个「无主」口径，所以必须单独查。
 *
 * 条件里带 `kind = 'daily_digest'`：将来若有别的无主通知。
 */
export async function getLastDigestFiredAt(db: SQLiteDatabase): Promise<Millis | null> {
  const row = await db.getFirstAsync<{ fired_at: number | null }>(
    `SELECT MAX(fired_at) AS fired_at FROM notification_history
      WHERE item_id IS NULL AND kind = 'daily_digest'`,
  );
  return row?.fired_at ?? null;
}

/**
 * 某物品某类型在 `sinceMs` 之后已经发过几条。
 *
 * P0「同日去重」的判据：P0 在 `evaluateReminder` 里**跳过冷却**
 * （库存见底是确定事实，不该被冷却挡住），但没有这道闸的话，
 * 每次重排都会给同一件还没补货的物品再排一条 P0 —— 它永远「该提醒」。
 * 所以按业务日补一道上限：`sinceMs` 传当天零点，同日已是 1 条就不再排。
 */
export async function countFiredSince(
  db: SQLiteDatabase,
  itemId: number,
  kind: ReminderKind,
  sinceMs: Millis,
): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM notification_history
      WHERE item_id = ? AND kind = ? AND fired_at >= ?`,
    [itemId, kind, sinceMs],
  );
  return row?.total ?? 0;
}

/** 某物品最近一条历史（取 snoozed_until / dismissed 用） */
export async function getLatestHistory(
  db: SQLiteDatabase,
  itemId: number,
): Promise<NotificationHistory | null> {
  const row = await db.getFirstAsync<NotificationHistoryRow>(
    `SELECT * FROM notification_history WHERE item_id = ?
      ORDER BY fired_at DESC LIMIT 1`,
    [itemId],
  );
  return row ? mapNotificationHistory(row) : null;
}

/** 批量取「最近一次触发时间」，重排时用于一次性算出全部冷却状态 */
export async function listLastFiredAtByItem(
  db: SQLiteDatabase,
): Promise<Map<number, number>> {
  const rows = await db.getAllAsync<{ item_id: number; last_fired_at: number }>(
    `SELECT item_id, MAX(fired_at) AS last_fired_at
       FROM notification_history
      WHERE item_id IS NOT NULL
      GROUP BY item_id`,
  );
  return new Map(rows.map((row) => [row.item_id, row.last_fired_at]));
}

export async function markDismissed(
  db: SQLiteDatabase,
  historyId: number,
): Promise<void> {
  await db.runAsync('UPDATE notification_history SET dismissed = 1 WHERE id = ?', [historyId]);
}

/** 设置「稍后提醒」到指定时间（更新该物品最近一条历史） */
export async function setSnooze(
  db: SQLiteDatabase,
  itemId: number,
  snoozedUntil: number,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    const latest = await getLatestHistory(db, itemId);
    if (!latest) return;
    await db.runAsync('UPDATE notification_history SET snoozed_until = ? WHERE id = ?', [
      snoozedUntil,
      latest.id,
    ]);
  });
}

/** 取消「稍后提醒」 */
export async function clearSnooze(db: SQLiteDatabase, itemId: number): Promise<void> {
  await db.runAsync(
    'UPDATE notification_history SET snoozed_until = NULL WHERE item_id = ?',
    [itemId],
  );
}

/** 当前是否处于静默期；返回静默截止时间（未静默返回 null） */
export async function getSnoozedUntil(
  db: SQLiteDatabase,
  itemId: number,
): Promise<number | null> {
  if (itemId === null) return null;
  const row = await db.getFirstAsync<{ snoozed_until: number | null }>(
    `SELECT MAX(snoozed_until) AS snoozed_until FROM notification_history
      WHERE item_id = ? AND snoozed_until IS NOT NULL`,
    [itemId],
  );
  const until = row?.snoozed_until ?? null;
  return until !== null && until > nowMs() ? until : null;
}

/** 清掉某物品的通知历史（补货后重新开始冷却周期） */
export async function clearHistoryForItem(
  db: SQLiteDatabase,
  itemId: number,
): Promise<void> {
  await db.runAsync('DELETE FROM notification_history WHERE item_id = ?', [itemId]);
}

/** 清理历史（保留最近 N 天，避免无限增长）；返回删除条数 */
export async function pruneHistory(
  db: SQLiteDatabase,
  beforeMs: number,
): Promise<number> {
  const result = await db.runAsync('DELETE FROM notification_history WHERE fired_at < ?', [
    beforeMs,
  ]);
  return result.changes;
}

export async function clearHistory(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM notification_history');
}

/**
 * 全量通知历史（备份导出口径）。
 *
 * 只导 `notification_history`，**不导 `notification_jobs`**：后者存的是
 * 系统返回的 identifier，换设备 / 重装后毫无意义（详见 types/backup.ts）。
 */
export async function listAllNotificationHistory(
  db: SQLiteDatabase,
): Promise<NotificationHistory[]> {
  const rows = await db.getAllAsync<NotificationHistoryRow>(
    'SELECT * FROM notification_history ORDER BY id ASC',
  );
  return rows.map(mapNotificationHistory);
}

export async function countHistory(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    'SELECT COUNT(*) AS total FROM notification_history',
  );
  return row?.total ?? 0;
}

/** 清空通知相关的两张表（重置数据用） */
export async function clearAllNotifications(db: SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM notification_jobs');
    await db.runAsync('DELETE FROM notification_history');
  });
}
