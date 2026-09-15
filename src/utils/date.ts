import { addDays, differenceInCalendarDays, endOfDay, format, set, startOfDay } from 'date-fns';
import type { ISODate, Millis, MonthKey } from '@/types/models';

/**
 * 日期工具（date-fns 的唯一封装层）。
 *
 * 全项目**只允许**通过这里做日期运算，理由：
 * 1. 统一「业务日」语义 —— 所有日边界都按**设备本地时区**切分；
 * 2. 万一将来替换日期库，改动只在这一个文件；
 * 3. 避免各处直接 new Date() 拼字符串导致时区串味。
 */

export const MS_PER_DAY = 86_400_000;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** 当前时间戳 */
export function nowMs(): Millis {
  return Date.now();
}

/** 当天 00:00:00.000（本地时区） */
export function startOfDayMs(ms: Millis = Date.now()): Millis {
  return startOfDay(new Date(ms)).getTime();
}

/** 当天 23:59:59.999（本地时区） */
export function endOfDayMs(ms: Millis = Date.now()): Millis {
  return endOfDay(new Date(ms)).getTime();
}

/** 加减天数（按自然日，自动处理夏令时） */
export function addDaysMs(ms: Millis, days: number): Millis {
  return addDays(new Date(ms), days).getTime();
}

/** 减天数 */
export function subDaysMs(ms: Millis, days: number): Millis {
  return addDays(new Date(ms), -days).getTime();
}

/** 两个时间戳相差几个自然日（later - earlier，可负） */
export function diffInCalendarDays(laterMs: Millis, earlierMs: Millis): number {
  return differenceInCalendarDays(new Date(laterMs), new Date(earlierMs));
}

/** 是否同一天（本地时区） */
export function isSameDayMs(a: Millis, b: Millis): boolean {
  return startOfDayMs(a) === startOfDayMs(b);
}

/** 时间戳 → 业务日 'YYYY-MM-DD'（本地时区） */
export function toISODate(ms: Millis): ISODate {
  return format(new Date(ms), 'yyyy-MM-dd');
}

/** 校验是否是合法的业务日字符串（含 2 月 30 日这类不存在的日期） */
export function isValidISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const matched = ISO_DATE_PATTERN.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  );
}

/**
 * 业务日 'YYYY-MM-DD' → 当天 00:00:00.000（本地时区）。
 * 手工拆分构造 Date，避免 `new Date('2026-09-12')` 被当成 UTC 解析。
 */
export function fromISODate(iso: ISODate): Millis {
  const matched = ISO_DATE_PATTERN.exec(iso);
  if (!matched) {
    throw new Error(`fromISODate: 非法日期字符串 "${iso}"，应形如 2026-09-12`);
  }
  return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime();
}

/** 业务日加减天数 */
export function shiftISODate(iso: ISODate, days: number): ISODate {
  return toISODate(addDaysMs(fromISODate(iso), days));
}

/** 两个业务日相差的自然天数（later - earlier，可负） */
export function daysBetweenISO(later: ISODate, earlier: ISODate): number {
  return diffInCalendarDays(fromISODate(later), fromISODate(earlier));
}

/** 解析 'HH:mm'；非法返回 null */
export function parseClock(clock: string): { hours: number; minutes: number } | null {
  const matched = CLOCK_PATTERN.exec(clock.trim());
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/** 校验 'HH:mm' */
export function isValidClock(value: unknown): boolean {
  return typeof value === 'string' && parseClock(value) !== null;
}

/**
 * 把某个自然日的时刻设为指定 'HH:mm'（本地时区）。
 * 通知调度用它把「目标日」和「物品自己的提醒时刻」拼成触发时间。
 */
export function withLocalClock(dayMs: Millis, clock: string): Millis {
  const parsed = parseClock(clock);
  if (!parsed) {
    throw new Error(`withLocalClock: 非法时刻 "${clock}"，应形如 09:00`);
  }
  return set(new Date(dayMs), {
    hours: parsed.hours,
    minutes: parsed.minutes,
    seconds: 0,
    milliseconds: 0,
  }).getTime();
}

/**
 * 下一个「到达 `clock` 时刻」的时间戳（本地时区）。
 *
 * 每天的提醒时刻是「几点几分」而不是「距现在多少秒」，
 * 所以每次都要先落在**今天**的那个时刻上，再判断它是否已经过去：
 * - 还没到（今天的 09:00 晚于现在）→ 就是今天；
 * - 已经过了 / 正好是这个瞬间 → 顺延到明天同一钟点。
 *
 * 「正好等于」算已过而不是今天立刻触发：重排可能在 09:00:00.000 整被调用，
 * 排一个 `fire_at === now` 的通知会得到一条即刻过期、"过去完成时"的提醒。
 *
 * 顺延走 `addDaysMs`（按自然日而不是 +24h），夏令时的那天也是同一个钟点。
 * 跨午夜、跨月、跨年都由 `set()` 落在具体日期上自然成立，不需要额外分支。
 *
 * @param clock 'HH:mm'，非法值会抛（同 `withLocalClock`）
 */
export function nextFirePoint(clock: string, ms: Millis = Date.now()): Millis {
  const todayAt = withLocalClock(startOfDayMs(ms), clock);
  return todayAt > ms ? todayAt : addDaysMs(todayAt, 1);
}

/** 时间戳 → 月份键 'YYYY-MM' */
export function toMonthKey(ms: Millis): MonthKey {
  return format(new Date(ms), 'yyyy-MM');
}

/** 给定月份键取该月首/末时间戳（本地时区） */
export function monthRangeOf(anchorMs: Millis): {
  monthKey: MonthKey;
  startMs: Millis;
  endMs: Millis;
} {
  const date = new Date(anchorMs);
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
  return {
    monthKey: format(date, 'yyyy-MM'),
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

/** 月份键 → 该月首/末时间戳；非法返回 null */
export function monthRangeOfKey(monthKey: MonthKey): {
  startMs: Millis;
  endMs: Millis;
} | null {
  const matched = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (month < 1 || month > 12) return null;
  return {
    startMs: new Date(year, month - 1, 1).getTime(),
    endMs: new Date(year, month, 0, 23, 59, 59, 999).getTime(),
  };
}

/**
 * 月份键加减月份数（'2026-01' - 1 → '2025-12'）。
 *
 * 换算走「年×12 + 月」的整数轴，再除回去：跨年、负增量都自然成立，
 * 不需要分别处理 1 月往前、12 月往后两种边界。
 */
export function shiftMonthKey(monthKey: MonthKey, deltaMonths: number): MonthKey {
  const matched = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!matched) {
    throw new Error(`shiftMonthKey: 非法月份键 "${monthKey}"，应形如 2026-09`);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (month < 1 || month > 12) {
    throw new Error(`shiftMonthKey: 月份超出范围 "${monthKey}"`);
  }
  const axis = year * 12 + (month - 1) + Math.trunc(deltaMonths);
  const nextYear = Math.floor(axis / 12);
  const nextMonth = ((axis % 12) + 12) % 12;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth + 1).padStart(2, '0')}`;
}

/** 月份键展示：'2026年9月'；`withYear` 为 false 时只留 '9月' */
export function formatMonthKeyCN(monthKey: MonthKey, withYear = true): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!matched) return monthKey;
  const year = matched[1];
  const month = Number(matched[2]);
  return withYear ? `${year}年${month}月` : `${month}月`;
}

type DateInput = Millis | ISODate;

function toDate(input: DateInput): Date {
  return typeof input === 'string' ? new Date(fromISODate(input)) : new Date(input);
}

/** 'M月D日' */
export function formatDateCN(input: DateInput): string {
  const date = toDate(input);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 'YYYY年M月D日' */
export function formatFullDateCN(input: DateInput): string {
  const date = toDate(input);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 'YYYY-MM-DD HH:mm' */
export function formatDateTimeCN(ms: Millis): string {
  return format(new Date(ms), 'yyyy-MM-dd HH:mm');
}

/** 'HH:mm' */
export function formatClock(ms: Millis): string {
  return format(new Date(ms), 'HH:mm');
}

/** 把数值夹到 [min, max] 区间内的整数天 */
export function clampDays(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
