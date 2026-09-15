import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_APP_SETTINGS, SETTINGS_KEYS } from '@/constants/defaults';
import type { AppSettings } from '@/types/models';
import { isValidClock, nowMs } from '@/utils/date';
import { clampNumber, toFiniteNumber } from '@/utils/number';

/**
 * 全局设置仓库（KV 表）。
 *
 * 应用的整份设置以**单个 JSON** 存在 `app_settings` 表的 `app_settings` 键下。
 * 选择整份存储而不是逐字段一行，是因为：设置项会随版本增删，
 * 整份 JSON + 「读取时与默认值合并」的策略天然向前兼容，
 * 老版本备份导入新版本时缺字段也不会崩。
 */

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  return fallback;
}

function coerceInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = toFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(clampNumber(parsed, min, max));
}

function coerceNullableNumber(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined) return fallback;
  const parsed = toFiniteNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coerceNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * 把任意来源（老版本 JSON、备份文件、手工改库）的对象收敛成合法的 AppSettings。
 * 每个字段独立兜底，任何一个字段坏掉都不会拖垮整份设置。
 */
export function sanitizeAppSettings(raw: unknown): AppSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>;
  const clock = coerceNonEmptyString(source.defaultNotifyTime, DEFAULT_APP_SETTINGS.defaultNotifyTime);

  return {
    notificationsEnabled: coerceBoolean(
      source.notificationsEnabled,
      DEFAULT_APP_SETTINGS.notificationsEnabled,
    ),
    defaultRemindDays: coerceInteger(
      source.defaultRemindDays,
      DEFAULT_APP_SETTINGS.defaultRemindDays,
      0,
      365,
    ),
    defaultLeadDays: coerceInteger(
      source.defaultLeadDays,
      DEFAULT_APP_SETTINGS.defaultLeadDays,
      0,
      365,
    ),
    defaultWindowDays: coerceInteger(
      source.defaultWindowDays,
      DEFAULT_APP_SETTINGS.defaultWindowDays,
      1,
      365,
    ),
    defaultNotifyTime: isValidClock(clock) ? clock : DEFAULT_APP_SETTINGS.defaultNotifyTime,
    reRemindIntervalDays: coerceInteger(
      source.reRemindIntervalDays,
      DEFAULT_APP_SETTINGS.reRemindIntervalDays,
      1,
      90,
    ),
    restockCoverDays: coerceInteger(
      source.restockCoverDays,
      DEFAULT_APP_SETTINGS.restockCoverDays,
      1,
      365,
    ),
    currencySymbol: coerceNonEmptyString(
      source.currencySymbol,
      DEFAULT_APP_SETTINGS.currencySymbol,
    ),
    lastBackupAt: coerceNullableNumber(source.lastBackupAt, null),
    lastRestoreAt: coerceNullableNumber(source.lastRestoreAt, null),
  };
}

// ---------------------------------------------------------------------------
// 应用设置
// ---------------------------------------------------------------------------

/** 读取应用设置并与默认值合并；**不开事务** */
export async function readAppSettingsCore(db: SQLiteDatabase): Promise<AppSettings> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    [SETTINGS_KEYS.appSettings],
  );
  if (!row) return { ...DEFAULT_APP_SETTINGS };
  try {
    return sanitizeAppSettings(JSON.parse(row.value));
  } catch {
    // JSON 损坏时回落默认值，不让 App 卡在启动阶段
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/** 整份写入应用设置；**不开事务** */
export async function writeAppSettingsCore(
  db: SQLiteDatabase,
  settings: AppSettings,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [SETTINGS_KEYS.appSettings, JSON.stringify(settings), nowMs()],
  );
}

export async function getAppSettings(db: SQLiteDatabase): Promise<AppSettings> {
  return readAppSettingsCore(db);
}

/**
 * 局部更新应用设置（含事务的「读 → 合并 → 写」）。
 * 若调用方自己已在事务里，请改用 `readAppSettingsCore` + `writeAppSettingsCore`。
 */
export async function updateAppSettings(
  db: SQLiteDatabase,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  let merged: AppSettings | null = null;
  await db.withTransactionAsync(async () => {
    const current = await readAppSettingsCore(db);
    merged = sanitizeAppSettings({ ...current, ...patch });
    await writeAppSettingsCore(db, merged);
  });
  if (!merged) {
    throw new Error('更新设置失败：事务未返回结果');
  }
  return merged;
}

/** 重置为默认设置 */
export async function resetAppSettings(db: SQLiteDatabase): Promise<AppSettings> {
  await writeAppSettingsCore(db, DEFAULT_APP_SETTINGS);
  return { ...DEFAULT_APP_SETTINGS };
}

// ---------------------------------------------------------------------------
// 通用 KV（留给备份时间戳等零散键）
// ---------------------------------------------------------------------------

export async function getSettingValue(
  db: SQLiteDatabase,
  key: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setSettingValue(
  db: SQLiteDatabase,
  key: string,
  value: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowMs()],
  );
}

export async function removeSettingValue(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync('DELETE FROM app_settings WHERE key = ?', [key]);
}

export async function listSettings(
  db: SQLiteDatabase,
): Promise<Array<{ key: string; value: string }>> {
  return db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM app_settings ORDER BY key ASC',
  );
}

/** 清空全部设置（重置数据用） */
export async function clearAllSettings(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM app_settings');
}
