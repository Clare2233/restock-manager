import type { SQLiteDatabase } from 'expo-sqlite';
import { listItems } from '@/db/repositories/items.repo';
import { listAllMovements } from '@/db/repositories/movements.repo';
import { listAllNotificationHistory } from '@/db/repositories/notifications.repo';
import { readAppSettingsCore } from '@/db/repositories/settings.repo';
import { listAllShoppingItems } from '@/db/repositories/shopping.repo';
import type { BackupFile, BackupItem } from '@/types/backup';
import { BACKUP_VERSION } from '@/types/backup';
import type { Item, Millis } from '@/types/models';
import { nowMs } from '@/utils/date';

/**
 * 组装备份数据（读各 repo → 拼 `BackupFile`）。
 *
 * 这里只做**读 + 形状转换**，不碰文件、不碰分享：
 * 那部分在 `services/backup/export.ts`。
 * 这样拆分的好处是「导出什么」这件事能在 Node 里直接验
 * （`scripts/backup-smoke.mjs` 跑的就是它）。
 *
 * ## 读的路径为什么各不相同
 * `items` 复用已有的 `listItems({ includeArchived: true })` —— 归档的物品也是数据，
 * 漏掉它们等于让导出变成有损的。
 * 其余三张表原本只有「按物品查」的接口，导出时逐个物品查会退化成 N+1，
 * 所以各自补了一个全量版本（见各 repo 的注释）。
 */

export interface BuildBackupOptions {
  /** 导出时刻；默认 `nowMs()`。测试里显式传值以得到稳定结果 */
  exportedAt?: Millis;
}

/** 读库并把四份数据 + 设置组装成备份对象 */
export async function buildBackupPayload(
  db: SQLiteDatabase,
  options: BuildBackupOptions = {},
): Promise<BackupFile> {
  const exportedAtMs = options.exportedAt ?? nowMs();

  const [items, movements, shoppingListItems, notificationHistory, settings] = await Promise.all([
    listItems(db, { includeArchived: true }),
    listAllMovements(db),
    listAllShoppingItems(db),
    listAllNotificationHistory(db),
    readAppSettingsCore(db),
  ]);

  return {
    version: BACKUP_VERSION,
    // UTC 瞬时点：给机器比对用（人在文件里看 Unix 时间戳是看不懂的）
    exportedAt: new Date(exportedAtMs).toISOString(),
    items: items.map(toBackupItem),
    movements,
    shopping_list_items: shoppingListItems,
    notification_history: notificationHistory,
    settings,
  };
}

/**
 * 物品 → 备份格式：唯一要做的事是**丢掉 `stock`**。
 *
 * `stock` 是「流水求和」的缓存值，导出它就是导出第二份事实源：
 * 文件里写 5、流水加起来 3，导入时信谁都是 bug。
 * 所以一律不写，导入后由 `recomputeAllStocksCore` 重算 —— 这也是为什么
 * 备份文件里永远猜不出当时的库存，但导入后一定会和流水对上账。
 */
function toBackupItem(item: Item): BackupItem {
  const { stock, ...rest } = item;
  void stock;
  return rest;
}
