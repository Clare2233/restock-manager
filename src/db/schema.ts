/**
 * 数据库 Schema（V1 全量建表语句）。
 *
 * 设计要点：
 * 1. `stock_movements` 是**唯一事实来源**，`items.stock` 只是缓存字段；
 *    每次写流水后在同一事务内用 `SUM(quantity)` 重算回写，避免漂移。
 *    家庭场景数据量极小，重算成本可忽略，换来的是「永远对得上账」。
 * 2. 数量统一**有符号**：consume/discard 为负，purchase 为正，adjust 任意。
 *    这样 `库存 = SUM(quantity)`，只有一个口径。
 * 3. 时间统一存 Unix 毫秒（INTEGER）；只有「业务日」用 'YYYY-MM-DD' 文本，
 *    避免跨时区串味（见 utils/date.ts）。
 * 4. 建表语句必须与 migrations.ts 的版本号一一对应：
 *    **V1 之后不要修改这个常量**，新增变更请追加 `SCHEMA_V2` 之类的迁移片段。
 */

/**
 * 每次打开连接都要设置的 PRAGMA。
 * 注意：`journal_mode` 与 `foreign_keys` **不能在事务内生效**，
 * 所以它们必须由 client/migrations 在事务外单独执行，不能混进建表语句里。
 */
export const INIT_PRAGMAS: readonly string[] = [
  // WAL 提升读写并发，App 被杀时也不易损坏
  'PRAGMA journal_mode = WAL;',
  // 外键约束默认关闭，必须显式打开
  'PRAGMA foreign_keys = ON;',
  // 兼顾速度与安全（WAL 下 NORMAL 是官方推荐值）
  'PRAGMA synchronous = NORMAL;',
] as const;

/** V1 全量 Schema */
export const SCHEMA_V1 = `
-- ============================ 1. 物品 ============================
CREATE TABLE IF NOT EXISTS items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  category            TEXT    NOT NULL DEFAULT 'other',   -- cleaning|paper|drink|personal|other
  unit                TEXT    NOT NULL DEFAULT '个',       -- 基础计量单位
  pack_size           REAL    NOT NULL DEFAULT 1,          -- 1 采购单位 = ? 基础单位
  pack_unit           TEXT,                                -- 采购单位名：包 / 提 / 箱
  icon                TEXT,
  color               TEXT,
  stock               REAL    NOT NULL DEFAULT 0,           -- 缓存值，由流水重算
  safety_stock        REAL    NOT NULL DEFAULT 0,
  quick_consume_qty   REAL    NOT NULL DEFAULT 1,           -- 「用一次」扣减量（基础单位）
  remind_days         INTEGER NOT NULL DEFAULT 3,           -- 提前提醒天数
  lead_days           INTEGER NOT NULL DEFAULT 2,           -- 采购缓冲天数
  avg_window_days     INTEGER NOT NULL DEFAULT 30,          -- 日均统计窗口
  notify_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (notify_enabled IN (0,1)),
  notify_time         TEXT    NOT NULL DEFAULT '09:00',     -- 本地 HH:mm
  last_price          REAL,                                 -- 最近采购单价（基础单位价）
  tracking_started_at INTEGER,                              -- 日均统计基准时间；NULL = 自动取窗口内最早消耗
  is_archived         INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_archived     ON items(is_archived, sort_order);
CREATE INDEX IF NOT EXISTS idx_items_category     ON items(category);

-- ==================== 2. 库存流水（唯一事实来源） ====================
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL CHECK (type IN ('consume','purchase','adjust','discard')),
  quantity    REAL    NOT NULL,                      -- 有符号：见文件头说明
  unit_price  REAL,                                  -- 仅 purchase：单价（基础单位价）
  total_price REAL,                                  -- 仅 purchase：实付总额（月支出用它）
  occurred_at INTEGER NOT NULL,                      -- 业务发生时间（支持补录过去）
  source      TEXT    NOT NULL DEFAULT 'manual',     -- quick | manual | import
  note        TEXT,
  created_at  INTEGER NOT NULL,
  CHECK (
    (type IN ('consume','discard') AND quantity < 0)
    OR (type = 'purchase' AND quantity > 0)
    OR type = 'adjust'
  )
);

CREATE INDEX IF NOT EXISTS idx_mv_item_time ON stock_movements(item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mv_type_time ON stock_movements(type, occurred_at DESC);

-- 对账视图：排查「items.stock 与流水求和不一致」时使用
CREATE VIEW IF NOT EXISTS v_item_stock AS
SELECT i.id AS item_id, COALESCE(SUM(m.quantity), 0) AS computed_stock
FROM items i
LEFT JOIN stock_movements m ON m.item_id = i.id
GROUP BY i.id;

-- ======================= 3. 全局设置（KV） =======================
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,        -- JSON 编码
  updated_at INTEGER NOT NULL
);

-- ============ 4. 已调度通知（用于取消 / 重排） ============
CREATE TABLE IF NOT EXISTS notification_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER REFERENCES items(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,   -- buy_reminder | out_of_stock | daily_digest
  notification_id TEXT    NOT NULL,   -- scheduleNotificationAsync 返回的 identifier
  fire_at         INTEGER NOT NULL,
  reason          TEXT,               -- 触发原因快照，用于通知文案
  created_at      INTEGER NOT NULL,
  -- 每个物品每种提醒最多一条待发任务，重排时靠它 upsert
  UNIQUE(item_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_jobs_fire_at ON notification_jobs(fire_at);

-- ========= 5. 通知历史（冷却 / 静默期 / 已读回执） =========
CREATE TABLE IF NOT EXISTS notification_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER REFERENCES items(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,
  fired_at      INTEGER NOT NULL,
  dismissed     INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0,1)),
  snoozed_until INTEGER,
  -- 同一物品同一类型同一毫秒只记一条，重排时重复写入会被忽略
  UNIQUE(item_id, kind, fired_at)
);

CREATE INDEX IF NOT EXISTS idx_hist_item ON notification_history(item_id, fired_at DESC);

-- ======================= 6. 购物清单 =======================
-- source = 'manual'：用户手写条目，完整落库。
-- source = 'auto'  ：自动条目**不落库**（由预测实时算出），
--                    只有当用户把它标记为 bought/skipped 时，才写一条
--                    抑制记录，避免它被重新生成。
-- UNIQUE(item_id, source) 依赖 SQLite「NULL 互不相等」的语义：
-- 手写条目的 item_id 常为 NULL，因此允许存在多条，这正是我们要的。
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER REFERENCES items(id) ON DELETE CASCADE,  -- NULL = 与库存无关的手写条目
  name        TEXT    NOT NULL,   -- 名称快照：物品被删/改名后清单仍可读
  unit        TEXT,
  quantity    REAL    NOT NULL DEFAULT 1,
  unit_price  REAL,
  source      TEXT    NOT NULL CHECK (source IN ('auto','manual')),
  status      TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','bought','skipped')),
  priority    INTEGER NOT NULL DEFAULT 3,   -- 1 最高，对应提醒 P0
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(item_id, source)
);

CREATE INDEX IF NOT EXISTS idx_shopping_status
  ON shopping_list_items(status, priority, sort_order);
`;

/**
 * V1 的 `items` 列名，与上面 `SCHEMA_V1` 里的 `CREATE TABLE items` 一一对应。
 *
 * 只用于**诊断**：判断一个已有库的 `items` 是不是「缺列」。
 * 不参与迁移，所以即使哪天这里漏同步，最坏结果也只是诊断提示不准，
 * 不会损坏数据（真正的迁移口径始终是 `SCHEMA_V1` / `SCHEMA_Vx` 的 SQL 文本）。
 */
export const SCHEMA_V1_ITEM_COLUMNS: readonly string[] = [
  'id',
  'name',
  'category',
  'unit',
  'pack_size',
  'pack_unit',
  'icon',
  'color',
  'stock',
  'safety_stock',
  'quick_consume_qty',
  'remind_days',
  'lead_days',
  'avg_window_days',
  'notify_enabled',
  'notify_time',
  'last_price',
  'tracking_started_at',
  'is_archived',
  'sort_order',
  'created_at',
  'updated_at',
];

/**
 * V2：给 `items` 增补两个列。
 *
 * 1. `note` —— 物品备注（品牌 / 购买渠道 / 使用心得）。
 *    这些信息属于**物品**而不是某一次流水，放在这里才不会被后续流水冲掉。
 *
 * 2. `estimated_cycle_days` —— 「预计使用周期」（天）。
 *    语义是「当前这批库存大概能用多少天」，只用于**冷启动**：
 *    物品还没有任何消耗流水时，预测层按 `库存 / 本字段` 估算日均，
 *    给出初始的预计耗尽日；有了真实消耗后自动切回实测统计。
 *
 *    注意它与 `avg_window_days` 是**两个概念**，不要混用：
 *    `avg_window_days` 是「日均统计窗口」这个系统参数（决定统计口径），
 *    `estimated_cycle_days` 才是用户认知里的「多久用完一轮」。
 *
 * 两列都允许 NULL：老数据无需回填，「未填写」本身也是合法状态。
 * （SQLite 的 ADD COLUMN 也无法添加 «NOT NULL 且无默认值» 的列，这里用不上默认值。）
 */
export interface ItemColumnAddition {
  /** 列名，用于和 `PRAGMA table_info(items)` 的结果比对 */
  name: string;
  /** 完整的 `ADD COLUMN` 语句（含分号） */
  ddl: string;
}

/**
 * V2 引入的 `items` 列清单。
 *
 * 之所以把「列名」和「DDL」放在一起，是因为**幂等迁移需要两份信息**：
 * 先按 `name` 查 `PRAGMA table_info`，确认不存在才执行 `ddl`。
 * 如果迁移片段里手写一份 SQL、自检代码里再手写一份，两边迟早漂移。
 */
export const SCHEMA_V2_ITEM_COLUMNS: readonly ItemColumnAddition[] = [
  { name: 'note', ddl: 'ALTER TABLE items ADD COLUMN note TEXT;' },
  {
    name: 'estimated_cycle_days',
    ddl: 'ALTER TABLE items ADD COLUMN estimated_cycle_days INTEGER;',
  },
];

/**
 * V2 的迁移片段。
 *
 * 由 `SCHEMA_V2_ITEM_COLUMNS` **推导**而来，不要改成手写字符串 ——
 * 保持单一事实来源，改上面的清单就够了。
 */
export const SCHEMA_V2 = SCHEMA_V2_ITEM_COLUMNS.map((column) => column.ddl).join('\n');
