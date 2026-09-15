import type { SQLiteDatabase } from 'expo-sqlite';
import { mapMovement } from '@/db/mappers';
import type {
  ConsumptionSample,
  MovementResult,
  MovementSource,
  MovementType,
  RecordMovementInput,
  StockMovement,
  StockMovementRow,
} from '@/types/models';
import { nowMs } from '@/utils/date';
import { roundTo } from '@/utils/number';

/**
 * 库存流水仓库 —— 数据层最核心的文件。
 *
 * ## 职责边界
 * 本文件同时拥有两个**写原语**：`insertMovementCore`（插入流水）和
 * `recomputeStockCore`（按流水重算库存）。理由：它们必须成对出现，
 * 拆到两个文件只会让「只插流水忘了重算」这种 bug 更容易发生。
 * `items.repo.ts` 依赖本文件（单向），本文件**不反向依赖** items.repo，避免循环引用。
 *
 * ## Core 后缀的约定（重要）
 * 以 `Core` 结尾的函数**不开事务**，只做一次原子写。
 * - 独立调用 → 用不带 Core 的版本（内部 `withTransactionAsync` 包住）；
 * - 上层已有事务（如种子数据、备份导入）→ 必须用 `Core` 版本。
 *
 * 原因：SQLite 不支持嵌套事务，`withTransactionAsync` 内再调 `withTransactionAsync`
 * 会报 "cannot start a transaction within a transaction"。
 */

/** 内部插入流水入参 */
interface InsertMovementParams {
  itemId: number;
  type: MovementType;
  quantity: number;
  occurredAt?: number;
  source?: MovementSource;
  note?: string | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
}

const MOVEMENT_COLUMNS =
  'id, item_id, type, quantity, unit_price, total_price, occurred_at, source, note, created_at';

/**
 * 校验数量的符号是否符合类型约束。
 * 与建表语句里的 CHECK 约束一致，但在 JS 侧先抛错能给出更清晰的报错信息。
 */
export function assertMovementSign(type: MovementType, quantity: number): void {
  if (!Number.isFinite(quantity)) {
    throw new Error('流水数量必须是有限数字');
  }
  if (type === 'consume' || type === 'discard') {
    if (quantity >= 0) {
      throw new Error(`${type} 类型的流水数量必须为负数，实际收到 ${quantity}`);
    }
    return;
  }
  if (type === 'purchase') {
    if (quantity <= 0) {
      throw new Error(`purchase 类型的流水数量必须为正数，实际收到 ${quantity}`);
    }
    return;
  }
  if (quantity === 0) {
    // 盘点为 0 是笔无意义的记录，通常意味着调用方算错了，早点暴露
    throw new Error('adjust 类型的流水数量不能为 0');
  }
}

async function assertItemExistsCore(db: SQLiteDatabase, itemId: number): Promise<void> {
  const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM items WHERE id = ?', [
    itemId,
  ]);
  if (!row) {
    throw new Error(`物品 ${itemId} 不存在，无法记录流水`);
  }
}

// ---------------------------------------------------------------------------
// 写原语（无事务）
// ---------------------------------------------------------------------------

/** 插入一条流水，返回新流水 id。**不开事务**。 */
export async function insertMovementCore(
  db: SQLiteDatabase,
  params: InsertMovementParams,
): Promise<number> {
  assertMovementSign(params.type, params.quantity);
  await assertItemExistsCore(db, params.itemId);

  const occurredAt = params.occurredAt ?? nowMs();
  const result = await db.runAsync(
    `INSERT INTO stock_movements
       (item_id, type, quantity, unit_price, total_price, occurred_at, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.itemId,
      params.type,
      roundTo(params.quantity),
      params.unitPrice ?? null,
      params.totalPrice ?? null,
      occurredAt,
      params.source ?? 'manual',
      params.note ?? null,
      nowMs(),
    ],
  );
  return result.lastInsertRowId;
}

/**
 * 按流水求和重算 `items.stock` 并回写，返回重算后的库存。**不开事务**。
 *
 * 刻意**不更新 `items.updated_at`**：那个字段的语义是「资料最后编辑时间」，
 * 库存变动已经有完整流水可查，混在一起会让「最近编辑」排序失去意义。
 */
export async function recomputeStockCore(
  db: SQLiteDatabase,
  itemId: number,
): Promise<number> {
  const row = await db.getFirstAsync<{ stock: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS stock FROM stock_movements WHERE item_id = ?',
    [itemId],
  );
  const stock = roundTo(row?.stock ?? 0);
  await db.runAsync('UPDATE items SET stock = ? WHERE id = ?', [stock, itemId]);
  return stock;
}

/** 插入流水 + 重算库存（+ 采购时更新参考单价）。**不开事务**。 */
export async function applyMovementCore(
  db: SQLiteDatabase,
  params: InsertMovementParams,
): Promise<MovementResult> {
  const movementId = await insertMovementCore(db, params);
  const stock = await recomputeStockCore(db, params.itemId);

  if (params.type === 'purchase' && params.unitPrice != null) {
    await db.runAsync('UPDATE items SET last_price = ? WHERE id = ?', [
      params.unitPrice,
      params.itemId,
    ]);
  }

  return { movementId, stock };
}

// ---------------------------------------------------------------------------
// 对外写接口（自带事务）
// ---------------------------------------------------------------------------

/** 记录任意流水（含事务）。业务侧一般用下面的语义化封装，而非直接调它。 */
export async function recordMovement(
  db: SQLiteDatabase,
  params: RecordMovementInput,
): Promise<MovementResult> {
  let result: MovementResult | null = null;
  await db.withTransactionAsync(async () => {
    result = await applyMovementCore(db, params);
  });
  if (!result) {
    throw new Error('记录流水失败：事务未返回结果');
  }
  return result;
}

/** 「用一次」快捷扣减：读取物品自己的 quickConsumeQty 生成负数消耗 */
export async function recordQuickConsume(
  db: SQLiteDatabase,
  params: { itemId: number; occurredAt?: number; note?: string | null },
): Promise<MovementResult> {
  const item = await db.getFirstAsync<{ quick_consume_qty: number }>(
    'SELECT quick_consume_qty FROM items WHERE id = ?',
    [params.itemId],
  );
  if (!item) {
    throw new Error(`物品 ${params.itemId} 不存在，无法快捷扣减`);
  }
  const quantity = item.quick_consume_qty > 0 ? item.quick_consume_qty : 1;
  return recordMovement(db, {
    itemId: params.itemId,
    type: 'consume',
    quantity: -roundTo(quantity),
    source: 'quick',
    occurredAt: params.occurredAt,
    note: params.note ?? null,
  });
}

/** 手动记录消耗（负数由内部补上，调用方传正数即可） */
export async function recordConsume(
  db: SQLiteDatabase,
  params: {
    itemId: number;
    quantity: number;
    occurredAt?: number;
    note?: string | null;
    source?: MovementSource;
  },
): Promise<MovementResult> {
  return recordMovement(db, {
    itemId: params.itemId,
    type: 'consume',
    quantity: -Math.abs(roundTo(params.quantity)),
    source: params.source ?? 'manual',
    occurredAt: params.occurredAt,
    note: params.note ?? null,
  });
}

/** 补货入库（正数由内部保证）。totalPrice 是统计月支出的口径。 */
export async function recordPurchase(
  db: SQLiteDatabase,
  params: {
    itemId: number;
    quantity: number;
    unitPrice?: number | null;
    totalPrice?: number | null;
    occurredAt?: number;
    note?: string | null;
    source?: MovementSource;
  },
): Promise<MovementResult> {
  const quantity = Math.abs(roundTo(params.quantity));
  let totalPrice = params.totalPrice ?? null;
  // 只填了单价 → 自动补总额，保证月支出统计不漏记
  if (totalPrice == null && params.unitPrice != null) {
    totalPrice = roundTo(params.unitPrice * quantity);
  }
  return recordMovement(db, {
    itemId: params.itemId,
    type: 'purchase',
    quantity,
    unitPrice: params.unitPrice ?? null,
    totalPrice,
    source: params.source ?? 'manual',
    occurredAt: params.occurredAt,
    note: params.note ?? null,
  });
}

/** 盘点校正：把库存调整为目标值 */
export async function adjustStockTo(
  db: SQLiteDatabase,
  params: { itemId: number; targetStock: number; occurredAt?: number; note?: string | null },
): Promise<MovementResult> {
  const row = await db.getFirstAsync<{ stock: number }>(
    'SELECT stock FROM items WHERE id = ?',
    [params.itemId],
  );
  if (!row) {
    throw new Error(`物品 ${params.itemId} 不存在，无法盘点`);
  }
  const delta = roundTo(params.targetStock - row.stock);
  if (delta === 0) {
    throw new Error('目标库存与当前库存相同，无需盘点');
  }
  return recordMovement(db, {
    itemId: params.itemId,
    type: 'adjust',
    quantity: delta,
    source: 'manual',
    occurredAt: params.occurredAt,
    note: params.note ?? '盘点校正',
  });
}

/** 丢弃 / 过期报废（负数由内部保证）。**不计入日均消耗**，避免污染预测。 */
export async function recordDiscard(
  db: SQLiteDatabase,
  params: { itemId: number; quantity: number; occurredAt?: number; note?: string | null },
): Promise<MovementResult> {
  return recordMovement(db, {
    itemId: params.itemId,
    type: 'discard',
    quantity: -Math.abs(roundTo(params.quantity)),
    source: 'manual',
    occurredAt: params.occurredAt,
    note: params.note ?? null,
  });
}

/**
 * 删除一条流水并重算库存（用于「撤销」快捷扣减）。
 * 物品不存在或流水已删除时静默返回。
 */
export async function deleteMovement(
  db: SQLiteDatabase,
  movementId: number,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ item_id: number }>(
      'SELECT item_id FROM stock_movements WHERE id = ?',
      [movementId],
    );
    if (!row) return;
    await db.runAsync('DELETE FROM stock_movements WHERE id = ?', [movementId]);
    await recomputeStockCore(db, row.item_id);
  });
}

/** 删除某物品的全部流水并重算库存（备份导入、重置统计用）。**不开事务**。 */
export async function deleteMovementsForItemCore(
  db: SQLiteDatabase,
  itemId: number,
): Promise<void> {
  await db.runAsync('DELETE FROM stock_movements WHERE item_id = ?', [itemId]);
  await recomputeStockCore(db, itemId);
}

/**
 * 按流水求和重算**全部**物品库存。**不开事务**。
 *
 * 为什么已经有了 `recomputeStockCore`（单个物品）还要有这个整表版本：
 * 备份导入会一次性写进上千条流水，逐物品重算是 N 次 UPDATE；
 * 而这个版本一条 SQL 就够（SQLite 会对 `items` 做一次全表扫描，
 * 家庭场景的数据量下比 N 次索引查找还快）。
 *
 * 只在「全部物品的流水都可能变了」的场合使用（备份导入、批量修数据）。
 * 日常单次写流水请继续用 `recomputeStockCore` —— 只动一行。
 */
export async function recomputeAllStocksCore(db: SQLiteDatabase): Promise<void> {
  await db.runAsync(
    `UPDATE items
        SET stock = COALESCE(
          (SELECT SUM(quantity) FROM stock_movements m WHERE m.item_id = items.id), 0
        )`,
  );
}

/** 重算所有物品的库存（导入后对账、修数据用） */
export async function recomputeAllStocks(db: SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await recomputeAllStocksCore(db);
  });
}

// ---------------------------------------------------------------------------
// 读接口
// ---------------------------------------------------------------------------

export async function getMovementById(
  db: SQLiteDatabase,
  movementId: number,
): Promise<StockMovement | null> {
  const row = await db.getFirstAsync<StockMovementRow>(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movements WHERE id = ?`,
    [movementId],
  );
  return row ? mapMovement(row) : null;
}

/** 某物品的流水（时间倒序，支持分页） */
export async function listMovementsByItem(
  db: SQLiteDatabase,
  itemId: number,
  options: { limit?: number; offset?: number; types?: MovementType[] } = {},
): Promise<StockMovement[]> {
  const types = options.types;
  const params: Array<string | number> = [itemId];
  let where = 'item_id = ?';
  if (types && types.length > 0) {
    where += ` AND type IN (${types.map(() => '?').join(', ')})`;
    params.push(...types);
  }
  params.push(options.limit ?? 50, options.offset ?? 0);

  const rows = await db.getAllAsync<StockMovementRow>(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movements
      WHERE ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map(mapMovement);
}

/**
 * 全量流水（备份导出口径）。
 *
 * 为什么不能用 `listMovementsByItem` 循环：那是**每物品一次查询**，
 * 导出时会退化成 N+1。这里一次捞完，按 `id` 升序，
 * 让文件里的顺序稳定（同一份数据导出两次，diff 是空的）。
 */
export async function listAllMovements(db: SQLiteDatabase): Promise<StockMovement[]> {
  const rows = await db.getAllAsync<StockMovementRow>(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_movements ORDER BY id ASC`,
  );
  return rows.map(mapMovement);
}

/**
 * 全库流水总数。
 *
 * 目前只有一处用：设置页「清空数据」的确认弹窗要告诉用户将要删掉多少条。
 * 刻意 **不用** `listAllMovements().length` —— 那会把全部流水读成对象数组，
 * 只为得到一个数字；`COUNT(*)` 一次就够，也不会因为数据量大而变慢。
 */
export async function countAllMovements(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    'SELECT COUNT(*) AS total FROM stock_movements',
  );
  return row?.total ?? 0;
}

/** 某物品流水总数（分页用） */
export async function countMovementsByItem(
  db: SQLiteDatabase,
  itemId: number,
): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    'SELECT COUNT(*) AS total FROM stock_movements WHERE item_id = ?',
    [itemId],
  );
  return row?.total ?? 0;
}

/**
 * 取某物品窗口内的消耗样本（供预测使用）。
 * 只统计 `consume`：`discard` 是扔掉/过期，不代表正常使用速度，混进来会让日均虚高。
 */
export async function listConsumptionSamples(
  db: SQLiteDatabase,
  itemId: number,
  fromMs: number,
): Promise<ConsumptionSample[]> {
  const rows = await db.getAllAsync<{ quantity: number; occurred_at: number }>(
    `SELECT quantity, occurred_at FROM stock_movements
      WHERE item_id = ? AND type = 'consume' AND occurred_at >= ?
      ORDER BY occurred_at ASC`,
    [itemId, fromMs],
  );
  return rows.map((row) => ({ quantity: Math.abs(row.quantity), occurredAt: row.occurred_at }));
}

/**
 * 批量版：一条查询捞出全部物品的消耗样本，按 `itemId` 分组返回。
 *
 * 为什么需要它：列表页有几十个物品，而预测量是逐物品算的。
 * 用 `listConsumptionSamples` 循环会变成 N+1 次查询，每次进页面都要付一遍。
 * 这里一次捞完再在内存里分组，页面刷新只付 1 次查询。
 *
 * `fromMs` 应取**所有物品中最大的窗口起点**（调用方负责算，见 items.store）。
 * 多捞出来的旧样本不会算错：`computeConsumptionStats` 会按每个物品自己的
 * `avgWindowDays` 再过滤一次（`sample.occurredAt < windowStartMs` 直接跳过），
 * 所以「超集」是安全的，而「子集」才是 bug —— 那会漏掉本该计入的样本。
 */
export async function listConsumptionSamplesByItem(
  db: SQLiteDatabase,
  fromMs: number,
): Promise<Map<number, ConsumptionSample[]>> {
  const rows = await db.getAllAsync<{ item_id: number; quantity: number; occurred_at: number }>(
    `SELECT item_id, quantity, occurred_at FROM stock_movements
      WHERE type = 'consume' AND occurred_at >= ?
      ORDER BY item_id ASC, occurred_at ASC`,
    [fromMs],
  );

  const grouped = new Map<number, ConsumptionSample[]>();
  for (const row of rows) {
    const sample: ConsumptionSample = {
      quantity: Math.abs(row.quantity),
      occurredAt: row.occurred_at,
    };
    const bucket = grouped.get(row.item_id);
    if (bucket) {
      bucket.push(sample);
    } else {
      grouped.set(row.item_id, [sample]);
    }
  }
  return grouped;
}

/** 窗口内消耗总量（返回正数） */
export async function sumConsumedQuantity(
  db: SQLiteDatabase,
  itemId: number,
  fromMs: number,
  toMs: number = nowMs(),
): Promise<number> {
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(quantity) AS total FROM stock_movements
      WHERE item_id = ? AND type = 'consume' AND occurred_at >= ? AND occurred_at <= ?`,
    [itemId, fromMs, toMs],
  );
  return Math.abs(row?.total ?? 0);
}

/** 最早一条消耗的时间（统计基准兜底用） */
export async function getEarliestConsumptionAt(
  db: SQLiteDatabase,
  itemId: number,
): Promise<number | null> {
  const row = await db.getFirstAsync<{ earliest: number | null }>(
    `SELECT MIN(occurred_at) AS earliest FROM stock_movements
      WHERE item_id = ? AND type = 'consume'`,
    [itemId],
  );
  return row?.earliest ?? null;
}

/** 最近一条消耗的时间（判断「是否补货后重新开始统计」用） */
export async function getLatestConsumptionAt(
  db: SQLiteDatabase,
  itemId: number,
): Promise<number | null> {
  const row = await db.getFirstAsync<{ latest: number | null }>(
    `SELECT MAX(occurred_at) AS latest FROM stock_movements
      WHERE item_id = ? AND type = 'consume'`,
    [itemId],
  );
  return row?.latest ?? null;
}
