import type { SQLiteDatabase } from 'expo-sqlite';
import {
  clearAllBusinessTablesCore,
  insertBackupHistoryCore,
  insertBackupItemCore,
  insertBackupMovementCore,
  insertBackupShoppingItemCore,
} from '@/db/repositories/backup.repo';
import { recomputeAllStocksCore } from '@/db/repositories/movements.repo';
import { sanitizeAppSettings, writeAppSettingsCore } from '@/db/repositories/settings.repo';
import type { BackupFile } from '@/types/backup';
import type { Millis } from '@/types/models';
import { nowMs } from '@/utils/date';

/**
 * 备份恢复 —— 把一份**已经通过校验**的 `BackupFile` 写回数据库。
 *
 * ## 本次争议点：为什么整个恢复是一个事务
 * 恢复 = 清空 6 张表 + 写入若干 thousand 行。任何一步炸，库必须还是**原来的样子**。
 * 「一半是新数据、一半是旧数据」是比「导入失败」糟糕得多的结果：
 * 用户看不到「导入成功」提示，但 App 里已经是混合物了，而且无法回头。
 *
 * ## 调用方的责任（本文件不做）
 * 1. **先跑 `validateBackupFile`**。这里的 SQL 是「原样落库」，
 *    唯一的防线就是 DB 的 CHECK / 外键，报错信息对用户毫无帮助。
 * 2. **先取消系统里已排的通知**（`cancelScheduledNotificationAsync`）。
 *    它是异步原生调用，**绝不能放进事务**；而一旦 `notification_jobs`
 *    被清空，那些 identifier 就再也找不回来了 —— 顺序必须是「先取消 → 再清表」。
 * 3. 事务提交后调 `rescheduleAll({ force: true })` 把新数据的通知排回去；
 *    事务失败时用同样一句把**旧的**排回来（库已回滚，旧数据还在）。
 *
 * ## 为什么不用 `resetDatabase()`
 * 它会 DROP 表并重新播种示例数据，恢复出来的库里会凭空多一套示例物品。
 * 见 `db/repositories/backup.repo.ts` 的说明。
 */

export interface RestoreCounts {
  items: number;
  movements: number;
  shoppingListItems: number;
  notificationHistory: number;
}

export interface RestoreOptions {
  /**
   * 「恢复完成」的时间戳。默认 `nowMs()`；
   * 测试里显式传值，断言才能稳定。
   */
  now?: Millis;
}

/**
 * 在单个事务里清空现有数据并写入备份。
 *
 * 顺序说明：
 * - 先 `items` 再其余表：所有 `item_id` 外键都指向它
 *   （validate 已经查过参照完整性，这里只是保证 SQLite 侧不炸）；
 * - 流水插完才 `recomputeAllStocksCore`：`items.stock` 是由流水求和得出的缓存，
 *   必须最后算，早一步算都是错的；
 * - 设置最后写，`lastRestoreAt` 用**本次**时间覆盖文件里的值 ——
 *   文件里那个是「上次恢复的时间」，留着会让设置页显示错误。
 *
 * @throws 任何一步失败都会整体回滚；调用方负责展示错误
 */
export async function restoreBackup(
  db: SQLiteDatabase,
  file: BackupFile,
  options: RestoreOptions = {},
): Promise<RestoreCounts> {
  const now = options.now ?? nowMs();

  await db.withTransactionAsync(async () => {
    await clearAllBusinessTablesCore(db);

    for (const item of file.items) {
      await insertBackupItemCore(db, item);
    }
    for (const movement of file.movements) {
      await insertBackupMovementCore(db, movement);
    }
    for (const entry of file.shopping_list_items) {
      await insertBackupShoppingItemCore(db, entry);
    }
    for (const entry of file.notification_history) {
      await insertBackupHistoryCore(db, entry);
    }

    await recomputeAllStocksCore(db);

    await writeAppSettingsCore(db, sanitizeAppSettings({ ...file.settings, lastRestoreAt: now }));
  });

  return {
    items: file.items.length,
    movements: file.movements.length,
    shoppingListItems: file.shopping_list_items.length,
    notificationHistory: file.notification_history.length,
  };
}

/**
 * 清空全部数据回到出厂状态（设置页「清空数据」用）。
 *
 * 与 `resetDatabase()` 的区别：**不播种**。用户按这个按钮想要的是
 * 「抹掉我的数据」，而不是「把示例物品再要回来」。
 * `app_settings` 一并清空 → 下次读取时回落到 `DEFAULT_APP_SETTINGS`。
 *
 * 同样不碰事务外的东西：取消系统通知、`rescheduleAll`、刷新缓存由调用方负责。
 */
export async function clearAllDataCore(db: SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await clearAllBusinessTablesCore(db);
  });
}
