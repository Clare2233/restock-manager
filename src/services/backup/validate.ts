import { isValidClock } from '@/utils/date';
import {
  DEFAULT_LEAD_DAYS,
  DEFAULT_NOTIFY_TIME,
  DEFAULT_REMIND_DAYS,
  DEFAULT_WINDOW_DAYS,
} from '@/constants/defaults';
import {
  toMovementSource,
  toMovementType,
  toReminderKind,
  toShoppingSource,
  toShoppingStatus,
} from '@/db/mappers';
import { assertMovementSign } from '@/db/repositories/movements.repo';
import { sanitizeAppSettings } from '@/db/repositories/settings.repo';
import type { AppSettings } from '@/types/models';
import type {
  BackupFile,
  BackupHistoryEntry,
  BackupItem,
  BackupMovement,
  BackupShoppingItem,
  BackupSummary,
} from '@/types/backup';
import { BACKUP_VERSION } from '@/types/backup';

/**
 * 备份文件的校验 —— **纯函数，不碰数据库，也不 import 任何 expo 模块**。
 *
 * 正因为纯，它才能在 Node 里被 `scripts/backup-smoke.mjs` 直接跑：
 * 「选错文件」「手改坏了」「版本太新」这些分支在真机上要靠 EkBox 手搓一个坏 JSON
 * 才能复现，在这里只是一行对象字面量。
 *
 * ## 为什么这份文件存在，而不是让 SQLite 自己报错
 * SQLite 的 CHECK / NOT NULL / 外键确实会在插入时挡住脏数据，
 * 但那时已经**进到事务里**了：虽然会回滚、数据不会坏，用户看到的却只有
 * 「导入失败」，不知道是哪一行、哪个字段。
 * 真正的坑还有一层：CREATE TABLE 的检查覆盖不了「跨行一致性」
 * （比如 operation.itemId 指向不存在的物品）——那种数据插得进去、
 * 要等到页面渲染时才炸。所以参照完整性必须在这里查。
 *
 * ## 严格 vs 宽松的口径（重要）
 * - ** identities 字段必须有且类型正确**：id / name / unit / 时间戳 / 数量。
 *   缺了它们这条记录就没有意义，报出来让用户在动数据之前看到。
 * - **有库默认值的字段可以省略**（`packSize` / `remindDays` / `notifyEnabled` …）。
 *   备份是给人手改的，要求每行写全 20 个字段是跟用户过不去；
 *   省略时回落的默认值与 `db/schema.ts` 的 DEFAULT **逐字段对齐**。
 * - **枚举值错了就报错，不静默兜底**。`purchase` 写成 `purchase ` 之类时，
 *   mappers 会把它收窄成 `adjust` —— 语义从「买了 3 个」变成「盘点差 3 个」，
 *   库存对不上账。宁可不导入。
 */

/** 校验失败专用；只在 `validateBackupFile` 内部抛、内部接 */
class BackupValidationError extends Error {}

type UnknownRecord = Record<string, unknown>;

export interface ValidatedBackup {
  ok: true;
  file: BackupFile;
  /** 供导入前的二次确认展示的量级统计 */
  summary: BackupSummary;
}

export type ValidatedBackupResult = ValidatedBackup | { ok: false; error: string };

// ---------------------------------------------------------------------------
// 基础取值助手（缺字段 / 类型不对都会在第一时间说清楚）
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '缺失';
  if (typeof value === 'string') return `"${value}"`;
  if (Array.isArray(value)) return `数组(${value.length})`;
  return String(value);
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackupValidationError(`${label}必须是一个对象，实际收到 ${describe(value)}`);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BackupValidationError(`${label}必须是一个数组，实际收到 ${describe(value)}`);
  }
  return value;
}

/** 必须存在的数组：省略也算错 —— 少了 items 的文件基本不是本 App 导出的 */
function requireArray(source: UnknownRecord, key: string, label: string): unknown[] {
  if (source[key] === undefined) {
    throw new BackupValidationError(`${label}缺少 ${key} 数组，它可能不是本 App 导出的备份文件`);
  }
  return asArray(source[key], `${label}的 ${key}`);
}

function requireNumber(source: UnknownRecord, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BackupValidationError(`${label}的 ${key} 必须是数字，实际收到 ${describe(value)}`);
  }
  return value;
}

function requirePositiveId(source: UnknownRecord, key: string, label: string): number {
  const value = requireNumber(source, key, label);
  if (!Number.isInteger(value) || value < 1) {
    throw new BackupValidationError(
      `${label}的 ${key} 必须是正整数，实际收到 ${describe(value)}`,
    );
  }
  return value;
}

function requireText(source: UnknownRecord, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BackupValidationError(
      `${label}的 ${key} 必须是非空字符串，实际收到 ${describe(value)}`,
    );
  }
  return value.trim();
}

/** 本地时刻 'HH:mm' */
function requireClock(source: UnknownRecord, key: string, label: string): string {
  const value = source[key];
  if (!isValidClock(value)) {
    throw new BackupValidationError(
      `${label}的 ${key} 必须是 'HH:mm' 格式的时刻（如 09:00），实际收到 ${describe(value)}`,
    );
  }
  return String(value);
}

/** 可省略的数字；省略或 null 时回落 `fallback` */
function optionalNumber(
  source: UnknownRecord,
  key: string,
  label: string,
  fallback: number,
): number {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return requireNumber(source, key, label);
}

/** 可省略的数字，且不得小于 `min` —— 负数 / 0 会让预测层算出荒谬的耗尽日 */
function optionalAtLeast(
  source: UnknownRecord,
  key: string,
  label: string,
  fallback: number,
  min: number,
): number {
  const value = optionalNumber(source, key, label, fallback);
  if (value < min) {
    throw new BackupValidationError(`${label}的 ${key} 不能小于 ${min}，实际收到 ${value}`);
  }
  return value;
}

/** 可空数字：缺失 / null → null */
function optionalNullableNumber(
  source: UnknownRecord,
  key: string,
  label: string,
): number | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  return requireNumber(source, key, label);
}

/** 可空字符串：缺失 / null / 空白 → null */
function optionalNullableText(source: UnknownRecord, key: string, label: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new BackupValidationError(`${label}的 ${key} 必须是字符串，实际收到 ${describe(value)}`);
  }
  return value.trim() === '' ? null : value.trim();
}

/** 必须为布尔：JSON 里常见的 0/1 也要拒绝，否则「真/假」会被 JS 的真值总管（1 和 'false' 都真）搞反 */
function optionalBoolean(
  source: UnknownRecord,
  key: string,
  label: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new BackupValidationError(
      `${label}的 ${key} 必须是 true 或 false，实际收到 ${describe(value)}`,
    );
  }
  return value;
}

/**
 * 枚举字段：直接用 mappers 的收窄函数判断是否合法。
 *
 * 为什么这样写而不是自己维护一份允许值清单：那样必须把
 * `MOVEMENT_TYPES` 之类的集合**誊第二遍**，将来加一种流水类型时
 * 两边迟早漂移 —— 而这正是最隐蔽的一类 bug（一边认、一边不认）。
 * 用「收窄函数能不能把值原样还回来」来判断，只有一处事实来源。
 */
function requireEnum<T extends string>(
  value: unknown,
  narrow: (value: unknown) => T,
  label: string,
  hint: string,
): T {
  if (typeof value !== 'string') {
    throw new BackupValidationError(`${label}必须是字符串，可选值：${hint}`);
  }
  const narrowed = narrow(value);
  if (narrowed !== value) {
    throw new BackupValidationError(`${label}的值 ${describe(value)} 不被支持，可选值：${hint}`);
  }
  return narrowed;
}

/** 可空的外键：非 null 时必须指向文件里存在的物品 */
function optionalNullableItemId(
  source: UnknownRecord,
  key: string,
  label: string,
  knownItemIds: ReadonlySet<number>,
): number | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  const itemId = requirePositiveId(source, key, label);
  if (!knownItemIds.has(itemId)) {
    throw new BackupValidationError(`${label}的 ${key}=${itemId} 在 items 里找不到对应物品`);
  }
  return itemId;
}

// ---------------------------------------------------------------------------
// 实体解析
// ---------------------------------------------------------------------------

function parseItem(entry: unknown, index: number): BackupItem {
  const label = `第 ${index + 1} 件物品`;
  const source = asRecord(entry, label);

  return {
    id: requirePositiveId(source, 'id', label),
    name: requireText(source, 'name', label),
    category: requireText(source, 'category', label),
    unit: requireText(source, 'unit', label),
    packSize: optionalAtLeast(source, 'packSize', label, 1, 1),
    packUnit: optionalNullableText(source, 'packUnit', label),
    icon: optionalNullableText(source, 'icon', label),
    color: optionalNullableText(source, 'color', label),
    safetyStock: optionalAtLeast(source, 'safetyStock', label, 0, 0),
    quickConsumeQty: optionalAtLeast(source, 'quickConsumeQty', label, 1, 0),
    remindDays: optionalAtLeast(source, 'remindDays', label, DEFAULT_REMIND_DAYS, 0),
    leadDays: optionalAtLeast(source, 'leadDays', label, DEFAULT_LEAD_DAYS, 0),
    avgWindowDays: optionalAtLeast(source, 'avgWindowDays', label, DEFAULT_WINDOW_DAYS, 1),
    note: optionalNullableText(source, 'note', label),
    estimatedCycleDays: optionalNullableNumber(source, 'estimatedCycleDays', label),
    notifyEnabled: optionalBoolean(source, 'notifyEnabled', label, true),
    notifyTime: source.notifyTime === undefined
      ? DEFAULT_NOTIFY_TIME
      : requireClock(source, 'notifyTime', label),
    lastPrice: optionalNullableNumber(source, 'lastPrice', label),
    trackingStartedAt: optionalNullableNumber(source, 'trackingStartedAt', label),
    isArchived: optionalBoolean(source, 'isArchived', label, false),
    sortOrder: optionalNumber(source, 'sortOrder', label, 0),
    createdAt: requireNumber(source, 'createdAt', label),
    updatedAt: requireNumber(source, 'updatedAt', label),
  };
}

function parseMovement(
  entry: unknown,
  index: number,
  knownItemIds: ReadonlySet<number>,
): BackupMovement {
  const label = `第 ${index + 1} 条流水`;
  const source = asRecord(entry, label);

  const itemId = requirePositiveId(source, 'itemId', label);
  if (!knownItemIds.has(itemId)) {
    throw new BackupValidationError(`${label}的 itemId=${itemId} 在 items 里找不到对应物品`);
  }

  const type = requireEnum(
    source.type,
    toMovementType,
    `${label}的 type`,
    'consume / purchase / adjust / discard',
  );
  const quantity = requireNumber(source, 'quantity', label);
  try {
    // 与 stock_movements 的 CHECK 约束同一套规则；在这里先跑一遍是为了
    // 把「第几条流水」带进报错里 —— 事务里 SQLite 只会说 constraint failed。
    assertMovementSign(type, quantity);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BackupValidationError(`${label}的数量不合法：${reason}`);
  }

  return {
    id: requirePositiveId(source, 'id', label),
    itemId,
    type,
    quantity,
    unitPrice: optionalNullableNumber(source, 'unitPrice', label),
    totalPrice: optionalNullableNumber(source, 'totalPrice', label),
    occurredAt: requireNumber(source, 'occurredAt', label),
    source: requireEnum(
      source.source,
      toMovementSource,
      `${label}的 source`,
      'quick / manual / import',
    ),
    note: optionalNullableText(source, 'note', label),
    createdAt: requireNumber(source, 'createdAt', label),
  };
}

function parseShoppingItem(
  entry: unknown,
  index: number,
  knownItemIds: ReadonlySet<number>,
): BackupShoppingItem {
  const label = `第 ${index + 1} 条清单条目`;
  const source = asRecord(entry, label);

  return {
    id: requirePositiveId(source, 'id', label),
    itemId: optionalNullableItemId(source, 'itemId', label, knownItemIds),
    name: requireText(source, 'name', label),
    unit: optionalNullableText(source, 'unit', label),
    quantity: optionalAtLeast(source, 'quantity', label, 1, 0),
    unitPrice: optionalNullableNumber(source, 'unitPrice', label),
    source: requireEnum(source.source, toShoppingSource, `${label}的 source`, 'auto / manual'),
    status: requireEnum(
      source.status,
      toShoppingStatus,
      `${label}的 status`,
      'pending / bought / skipped',
    ),
    priority: optionalPositiveInt(source, 'priority', label, 3),
    note: optionalNullableText(source, 'note', label),
    sortOrder: optionalNumber(source, 'sortOrder', label, 0),
    addedAt: requireNumber(source, 'addedAt', label),
    resolvedAt: optionalNullableNumber(source, 'resolvedAt', label),
  };
}

function parseHistoryEntry(
  entry: unknown,
  index: number,
  knownItemIds: ReadonlySet<number>,
): BackupHistoryEntry {
  const label = `第 ${index + 1} 条通知历史`;
  const source = asRecord(entry, label);

  return {
    id: requirePositiveId(source, 'id', label),
    // null 表示「不属于任何物品」的通知 —— 目前只有每日摘要
    itemId: optionalNullableItemId(source, 'itemId', label, knownItemIds),
    kind: requireEnum(
      source.kind,
      toReminderKind,
      `${label}的 kind`,
      'buy_reminder / out_of_stock / daily_digest',
    ),
    firedAt: requireNumber(source, 'firedAt', label),
    dismissed: optionalBoolean(source, 'dismissed', label, false),
    snoozedUntil: optionalNullableNumber(source, 'snoozedUntil', label),
  };
}

/** 可省略的正整数 */
function optionalPositiveInt(
  source: UnknownRecord,
  key: string,
  label: string,
  fallback: number,
): number {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return requirePositiveId(source, key, label);
}

/**
 * id 重复检查。
 * 不查也能靠 SQLite 的主键约束挡住（会回滚），但那时用户只看到「导入失败」。
 * 这里直接指出是第几行重复 —— 手改文件时最常见的就是复制粘贴忘了改 id。
 */
function assertUniqueIds(
  rows: ReadonlyArray<{ id: number }>,
  entityLabel: string,
): void {
  const seen = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (seen.has(row.id)) {
      throw new BackupValidationError(
        `${entityLabel}的 id=${row.id} 重复（第 ${index + 1} 行），每条记录的 id 必须唯一`,
      );
    }
    seen.add(row.id);
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 校验一份「已经解析成 JS 值」的备份。
 * 任何一步失败都返回错误文案，**调用方此时不能碰数据库**。
 */
export function validateBackupFile(raw: unknown): ValidatedBackupResult {
  try {
    const root = asRecord(raw, '备份文件');

    const version = requireNumber(root, 'version', '备份文件');
    if (!Number.isInteger(version) || version < 1) {
      throw new BackupValidationError(
        `备份文件的 version 必须是正整数，实际收到 ${describe(version)}`,
      );
    }
    if (version > BACKUP_VERSION) {
      throw new BackupValidationError(
        `备份文件的版本是 ${version}，高于当前 App 支持的 ${BACKUP_VERSION}；` +
          '它来自更新的版本，请升级 App 后再导入',
      );
    }
    // 版本**低于**当前时：目前只有 v1 一种格式，无需分流。
    // 将来加字段时在这里按 version 走各自的解析器，别让老版本文件被硬拦在门外。

    const exportedAt = optionalNullableText(root, 'exportedAt', '备份文件') ?? '';

    const items = requireArray(root, 'items', '备份文件').map(parseItem);
    const knownItemIds = new Set(items.map((item) => item.id));
    assertUniqueIds(items, '物品');

    const rawMovements = requireArray(root, 'movements', '备份文件');
    const rawShopping = requireArray(root, 'shopping_list_items', '备份文件');
    const rawHistory = requireArray(root, 'notification_history', '备份文件');

    const movements = rawMovements.map((entry, index) => parseMovement(entry, index, knownItemIds));
    const shoppingListItems = rawShopping.map((entry, index) =>
      parseShoppingItem(entry, index, knownItemIds),
    );
    const notificationHistory = rawHistory.map((entry, index) =>
      parseHistoryEntry(entry, index, knownItemIds),
    );

    assertUniqueIds(movements, '流水');
    assertUniqueIds(shoppingListItems, '清单条目');
    assertUniqueIds(notificationHistory, '通知历史');

    // settings 缺失时回落默认值（手写裁剪很容易把它删掉），
    // 但要在 summary 里如实标记出来 —— 导入会连带重置设置，
    // 用户有权在确认之前知道这件事。
    const hasSettings = root.settings !== undefined;
    const settings: AppSettings = hasSettings
      ? sanitizeAppSettings(asRecord(root.settings, 'settings'))
      : sanitizeAppSettings(undefined);

    const file: BackupFile = {
      version,
      exportedAt,
      items,
      movements,
      shopping_list_items: shoppingListItems,
      notification_history: notificationHistory,
      settings,
    };

    return {
      ok: true,
      file,
      summary: summarizeBackupFile(file, hasSettings),
    };
  } catch (error) {
    if (error instanceof BackupValidationError) {
      return { ok: false, error: error.message };
    }
    // 不是校验错误 —— 那是代码自身的 bug，抛出去比伪装成「文件坏了」好排查
    throw error;
  }
}

/** 从文本解析并校验。读取文件的部分在 `services/backup/file-transfer.ts` */
export function parseBackupFile(text: string): ValidatedBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `不是合法的 JSON 文件：${reason}` };
  }
  return validateBackupFile(raw);
}

/** 量级统计：给导入前的二次确认用（见 `BackupSummary`） */
export function summarizeBackupFile(file: BackupFile, hasSettings = true): BackupSummary {
  return {
    items: file.items.length,
    movements: file.movements.length,
    shoppingListItems: file.shopping_list_items.length,
    notificationHistory: file.notification_history.length,
    exportedAt: file.exportedAt,
    hasSettings,
  };
}
