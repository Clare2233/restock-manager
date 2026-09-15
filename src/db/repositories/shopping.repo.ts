import type { SQLiteDatabase } from 'expo-sqlite';
import { mapShoppingItem } from '@/db/mappers';
import type {
  AddManualShoppingItemInput,
  AutoShoppingOverride,
  ShoppingListItem,
  ShoppingListItemRow,
  ShoppingResolvedStatus,
  ShoppingStatus,
  UpdateShoppingItemInput,
} from '@/types/models';
import { nowMs } from '@/utils/date';
import { roundTo } from '@/utils/number';

/**
 * 购物清单仓库。
 *
 * ## 自动条目策略（已确认：策略 1）
 * 「哪些物品该买」由预测**实时算出**，不落库。表里只存两类数据：
 * 1. `source='manual'`：用户手写条目，完整生命周期；
 * 2. `source='auto'`  ：**抑制记录** —— 只有当用户把某条自动条目标记为
 *    `bought` / `skipped` 时才写入，用来阻止它被重新生成。
 *
 * 这样做的收益：永远不会出现「幽灵条目」（原始需求已消失但清单里还留着）。
 * 代价：自动条目无法排序/备注 —— 用户想排序就直接手写一条，语义也更清楚。
 *
 * 因此 UI 层的完整清单 = 实时算出的自动条目（过滤掉已有抑制记录的）
 *                        + `listManualItems()` 的手写条目。
 */

const SHOPPING_COLUMNS = `id, item_id, name, unit, quantity, unit_price, source, status,
  priority, note, sort_order, added_at, resolved_at`;

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 手写条目（按状态分组：待买在前，已处理在后） */
export async function listManualItems(db: SQLiteDatabase): Promise<ShoppingListItem[]> {
  const rows = await db.getAllAsync<ShoppingListItemRow>(
    `SELECT ${SHOPPING_COLUMNS} FROM shopping_list_items
      WHERE source = 'manual'
      ORDER BY (status = 'pending') DESC, priority ASC, sort_order ASC, id ASC`,
  );
  return rows.map(mapShoppingItem);
}

/** 所有自动条目的抑制记录（含 bought / skipped） */
export async function listAutoOverrides(db: SQLiteDatabase): Promise<ShoppingListItem[]> {
  const rows = await db.getAllAsync<ShoppingListItemRow>(
    `SELECT ${SHOPPING_COLUMNS} FROM shopping_list_items
      WHERE source = 'auto'
      ORDER BY priority ASC, id ASC`,
  );
  return rows.map(mapShoppingItem);
}

/**
 * 自动条目抑制表：`itemId → 状态`。
 * 这是 UI 渲染自动条目时唯一需要查的东西，用 Map 便于 O(1) 过滤。
 */
export async function getAutoOverrideMap(
  db: SQLiteDatabase,
): Promise<Map<number, AutoShoppingOverride>> {
  const rows = await db.getAllAsync<{
    item_id: number;
    status: string;
    resolved_at: number | null;
  }>(
    `SELECT item_id, status, resolved_at FROM shopping_list_items
      WHERE source = 'auto' AND item_id IS NOT NULL`,
  );
  const map = new Map<number, AutoShoppingOverride>();
  for (const row of rows) {
    if (row.status !== 'bought' && row.status !== 'skipped') continue;
    map.set(row.item_id, {
      itemId: row.item_id,
      status: row.status,
      updatedAt: row.resolved_at ?? 0,
    });
  }
  return map;
}

/**
 * 全量清单条目（备份导出口径）：手写条目 + 自动条目的抑制记录。
 *
 * 为什么不能只导出 `listManualItems()`：它按 UI 排序、且**只**是手写条目；
 * 而自动条目的抑制记录（`source='auto'`）同样是用户数据的组成部分 ——
 * 漏掉它们，导入后昨天标过「已买」的物品会重新出现在清单里。
 *
 * 排序用 `id ASC` 而不是 UI 那套「待买优先」：导出文件要的是稳定顺序。
 */
export async function listAllShoppingItems(db: SQLiteDatabase): Promise<ShoppingListItem[]> {
  const rows = await db.getAllAsync<ShoppingListItemRow>(
    `SELECT ${SHOPPING_COLUMNS} FROM shopping_list_items ORDER BY id ASC`,
  );
  return rows.map(mapShoppingItem);
}

export async function getShoppingItemById(
  db: SQLiteDatabase,
  id: number,
): Promise<ShoppingListItem | null> {
  const row = await db.getFirstAsync<ShoppingListItemRow>(
    `SELECT ${SHOPPING_COLUMNS} FROM shopping_list_items WHERE id = ?`,
    [id],
  );
  return row ? mapShoppingItem(row) : null;
}

/** 待买数量（Tab 角标用）：手写待买 + 尚未处理的自动条目由 UI 层相加 */
export async function countPendingManualItems(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM shopping_list_items
      WHERE source = 'manual' AND status = 'pending'`,
  );
  return row?.total ?? 0;
}

/** 已被标记处理的自动条目数量（角标计算时用总数减去它） */
export async function countAutoOverrides(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM shopping_list_items
      WHERE source = 'auto' AND status IN ('bought','skipped')`,
  );
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// 写：手写条目
// ---------------------------------------------------------------------------

export async function addManualItem(
  db: SQLiteDatabase,
  input: AddManualShoppingItemInput,
): Promise<ShoppingListItem> {
  const name = input.name?.trim();
  if (!name) {
    throw new Error('清单条目名称不能为空');
  }
  const now = nowMs();
  const result = await db.runAsync(
    `INSERT INTO shopping_list_items
       (item_id, name, unit, quantity, unit_price, source, status, priority, note,
        sort_order, added_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 'manual', 'pending', ?, ?, ?, ?, NULL)`,
    [
      input.itemId ?? null,
      name,
      input.unit ?? null,
      Math.max(0, roundTo(input.quantity ?? 1)),
      input.unitPrice ?? null,
      input.priority ?? 3,
      input.note ?? null,
      input.sortOrder ?? now,
      now,
    ],
  );

  const created = await getShoppingItemById(db, result.lastInsertRowId);
  if (!created) {
    throw new Error('新增清单条目失败：写入后无法读回');
  }
  return created;
}

export async function updateManualItem(
  db: SQLiteDatabase,
  id: number,
  patch: UpdateShoppingItemInput,
): Promise<void> {
  const assignments: string[] = [];
  const params: Array<string | number | null> = [];

  if (patch.name !== undefined) {
    const name = patch.name?.trim();
    if (!name) throw new Error('清单条目名称不能为空');
    assignments.push('name = ?');
    params.push(name);
  }
  if (patch.unit !== undefined) {
    assignments.push('unit = ?');
    params.push(patch.unit ?? null);
  }
  if (patch.quantity !== undefined) {
    assignments.push('quantity = ?');
    params.push(Math.max(0, roundTo(patch.quantity ?? 0)));
  }
  if (patch.unitPrice !== undefined) {
    assignments.push('unit_price = ?');
    params.push(patch.unitPrice ?? null);
  }
  if (patch.note !== undefined) {
    assignments.push('note = ?');
    params.push(patch.note ?? null);
  }
  if (patch.priority !== undefined) {
    assignments.push('priority = ?');
    params.push(patch.priority ?? 3);
  }

  if (assignments.length === 0) return;
  params.push(id);
  await db.runAsync(
    `UPDATE shopping_list_items SET ${assignments.join(', ')} WHERE id = ?`,
    params,
  );
}

/** 变更条目状态（手写条目和自动抑制记录都用它） */
export async function setItemStatus(
  db: SQLiteDatabase,
  id: number,
  status: ShoppingStatus,
): Promise<void> {
  await db.runAsync(
    'UPDATE shopping_list_items SET status = ?, resolved_at = ? WHERE id = ?',
    [status, status === 'pending' ? null : nowMs(), id],
  );
}

export async function removeShoppingItem(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM shopping_list_items WHERE id = ?', [id]);
}

/** 清空所有已处理条目（bought / skipped） */
export async function clearResolved(
  db: SQLiteDatabase,
): Promise<number> {
  const result = await db.runAsync(
    `DELETE FROM shopping_list_items WHERE status IN ('bought','skipped')`,
  );
  return result.changes;
}

// ---------------------------------------------------------------------------
// 写：自动条目抑制记录
// ---------------------------------------------------------------------------

/**
 * 用户把某条**自动**条目标记为已买/忽略时调用。
 * 名称与单位做快照，物品后续被改名或删除也能正常显示历史。
 */
export async function upsertAutoOverride(
  db: SQLiteDatabase,
  params: {
    itemId: number;
    name: string;
    unit: string | null;
    quantity: number;
    priority: number;
    status: ShoppingResolvedStatus;
    note?: string | null;
  },
): Promise<void> {
  const now = nowMs();
  await db.runAsync(
    `INSERT INTO shopping_list_items
       (item_id, name, unit, quantity, unit_price, source, status, priority, note,
        sort_order, added_at, resolved_at)
     VALUES (?, ?, ?, ?, NULL, 'auto', ?, ?, ?, 0, ?, ?)
     ON CONFLICT(item_id, source) DO UPDATE SET
       name        = excluded.name,
       unit        = excluded.unit,
       quantity    = excluded.quantity,
       priority    = excluded.priority,
       status      = excluded.status,
       note        = excluded.note,
       resolved_at = excluded.resolved_at`,
    [
      params.itemId,
      params.name,
      params.unit,
      Math.max(0, roundTo(params.quantity)),
      params.status,
      params.priority,
      params.note ?? null,
      now,
      now,
    ],
  );
}

/**
 * 撤销自动条目的标记（回到待买状态）。
 * 典型场景：用户补货后库存回升，`replan` 阶段把抑制记录清掉。
 */
export async function clearAutoOverride(
  db: SQLiteDatabase,
  itemId: number,
): Promise<void> {
  await db.runAsync(
    `DELETE FROM shopping_list_items WHERE source = 'auto' AND item_id = ?`,
    [itemId],
  );
}

/** 批量清除抑制记录（导入 / 重置用）。**不开事务**。 */
export async function clearAllAutoOverridesCore(db: SQLiteDatabase): Promise<void> {
  await db.runAsync(`DELETE FROM shopping_list_items WHERE source = 'auto'`);
}

/** 清空整张清单（重置数据用） */
export async function clearAllShoppingItems(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM shopping_list_items');
}
