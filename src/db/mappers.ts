import { normalizeCategory } from '@/constants/categories';
import type {
  Item,
  ItemRow,
  MovementSource,
  MovementType,
  NotificationHistory,
  NotificationHistoryRow,
  NotificationJob,
  NotificationJobRow,
  ReminderKind,
  ShoppingListItem,
  ShoppingListItemRow,
  ShoppingSource,
  ShoppingStatus,
  StockMovement,
  StockMovementRow,
} from '@/types/models';

/**
 * 行模型（snake_case + 0/1 + string 枚举）→ 领域模型（camelCase + boolean + 联合类型）的映射。
 *
 * 所有映射都做**收窄兜底**：数据库里的枚举值是 TEXT，理论上可能因为历史数据、
 * 手工改库、备份导入而越界。宁可回落到安全默认值，也不要让 UI 拿到非法值。
 */

function toBoolean(value: number | null | undefined): boolean {
  return value === 1;
}

function toNullableNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value;
}

/**
 * 只接受**正数**，其余一律回落成 null。
 * 目前给「预计使用周期」用：这一列会被预测层拿去做除数，
 * 0 / 负数 / NaN 会算出 Infinity 或一个荒谬的耗尽日。
 * 与其让脏数据一路漂到 UI，不如在读的时候就当成「没填」。
 */
function toPositiveNumberOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const MOVEMENT_TYPES: ReadonlySet<string> = new Set<MovementType>([
  'consume',
  'purchase',
  'adjust',
  'discard',
]);

const MOVEMENT_SOURCES: ReadonlySet<string> = new Set<MovementSource>([
  'quick',
  'manual',
  'import',
]);

const REMINDER_KINDS: ReadonlySet<string> = new Set<ReminderKind>([
  'buy_reminder',
  'out_of_stock',
  'daily_digest',
]);

const SHOPPING_SOURCES: ReadonlySet<string> = new Set<ShoppingSource>(['auto', 'manual']);

const SHOPPING_STATUSES: ReadonlySet<string> = new Set<ShoppingStatus>([
  'pending',
  'bought',
  'skipped',
]);

export function toMovementType(value: unknown): MovementType {
  return typeof value === 'string' && MOVEMENT_TYPES.has(value)
    ? (value as MovementType)
    : 'adjust';
}

export function toMovementSource(value: unknown): MovementSource {
  return typeof value === 'string' && MOVEMENT_SOURCES.has(value)
    ? (value as MovementSource)
    : 'manual';
}

export function toReminderKind(value: unknown): ReminderKind {
  return typeof value === 'string' && REMINDER_KINDS.has(value)
    ? (value as ReminderKind)
    : 'buy_reminder';
}

export function toShoppingSource(value: unknown): ShoppingSource {
  return typeof value === 'string' && SHOPPING_SOURCES.has(value)
    ? (value as ShoppingSource)
    : 'manual';
}

export function toShoppingStatus(value: unknown): ShoppingStatus {
  return typeof value === 'string' && SHOPPING_STATUSES.has(value)
    ? (value as ShoppingStatus)
    : 'pending';
}

export function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    name: row.name,
    category: normalizeCategory(row.category),
    unit: row.unit,
    packSize: row.pack_size,
    packUnit: row.pack_unit,
    icon: row.icon,
    color: row.color,
    stock: row.stock,
    safetyStock: row.safety_stock,
    quickConsumeQty: row.quick_consume_qty,
    remindDays: row.remind_days,
    leadDays: row.lead_days,
    avgWindowDays: row.avg_window_days,
    notifyEnabled: toBoolean(row.notify_enabled),
    notifyTime: row.notify_time,
    lastPrice: toNullableNumber(row.last_price),
    trackingStartedAt: row.tracking_started_at,
    note: row.note,
    estimatedCycleDays: toPositiveNumberOrNull(row.estimated_cycle_days),
    isArchived: toBoolean(row.is_archived),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapMovement(row: StockMovementRow): StockMovement {
  return {
    id: row.id,
    itemId: row.item_id,
    type: toMovementType(row.type),
    quantity: row.quantity,
    unitPrice: toNullableNumber(row.unit_price),
    totalPrice: toNullableNumber(row.total_price),
    occurredAt: row.occurred_at,
    source: toMovementSource(row.source),
    note: row.note,
    createdAt: row.created_at,
  };
}

export function mapShoppingItem(row: ShoppingListItemRow): ShoppingListItem {
  return {
    id: row.id,
    itemId: row.item_id,
    name: row.name,
    unit: row.unit,
    quantity: row.quantity,
    unitPrice: toNullableNumber(row.unit_price),
    source: toShoppingSource(row.source),
    status: toShoppingStatus(row.status),
    priority: row.priority,
    note: row.note,
    sortOrder: row.sort_order,
    addedAt: row.added_at,
    resolvedAt: row.resolved_at,
  };
}

export function mapNotificationJob(row: NotificationJobRow): NotificationJob {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: toReminderKind(row.kind),
    notificationId: row.notification_id,
    fireAt: row.fire_at,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function mapNotificationHistory(row: NotificationHistoryRow): NotificationHistory {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: toReminderKind(row.kind),
    firedAt: row.fired_at,
    dismissed: toBoolean(row.dismissed),
    snoozedUntil: row.snoozed_until,
  };
}
