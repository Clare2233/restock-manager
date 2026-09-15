import type {
  AppSettings,
  MovementSource,
  MovementType,
  ReminderKind,
  ShoppingSource,
  ShoppingStatus,
} from '@/types/models';

/**
 * 备份文件格式定义。
 *
 * ## 这是一份「给人类读」的契约
 * 需求明确要求 JSON 明文、不加密，方便手动检查和修改。
 * 所以它和库里的行模型（snake_case + 0/1 + TEXT 枚举）刻意保持**两个口径**：
 * - **顶层键名**用需求给定的名字（`shopping_list_items` / `notification_history`）；
 * - **实体内部字段**用 camelCase 领域模型（可读性优先，`notifyEnabled` 比
 *   `notify_enabled` 更不容易在手写时弄错）；
 * - 枚举写成字面量字符串（`type` / `source` / `status` / `kind`），
 *   由 `services/backup/validate.ts` 负责收窄。
 *
 * ## 三条刻意不写进文件的东西
 *
 * 1. **`items` 没有 `stock`**。
 *    `stock` 是「流水求和」的缓存值（见 `db/schema.ts` 的设计说明）。
 *    导出它等于导出第二份可能与流水矛盾的事实源，还会让「手动改库存」
 *    在导入时失效（改了也没用）。所以导入一律 `stock` 落 0，再按流水重算。
 *
 * 2. **没有 `notification_jobs`**。
 *    那张表存的是**系统返回的 identifier**，跨设备、跨重装毫无意义。
 *    导回来反而会让调度器去取消一串不存在的通知，
 *    还会被「已到点即补写历史」当成真的发过通知。
 *    装上 App 之后由 `rescheduleAll({ force: true })` 重新排一遍即可。
 *
 * 3. **没有 `app_settings` 表里的 `notification_plan`**。
 *    它是上一次重排的「计划签名」，纯 defaultValue cache。导进来只会让
 *    首次重排误判「跟上次一样」而被短路掉 —— 结果就是装完没有通知。
 *
 * ## id 的语义
 * 各实体的 `id` **保留原值**。因为 movements / 清单 / 历史都在同一份文件里，
 * `itemId` 外键是自洽的；而导入会先清空各表，不会出现撞号。
 * 保留原值的收益是文件可读（`movement.itemId` 能直接对上某一行物品）。
 */

/**
 * 备份格式版本号。
 *
 * 用**数字**而不是 '1.0' 字符串：判断「能不能读」只需要比较大小，
 * 不会出现 `'1.10' < '1.2'` 这类字符串比较陷阱。
 * 每次**结构**变更都必须 +1，并且读取方永远只接受自己认识的版本。
 */
export const BACKUP_VERSION = 1;

/** 备份文件中的物品。等价于领域模型 `Item` 减去 `stock`（见文件头说明） */
export interface BackupItem {
  id: number;
  name: string;
  /**
   * 分类原文。
   * 刻意不收紧成 `ItemCategory`：备份是外部契约，将来新增分类时老版本 App
   * 读到的未知值不该让整个文件报废 —— 读取时由 `normalizeCategory` 兜底成 'other'。
   */
  category: string;
  unit: string;
  packSize: number;
  packUnit: string | null;
  icon: string | null;
  color: string | null;
  safetyStock: number;
  quickConsumeQty: number;
  remindDays: number;
  leadDays: number;
  avgWindowDays: number;
  note: string | null;
  estimatedCycleDays: number | null;
  notifyEnabled: boolean;
  /** 本地时刻 'HH:mm' */
  notifyTime: string;
  lastPrice: number | null;
  trackingStartedAt: number | null;
  isArchived: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface BackupMovement {
  id: number;
  itemId: number;
  type: MovementType;
  /** 有符号数量：consume/discard 为负，purchase 为正，adjust 任意但不能为 0 */
  quantity: number;
  unitPrice: number | null;
  totalPrice: number | null;
  occurredAt: number;
  source: MovementSource;
  note: string | null;
  createdAt: number;
}

export interface BackupShoppingItem {
  id: number;
  /** null = 与库存无关的手写条目 */
  itemId: number | null;
  name: string;
  unit: string | null;
  quantity: number;
  unitPrice: number | null;
  source: ShoppingSource;
  status: ShoppingStatus;
  priority: number;
  note: string | null;
  sortOrder: number;
  addedAt: number;
  resolvedAt: number | null;
}

export interface BackupHistoryEntry {
  id: number;
  /** null = 不属于任何物品的通知（目前只有每日摘要） */
  itemId: number | null;
  kind: ReminderKind;
  firedAt: number;
  dismissed: boolean;
  snoozedUntil: number | null;
}

/** 备份文件根结构 */
export interface BackupFile {
  version: number;
  /** 导出时刻，`new Date(...).toISOString()`（UTC 瞬时点，便于机器比对） */
  exportedAt: string;
  items: BackupItem[];
  movements: BackupMovement[];
  shopping_list_items: BackupShoppingItem[];
  notification_history: BackupHistoryEntry[];
  settings: AppSettings;
}

/**
 * 备份内容的量级统计，供导入前的二次确认用。
 *
 * 光说「将清空现有数据」太抽象 —— 把「几件物品 / 几条流水」摆出来，
 * 用户才能在点确认之前判断自己选的文件对不对（选错文件是最常见的事故）。
 */
export interface BackupSummary {
  items: number;
  movements: number;
  shoppingListItems: number;
  notificationHistory: number;
  /** `exportedAt` 原文；空串表示文件里没带 */
  exportedAt: string;
  /**
   * 文件里是否带了 `settings`。
   * false 表示导入后设置会回到默认值 —— 导入是「整体回到某个时刻」，
   * 用户有权在点确认之前知道这点，不能悄悄换掉提醒设置。
   */
  hasSettings: boolean;
}
