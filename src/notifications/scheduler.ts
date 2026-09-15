import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  MAX_PENDING_NOTIFICATIONS,
  NOTIFICATION_CHANNEL_ID,
  NOTIFICATION_CHANNEL_URGENT_ID,
  SETTINGS_KEYS,
} from '@/constants/defaults';
import { listItems } from '@/db/repositories/items.repo';
import { listConsumptionSamplesByItem } from '@/db/repositories/movements.repo';
import {
  clearJobs,
  countFiredSince,
  deleteJobCore,
  getLastDigestFiredAt,
  getSnoozedUntil,
  insertHistory,
  listDueJobs,
  listJobs,
  listLastFiredAtByItem,
  upsertJob,
} from '@/db/repositories/notifications.repo';
import { getAppSettings, getSettingValue, setSettingValue } from '@/db/repositories/settings.repo';
import {
  buildDailyDigestCopy,
  buildOutOfStockCopy,
  toDigestEntry,
  type DigestEntry,
} from '@/domain/notification-copy';
import { maxSampleWindowStart, predictItem, type Prediction } from '@/domain/prediction';
import { evaluateReminder } from '@/domain/reminder';
import { ensureAndroidChannel, readNotificationPermission } from '@/notifications/permissions';
import type { Item, Millis, NotificationJob, ReminderKind } from '@/types/models';
import { addDaysMs, isSameDayMs, nextFirePoint, nowMs, startOfDayMs } from '@/utils/date';

/**
 * 通知重排 —— 通知模块的**大脑**，也是唯一碰 expo-notifications 调度 API 的地方。
 *
 * ## 方案 A：每次重排只排最近一个 fire point
 *
 * 一个物品可能连续多天都「该提醒」（买了才停），但我们**不为它排一串通知**，
 * 只排**下一次**该响的那一条；它响了之后，下一次重排才会再排下一条。
 *
 * 这样选是因为批量排 N 条的做法有个致命前提：App 必须在每条通知触发前
 * 至少被打开过一次去续排。而本地通知**恰恰是在用户没打开 App 时才最有价值** ——
 * 前提不成立，方案就不成立。
 *
 * **已知代价，明确接受**：长期不打开 App，排的那一条响完之后就不会再有新通知，
 * 直到用户下次打开。这是「不打扰」与「不漏提醒」之间的取舍：
 * 与其在用户早就买完洗衣液之后还连着推送一周，不如等他打开 App 时重新对齐一次。
 *
 * ## 补计入账：为什么必须自己记账
 *
 * 本地通知由**系统**带外触发。App 不在前台时拿不到任何回调
 * （只有远程推送才有 headless task），所以「通知发出去了」这件事
 * 在发生的那一刻是**不可观测**的。
 *
 * 于是反着来：`notification_jobs` 里 `fire_at` 已经过去的条目，
 * 就等价于「系统已经发出去了」。重排时先把它们补写进 `notification_history`
 * 再删掉（`reconcileFiredJobs`）。没有这一步，冷却期永远从 0 开始计时 ——
 * 用户每天会被同一条提醒吵一次，而我们还以为「刚提醒过」。
 *
 * ## P0 同日去重
 *
 * P0（库存 <= 0）在 `evaluateReminder` 里**跳过冷却与静默期**，
 * 因为它是确定事实而非预测。但少了冷却这道闸，每次重排都会给同一件
 * 还没补货的物品再排一条 P0 —— 它永远「该提醒」。
 *
 * 所以按业务日补一道上限：当天已经发过 `out_of_stock` 就不再排
 * （`countFiredSince(今天零点)`）。注意它**依赖补计入账**
 * —— 历史不写进去，去重就永远不生效。
 *
 * ## 幂等
 *
 * 全量重排可以在任意时刻重复调用，结果一致。判据是「计划签名」：
 * 本次算出的计划与上次存的一致，就什么都不做 ——
 * 否则每次进 App 都要把通知全取消再排一遍，
 * iOS 上还会因此频繁触碰 64 条 pending 上限。
 *
 * ## 不做的事
 * 权限申请（`@/notifications/permissions`）、文案（`@/domain/notification-copy`）、
 * 判定（`evaluateReminder`）、点击后的跳转（将来）都不在这里。
 */

/** 后台 / 冷启动时，P0 排在多远之后触发 */
const BACKGROUND_P0_DELAY_MS = 60_000;

/**
 * 计划签名版本。
 * 计划的结构变了（加了字段、改了含义）就 +1 —— 老签名与新签名必然不同，
 * 于是所有设备都会重排一次，不会卡在「签名没变、但排的是旧计划」。
 */
const PLAN_VERSION = 1;

interface PlannedP0 {
  itemId: number;
  itemName: string;
  fireAt: Millis;
  /** true = 立即投递（App 在前台）；false = 定时投递 */
  immediate: boolean;
}

interface PlannedDigest {
  fireAt: Millis;
  title: string;
  body: string;
}

interface ReschedulePlan {
  /** P0「已用完」：每件一条，突破摘要 */
  p0: PlannedP0[];
  /** 每日摘要：P1~P3 合并成一条；没有待补货物品时为 null */
  digest: PlannedDigest | null;
}

/** 模块级并发保护：重排未完成时的重复调用复用同一个 Promise */
let inflight: Promise<void> | null = null;

/**
 * 全量重排。**幂等**，可以在任意时刻重复调用（进 App、改数据、改设置、切前台）。
 *
 * `options.force`：跳过「计划签名相同就返回」的短路，强制重排一遍。
 * 跨天的那一次要用它 —— 见 `useNotificationScheduler`。
 *
 * 完成或失败后都会清掉 `inflight`，下次调用重新跑一遍。
 * 返回的是同一个 Promise，调用方请自行 catch —— 重排失败不应该把 App 带崩，
 * 但也不该被静默吞掉（失败意味着通知没排上，用户会以为「没提醒我」）。
 */
export function rescheduleAll(
  db: SQLiteDatabase,
  options: { force?: boolean } = {},
): Promise<void> {
  if (inflight) return inflight;

  const pending = runReschedule(db, Boolean(options.force)).finally(() => {
    inflight = null;
  });
  inflight = pending;
  return pending;
}

/**
 * 设置「收到通知时怎么展示」。
 *
 * 必须在 App 启动时调一次（将来由 `_layout` 负责）：
 * handler 没设置时 expo-notifications 的默认行为是**不展示**，
 * 于是会出现「通知明明触发了、却什么都没看到」这种最难排查的现象。
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function runReschedule(db: SQLiteDatabase, force: boolean): Promise<void> {
  const settings = await getAppSettings(db);
  const permission = await readNotificationPermission();

  // 全局开关关了 / 权限没给：系统里一条都不该留。
  // 签名写成空串，保证重新打开时一定重排（而不是沿用旧的签名直接跳过）。
  if (!settings.notificationsEnabled || permission !== 'granted') {
    await cancelAllScheduledJobs(db);
    await clearJobs(db);
    await setSettingValue(db, SETTINGS_KEYS.notificationPlan, '');
    return;
  }

  // 必须在读冷却状态之前：补写的历史会立刻参与后面的 lastFiredAt 判定
  await reconcileFiredJobs(db);

  const now = nowMs();
  const plan = await buildPlan(db, now, settings.reRemindIntervalDays, settings.defaultNotifyTime);
  const signature = planSignature(plan);

  if (!force && signature === (await getSettingValue(db, SETTINGS_KEYS.notificationPlan))) {
    return;
  }

  await applyPlan(db, plan, signature);
}

// ---------------------------------------------------------------------------
// 补计入账
// ---------------------------------------------------------------------------

/**
 * 把「已经到点」的任务补写进历史并删除。
 *
 * 一次事务完成，避免「历史写了、任务还在」的中间态 —— 那种情况下
 * 下一次重排会再补一次（好在有唯一索引兜底），但任务会一直留着直到下次。
 */
async function reconcileFiredJobs(db: SQLiteDatabase): Promise<void> {
  const due = await listDueJobs(db, nowMs());
  if (due.length === 0) return;

  await db.withTransactionAsync(async () => {
    for (const job of due) {
      await insertHistory(db, { itemId: job.itemId, kind: job.kind, firedAt: job.fireAt });
      await deleteJobCore(db, job.itemId, job.kind);
    }
  });
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

async function buildPlan(
  db: SQLiteDatabase,
  now: Millis,
  reRemindIntervalDays: number,
  defaultNotifyTime: string,
): Promise<ReschedulePlan> {
  const items = await listItems(db);
  const predictions = await computePredictions(db, items, now);
  const lastFiredAtByItem = await listLastFiredAtByItem(db);
  // 已排且尚未到点的任务：P0 在后台时会沿用它的时间，见下面的说明
  const pendingByKey = new Map(
    (await listJobs(db)).map((job) => [jobKey(job.itemId, job.kind), job] as const),
  );

  const foreground = AppState.currentState === 'active';
  const todayStart = startOfDayMs(now);
  const p0: PlannedP0[] = [];
  const digestEntries: DigestEntry[] = [];

  for (const item of items) {
    const prediction = predictions.get(item.id);
    if (!prediction) continue;

    let decision = evaluateReminder({
      item,
      prediction,
      now,
      lastFiredAt: lastFiredAtByItem.get(item.id) ?? null,
      reRemindIntervalDays,
    });

    // 静默期只能逐条查（repo 里没有批量版本），所以只对「真会发通知」的候选查，
    // 不为每个物品都多付一次 SQL。静默期只作用于 P0 以外（见 reminder.ts）。
    if (decision.shouldNotify && (decision.priority ?? 0) > 0) {
      const snoozedUntil = await getSnoozedUntil(db, item.id);
      if (snoozedUntil !== null) {
        decision = evaluateReminder({
          item,
          prediction,
          now,
          lastFiredAt: lastFiredAtByItem.get(item.id) ?? null,
          snoozedUntil,
          reRemindIntervalDays,
        });
      }
    }

    if (!decision.shouldNotify || decision.priority === null) continue;

    if (decision.priority === 0) {
      // P0 同日去重（依赖补计入账写下的历史）
      if ((await countFiredSince(db, item.id, 'out_of_stock', todayStart)) > 0) continue;

      const pending = pendingByKey.get(jobKey(item.id, 'out_of_stock'));
      p0.push({
        itemId: item.id,
        itemName: item.name,
        // 前台：立刻弹出来，用户正看着屏幕，等 60 秒没有意义。
        // 后台：沿用已排任务的时间（如果有）—— 否则每次重排都把 P0 往后顺延
        // 60 秒，只要有东西在反复触发重排，这条通知就永远响不了。
        immediate: foreground,
        fireAt: foreground
          ? now
          : (pending?.fireAt ?? now + BACKGROUND_P0_DELAY_MS),
      });
      continue;
    }

    digestEntries.push(toDigestEntry(item, prediction));
  }

  const maxP0 = Math.max(0, MAX_PENDING_NOTIFICATIONS - 1);
  return {
    p0: p0.sort((a, b) => a.itemId - b.itemId).slice(0, maxP0),
    digest: await buildDigest(db, digestEntries, now, defaultNotifyTime),
  };
}

/**
 * 每日摘要：所有「该提醒但没到 P0」的物品合并成一条。
 *
 * 时刻取 `nextFirePoint(defaultNotifyTime)`（今天还没到就今天、过了就明天），
 * 若**今天已经发过**摘要，再顺延一天。
 *
 * 顺延要加上「候选时刻也在今天」这个条件：`nextFirePoint` 在 09:00 之后
 * 本来就返回明天，那种情况下再加一天会平白推到后天。
 */
async function buildDigest(
  db: SQLiteDatabase,
  entries: readonly DigestEntry[],
  now: Millis,
  defaultNotifyTime: string,
): Promise<PlannedDigest | null> {
  const copy = buildDailyDigestCopy(entries);
  if (!copy) return null;

  let fireAt = nextFirePoint(defaultNotifyTime, now);
  const lastDigestAt = await getLastDigestFiredAt(db);
  if (lastDigestAt !== null && isSameDayMs(lastDigestAt, now) && isSameDayMs(fireAt, now)) {
    fireAt = addDaysMs(fireAt, 1);
  }

  return { fireAt, title: copy.title, body: copy.body };
}

async function computePredictions(
  db: SQLiteDatabase,
  items: readonly Item[],
  now: Millis,
): Promise<Map<number, Prediction>> {
  const predictions = new Map<number, Prediction>();
  if (items.length === 0) return predictions;

  // 与列表页共用同一个窗口起点，保证两处算出的日均一致
  const samplesByItem = await listConsumptionSamplesByItem(db, maxSampleWindowStart(items, now));
  for (const item of items) {
    predictions.set(item.id, predictItem({ item, samples: samplesByItem.get(item.id) ?? [], now }));
  }
  return predictions;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 落计划：先取消旧的，再排新的，最后才写签名。
 *
 * 签名**最后**写是刻意的：中途失败（比如原生调度抛错）时签名没变，
 * 下次重排会拿同一份计划重来一遍；反过来先写签名的话，
 * 失败就变成「系统里没通知、而我们以为已经排好了」，只能等数据变化才恢复。
 */
async function applyPlan(db: SQLiteDatabase, plan: ReschedulePlan, signature: string): Promise<void> {
  // 渠道必须存在：否则 Android 8+ 会把通知塞进 Miscellaneous 兜底渠道，
  // 两个重要度（安静 / 紧急）就白分了
  await ensureAndroidChannel();

  const existing = await listJobs(db);
  await cancelJobs(existing);
  await db.withTransactionAsync(async () => {
    for (const job of existing) {
      await deleteJobCore(db, job.itemId, job.kind);
    }
  });

  for (const entry of plan.p0) {
    const copy = buildOutOfStockCopy(entry.itemName);
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: copy.title,
        body: copy.body,
        // route = 点击通知后的落地页，由 useNotificationResponder 解析。
        // 不带 kind：落地页是排期端就定好的产品决策，响应端照着走即可，
        // 不需要它再反过来判断「这是什么类型的通知」
        data: { route: '/item/[id]', itemId: entry.itemId },
      },
      trigger: buildTrigger(entry.fireAt, NOTIFICATION_CHANNEL_URGENT_ID, entry.immediate),
    });
    await upsertJob(db, {
      itemId: entry.itemId,
      kind: 'out_of_stock',
      notificationId,
      fireAt: entry.fireAt,
      reason: 'out_of_stock',
    });
  }

  if (plan.digest) {
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: plan.digest.title,
        body: plan.digest.body,
        data: { route: '/shopping' },
      },
      trigger: buildTrigger(plan.digest.fireAt, NOTIFICATION_CHANNEL_ID, false),
    });
    await upsertJob(db, {
      itemId: null,
      kind: 'daily_digest',
      notificationId,
      fireAt: plan.digest.fireAt,
      reason: 'daily_digest',
    });
  }

  await setSettingValue(db, SETTINGS_KEYS.notificationPlan, signature);
}

/**
 * 组装 trigger。
 *
 * **Android 的渠道挂在 trigger 上，不是 content 上**：`null` 虽然表示「立即投递」，
 * 但在 Android 上会因此丢掉渠道、落进系统兜底的 Miscellaneous。
 * 所以立即投递时传 `{ channelId }`（文档里叫 ChannelAwareTriggerInput，
 * 语义就是「带上渠道、马上发」），iOS 没有渠道概念，沿用 `null` 即可。
 */
function buildTrigger(
  fireAt: Millis,
  channelId: string,
  immediate: boolean,
): Notifications.NotificationTriggerInput {
  if (immediate) {
    return Platform.OS === 'android' ? { channelId } : null;
  }
  return {
    type: Notifications.SchedulableTriggerInputTypes.DATE,
    date: fireAt,
    channelId,
  };
}

/**
 * 取消系统里所有已排的通知，**不碰 `notification_jobs` 表**。
 *
 * 单独导出给备份流程用。那里的顺序是死的：
 * **先在这里取消 → 再清表 → 再插数据 → 最后重排**
 * （见 `services/backup/import.ts`）。原因是 identifier 只存在
 * `notification_jobs` 里，表一清就再也找不回那些通知取消了 ——
 * 它们会在旧时间点照响不误，而 App 已经不认识它们了。
 *
 * **绝不能被放进事务**：`cancelScheduledNotificationAsync` 是异步原生调用，
 * 在 SQLite 事务开着的时候调它，事务的锁与原生调用的等待会互相拖住。
 *
 * 失败这里不会抛出，逐条取消内部的告警已经够 ——
 * 调它的场景（备份导入）不该因为取消失败就整体停下来，
 * 更不该因此在事务外面多一条没被处理的异常路径。
 */
export async function cancelAllScheduledJobs(db: SQLiteDatabase): Promise<void> {
  try {
    await cancelJobs(await listJobs(db));
  } catch (error) {
    console.warn(
      '[scheduler] 取消全部通知失败：',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * 逐条取消系统里的通知。
 *
 * 刻意不用 `cancelAllScheduledNotificationsAsync()`：那是按 App 维度全清，
 * 一旦将来有别的东西也排了通知（另一个模块、另一个库），会被顺手清掉。
 * `notification_jobs` 表才是我们自己的账本，照着它逐条取消更精准。
 *
 * 单条失败只告警不抛出：identifier 可能已经失效（比如用户重装过系统），
 * 一条取消失败不该让整次重排半途而废、把剩下的通知留在系统里。
 */
async function cancelJobs(jobs: readonly NotificationJob[]): Promise<void> {
  for (const job of jobs) {
    try {
      await Notifications.cancelScheduledNotificationAsync(job.notificationId);
    } catch (error) {
      console.warn(
        `[scheduler] 取消通知失败（identifier=${job.notificationId}）：`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

function jobKey(itemId: number | null, kind: ReminderKind): string {
  return `${itemId ?? 'null'}:${kind}`;
}

/**
 * 计划的稳定序列化 → 32 位 FNV-1a 哈希。
 *
 * 只进签名的是「真的会影响系统里排了什么」的字段：谁、几点、什么内容。
 * 物品名变了、估算标记变了都会改文案，所以摘要连 title / body 一起进签名 ——
 * 否则改了名字却沿用旧文案的通知，要等改时间才被换掉。
 */
function planSignature(plan: ReschedulePlan): string {
  const payload = JSON.stringify({
    v: PLAN_VERSION,
    p0: plan.p0.map((entry) => [entry.itemId, entry.fireAt]),
    digest: plan.digest ? [plan.digest.fireAt, plan.digest.title, plan.digest.body] : null,
  });

  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    // 位运算保持 32 位无符号：JS 的 ^ 与 << 会当成有符号数，
    // 不 >>> 0 的话结果与平台无关但仍可能溢出成负数
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
