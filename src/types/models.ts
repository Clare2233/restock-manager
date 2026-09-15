/**
 * 领域模型 与 数据库行模型 的类型定义。
 *
 * 全局约定：
 * - 所有时间戳统一为 Unix 毫秒（UTC），仅在展示层按设备本地时区转换。
 * - `ISODate` 表示「业务日」，形如 'YYYY-MM-DD'，按设备本地时区解释。
 * - 数据库中表示布尔值的 0/1 字段，在领域模型里是 boolean。
 * - 流水的 `quantity` 恒为**有符号**值：消耗/丢弃为负，进货为正，盘点可正可负。
 *   这样 `库存 = SUM(quantity)`，规则唯一，不会出现两套口径。
 */

/** Unix 毫秒时间戳 */
export type Millis = number;

/** 业务日，形如 'YYYY-MM-DD'（本地时区语义） */
export type ISODate = string;

/** 月份键，形如 'YYYY-MM'（本地时区语义） */
export type MonthKey = string;

/** 物品分类 */
export type ItemCategory = 'cleaning' | 'paper' | 'drink' | 'personal' | 'other';

/** 流水类型 */
export type MovementType = 'consume' | 'purchase' | 'adjust' | 'discard';

/** 流水来源，用于区分快捷扣减 / 手动录入 / 备份导入 */
export type MovementSource = 'quick' | 'manual' | 'import';

/** 通知种类 */
export type ReminderKind = 'buy_reminder' | 'out_of_stock' | 'daily_digest';

/** 购物清单条目来源：auto = 由预测实时生成，manual = 用户手写 */
export type ShoppingSource = 'auto' | 'manual';

/** 购物清单条目状态 */
export type ShoppingStatus = 'pending' | 'bought' | 'skipped';

/** 自动条目被用户标记后的状态（pending 不落库，见 shopping.repo.ts 的策略说明） */
export type ShoppingResolvedStatus = Exclude<ShoppingStatus, 'pending'>;

/**
 * 物品列表排序方式。
 * 注意：按「紧急度」排序需要预测结果，属于派生数据，
 * 由领域层/UI 层在内存中完成，不在这里（SQL 层无法感知预测）。
 */
export type ItemSort = 'sortOrder' | 'name' | 'stockAsc' | 'stockDesc' | 'updatedDesc';

// ---------------------------------------------------------------------------
// 物品
// ---------------------------------------------------------------------------

/** `items` 表行模型 */
export interface ItemRow {
  id: number;
  name: string;
  category: string;
  unit: string;
  pack_size: number;
  pack_unit: string | null;
  icon: string | null;
  color: string | null;
  stock: number;
  safety_stock: number;
  quick_consume_qty: number;
  remind_days: number;
  lead_days: number;
  avg_window_days: number;
  notify_enabled: number;
  notify_time: string;
  last_price: number | null;
  tracking_started_at: number | null;
  /** V2 新增 */
  note: string | null;
  /** V2 新增：预计使用周期（天） */
  estimated_cycle_days: number | null;
  is_archived: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** 物品领域模型 */
export interface Item {
  id: number;
  name: string;
  category: ItemCategory;
  /** 基础计量单位（库存与流水都用它） */
  unit: string;
  /** 1 个采购单位 = 多少个基础单位，最小为 1 */
  packSize: number;
  /** 采购单位名（提/箱/包…），为 null 时采购单位等同于基础单位 */
  packUnit: string | null;
  icon: string | null;
  color: string | null;
  /** 当前库存（由流水重算得到的缓存值） */
  stock: number;
  /** 安全库存，<= 当前库存时触发条件 C2 */
  safetyStock: number;
  /** 「用一次」的扣减量（基础单位） */
  quickConsumeQty: number;
  /** 提前提醒天数 */
  remindDays: number;
  /** 采购缓冲天数 */
  leadDays: number;
  /**
   * 日均统计窗口天数。
   * **系统参数**，只决定统计口径，由 `DEFAULT_WINDOW_DAYS` 兜底；
   * 它不是用户认知里的「多久用完一轮」——那是 `estimatedCycleDays`。
   * 因此物品表单不暴露本字段。
   */
  avgWindowDays: number;
  /** 物品备注：品牌 / 购买渠道 / 使用心得等；null = 未填 */
  note: string | null;
  /**
   * 预计使用周期（天），用户填写。语义是「当前这批库存大概能用多少天」。
   *
   * 只用于**冷启动**：物品还没有任何消耗流水时，预测层按 `库存 / 本字段`
   * 估算一个日均，从而给出初始的预计耗尽日；一旦有了真实消耗记录
   * （`stats.hasData`）就自动切换为实测统计，本字段不再参与计算。
   *
   * null = 用户未填，不做冷启动估算（此时仅靠安全库存触发提醒）。
   */
  estimatedCycleDays: number | null;
  notifyEnabled: boolean;
  /** 本地时间 'HH:mm' */
  notifyTime: string;
  /** 最近一次采购单价（基础单位价） */
  lastPrice: number | null;
  /**
   * 日均统计基准时间（显式覆盖）。
   * null 表示「自动」：由预测层取窗口内最早的一条消耗作为基准，
   * 这样「物品建了很久、但最近才开始用」也能得到正确的速率，
   * 不会因为被硬性除以 30 天而严重低估日均。
   */
  trackingStartedAt: number | null;
  isArchived: boolean;
  sortOrder: number;
  createdAt: number;
  /** 资料最后编辑时间（不含库存变动） */
  updatedAt: number;
}

/**
 * 新建物品入参。
 * `initialStock` 会以一条 `adjust` 流水落库，保证「流水是唯一事实来源」。
 */
export interface CreateItemInput {
  name: string;
  category?: ItemCategory;
  unit?: string;
  packSize?: number;
  packUnit?: string | null;
  icon?: string | null;
  color?: string | null;
  initialStock?: number;
  safetyStock?: number;
  quickConsumeQty?: number;
  remindDays?: number;
  leadDays?: number;
  avgWindowDays?: number;
  /** 物品备注；空串会被收敛成 null */
  note?: string | null;
  /** 预计使用周期（天）；仅用于冷启动估算，见 `Item.estimatedCycleDays` */
  estimatedCycleDays?: number | null;
  notifyEnabled?: boolean;
  notifyTime?: string;
  lastPrice?: number | null;
  sortOrder?: number;
  trackingStartedAt?: number | null;
}

/**
 * 更新物品入参。
 * 刻意**不包含** `initialStock`：库存变更必须走流水（消耗/进货/盘点），
 * 否则会出现「改了字段却没留下痕迹」的脏数据。要改库存请用 `recordAdjustment`。
 */
export type UpdateItemInput = Partial<Omit<CreateItemInput, 'initialStock'>> & {
  isArchived?: boolean;
};

/** 物品列表查询条件 */
export interface ListItemsOptions {
  includeArchived?: boolean;
  categories?: ItemCategory[];
  /** 按名称模糊匹配 */
  search?: string;
  sort?: ItemSort;
}

// ---------------------------------------------------------------------------
// 库存流水
// ---------------------------------------------------------------------------

/** `stock_movements` 表行模型 */
export interface StockMovementRow {
  id: number;
  item_id: number;
  type: string;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  occurred_at: number;
  source: string;
  note: string | null;
  created_at: number;
}

/** 流水领域模型 */
export interface StockMovement {
  id: number;
  itemId: number;
  type: MovementType;
  /** 有符号数量 */
  quantity: number;
  /** 单价（基础单位价），仅 purchase 有意义 */
  unitPrice: number | null;
  /** 实付总额，仅 purchase 有意义（月支出统计用它） */
  totalPrice: number | null;
  /** 业务发生时间 */
  occurredAt: number;
  source: MovementSource;
  note: string | null;
  createdAt: number;
}

/** 写流水入参 */
export interface RecordMovementInput {
  itemId: number;
  /** 有符号数量；consume / discard 必须为负，purchase 必须为正 */
  quantity: number;
  type: MovementType;
  /** 业务发生时间，默认当前时间；支持补录过去 */
  occurredAt?: number;
  source?: MovementSource;
  note?: string | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
}

/** 写流水的返回结果 */
export interface MovementResult {
  movementId: number;
  /** 重算后的物品库存 */
  stock: number;
}

/** 消耗样本，供预测算法使用（quantity 恒为正数） */
export interface ConsumptionSample {
  quantity: number;
  occurredAt: number;
}

/** 消耗量排行项（按物品聚合） */
export interface ConsumptionTotal {
  itemId: number;
  name: string;
  unit: string;
  quantity: number;
  movementCount: number;
}

// ---------------------------------------------------------------------------
// 购物清单
// ---------------------------------------------------------------------------

/** `shopping_list_items` 表行模型 */
export interface ShoppingListItemRow {
  id: number;
  item_id: number | null;
  name: string;
  unit: string | null;
  quantity: number;
  unit_price: number | null;
  source: string;
  status: string;
  priority: number;
  note: string | null;
  sort_order: number;
  added_at: number;
  resolved_at: number | null;
}

/** 购物清单条目领域模型 */
export interface ShoppingListItem {
  id: number;
  /** null 表示与库存物品无关的手写条目 */
  itemId: number | null;
  name: string;
  unit: string | null;
  quantity: number;
  unitPrice: number | null;
  source: ShoppingSource;
  status: ShoppingStatus;
  /** 1 最高（对应提醒 P0），默认 3 */
  priority: number;
  note: string | null;
  sortOrder: number;
  addedAt: number;
  resolvedAt: number | null;
}

/** 手写条目入参 */
export interface AddManualShoppingItemInput {
  name: string;
  unit?: string | null;
  quantity?: number;
  unitPrice?: number | null;
  note?: string | null;
  priority?: number;
  sortOrder?: number;
  /** 可选：关联到某个库存物品 */
  itemId?: number | null;
}

/**
 * 自动条目的「抑制记录」：某个物品的自动条目被用户处理过之后落库的最小数据。
 * 只要存在这条记录，实时生成的自动条目就会被过滤掉（见 shopping.repo.ts）。
 */
export interface AutoShoppingOverride {
  itemId: number;
  status: ShoppingResolvedStatus;
  /** 用户操作时间（= 该行的 resolved_at） */
  updatedAt: number;
}

/** 手写条目的可编辑字段 */
export type UpdateShoppingItemInput = Partial<
  Omit<AddManualShoppingItemInput, 'itemId' | 'sortOrder'>
>;

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

/** `notification_jobs` 表行模型 */
export interface NotificationJobRow {
  id: number;
  item_id: number | null;
  kind: string;
  notification_id: string;
  fire_at: number;
  reason: string | null;
  created_at: number;
}

/** 已调度通知映射（用于取消 / 重排） */
export interface NotificationJob {
  id: number;
  itemId: number | null;
  kind: ReminderKind;
  /** expo-notifications 返回的 identifier */
  notificationId: string;
  fireAt: number;
  reason: string | null;
  createdAt: number;
}

/** `notification_history` 表行模型 */
export interface NotificationHistoryRow {
  id: number;
  item_id: number | null;
  kind: string;
  fired_at: number;
  dismissed: number;
  snoozed_until: number | null;
}

/** 通知历史（用于冷却、静默期） */
export interface NotificationHistory {
  id: number;
  itemId: number | null;
  kind: ReminderKind;
  firedAt: number;
  dismissed: boolean;
  snoozedUntil: number | null;
}

/** 写调度任务入参 */
export interface UpsertNotificationJobInput {
  itemId: number | null;
  kind: ReminderKind;
  notificationId: string;
  fireAt: number;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/** 采购记录（已 join 物品信息，供月支出统计） */
export interface PurchaseRecord {
  id: number;
  itemId: number;
  itemName: string;
  category: ItemCategory;
  unit: string;
  /** 数量（purchase 约束保证为正） */
  quantity: number;
  unitPrice: number | null;
  /** 实付总额；为 null 时由 unitPrice * quantity 兜底 */
  totalPrice: number | null;
  occurredAt: number;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/** 全局应用设置（以单个 JSON 存在 app_settings 表） */
export interface AppSettings {
  /** 总开关，关闭时不调度任何补货提醒 */
  notificationsEnabled: boolean;
  /** 新建物品时的默认「提前提醒天数」 */
  defaultRemindDays: number;
  /** 新建物品时的默认「采购缓冲天数」 */
  defaultLeadDays: number;
  /** 新建物品时的默认日均统计窗口天数 */
  defaultWindowDays: number;
  /** 默认提醒时刻，本地时间 'HH:mm' */
  defaultNotifyTime: string;
  /** 已提醒但未补货时，间隔多少天再催一次 */
  reRemindIntervalDays: number;
  /** 建议补货量按覆盖未来多少天的用量计算 */
  restockCoverDays: number;
  currencySymbol: string;
  lastBackupAt: number | null;
  lastRestoreAt: number | null;
}
