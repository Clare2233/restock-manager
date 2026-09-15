import type { AppSettings } from '@/types/models';

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------

/** SQLite 数据库文件名 */
export const DATABASE_NAME = 'restock.db';

/**
 * 当前 JS 构建标识。
 *
 * 用途：显示在「启动失败」页面的最顶部。真机出问题时截一张图即可确认
 * **手机上跑的到底是哪一版代码** —— 不用再靠猜来区分「JS 包没更新」和
 * 「代码真的有 bug」这两种情况（本次排查就卡在这里）。
 *
 * 需要区分版本时手动改这个字符串，改完必须让手机重新拉取一次 JS 包。
 */
export const BUILD_ID = 'v4-seed-after-schema';

// ---------------------------------------------------------------------------
// 预测与提醒默认参数
// ---------------------------------------------------------------------------

/** 日均统计窗口默认天数 */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * 「数据可信」的最小记录跨度（天）。
 * 实际跨度小于该值时，日均视为不可靠：只依靠安全库存（C2）触发提醒。
 */
export const MIN_RELIABLE_DAYS = 7;

/** 默认提前提醒天数 */
export const DEFAULT_REMIND_DAYS = 3;

/** 默认采购缓冲天数 */
export const DEFAULT_LEAD_DAYS = 2;

/** 默认提醒时刻（本地时间） */
export const DEFAULT_NOTIFY_TIME = '09:00';

/** 已提醒但未补货时，默认间隔多少天再催一次 */
export const DEFAULT_RE_REMIND_INTERVAL_DAYS = 3;

/** 建议补货量默认按覆盖未来多少天的用量计算 */
export const DEFAULT_RESTOCK_COVER_DAYS = 30;

/** 日均不可预测时，建议补货量的参考下限：安全库存的 2 倍 */
export const RESTOCK_SAFETY_MULTIPLIER = 2;

/** 日均 / 库存等数值的展示与存储精度 */
export const QUANTITY_DECIMALS = 2;

// ---------------------------------------------------------------------------
// 通知调度
// ---------------------------------------------------------------------------

/** Android 通知渠道 ID */
export const NOTIFICATION_CHANNEL_ID = 'restock-reminders';

/** Android 通知渠道名 */
export const NOTIFICATION_CHANNEL_NAME = '补货提醒';

/**
 * Android 紧急通知渠道 ID：承载 P0「已用完」。
 * 与上面的常规渠道分开，是因为重要度只能按渠道设置 —— 想让 P0 响铃、弹 heads-up，
 * 而每日摘要安安静静进抽屉，就必须两个渠道。
 */
export const NOTIFICATION_CHANNEL_URGENT_ID = 'restock-urgent';

/** Android 紧急通知渠道名 */
export const NOTIFICATION_CHANNEL_URGENT_NAME = '补货紧急提醒';

/**
 * 单次最多保留的待发通知条数（硬上限，兜底用）。
 *
 * iOS 对 pending 本地通知有 64 条硬上限，超出的会被系统直接丢弃；
 * Android 没有这个上限，但同一个数量级足以覆盖「一个家庭的存货」。
 * 方案 A（每次只排最近一个 fire point）下正常情况远达不到这个数，
 * 留着它是为了兜住批量导入之类的极端数据 —— 宁可少排几条，
 * 也不要让超出上限的通知被系统静默丢掉。
 */
export const MAX_PENDING_NOTIFICATIONS = 32;

// ---------------------------------------------------------------------------
// app_settings 表的键
// ---------------------------------------------------------------------------

export const SETTINGS_KEYS = {
  appSettings: 'app_settings',
  /**
   * 上一次重排产出的「计划签名」。
   *
   * 重排时先算本次计划，签名与这里存的相同就说明系统里排的还是同一套通知，
   * 直接返回 —— 不必每次进 App 都把通知取消再排一遍。
   * 关闭通知 / 权限被拒时会写成空串，保证重新打开时一定重新排。
   */
  notificationPlan: 'notification_plan',
} as const;

/** 应用设置默认值；也是「字段缺失时的兜底」，保证版本升级向前兼容 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  notificationsEnabled: true,
  defaultRemindDays: DEFAULT_REMIND_DAYS,
  defaultLeadDays: DEFAULT_LEAD_DAYS,
  defaultWindowDays: DEFAULT_WINDOW_DAYS,
  defaultNotifyTime: DEFAULT_NOTIFY_TIME,
  reRemindIntervalDays: DEFAULT_RE_REMIND_INTERVAL_DAYS,
  restockCoverDays: DEFAULT_RESTOCK_COVER_DAYS,
  currencySymbol: '¥',
  lastBackupAt: null,
  lastRestoreAt: null,
};

/** 界面通用计量单位候选（供表单使用） */
export const COMMON_UNITS: readonly string[] = [
  '个',
  '片',
  '包',
  '瓶',
  '块',
  '卷',
  '盒',
  '袋',
  '提',
  'g',
  'kg',
  'ml',
  'L',
] as const;
