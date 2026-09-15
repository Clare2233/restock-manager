import type { SQLiteDatabase } from 'expo-sqlite';

import { updateAppSettings } from '@/db/repositories/settings.repo';
import { buildBackupPayload } from '@/services/backup/build-payload';
import {
  cleanupStaleTempFiles,
  shareBackupFile,
  writeBackupTempFile,
} from '@/services/backup/file-transfer';
import { summarizeBackupFile } from '@/services/backup/validate';
import type { BackupSummary } from '@/types/backup';
import type { Millis } from '@/types/models';
import { nowMs } from '@/utils/date';

/**
 * 导出备份：组装数据 → 写临时文件 → 呼起系统分享面板 → 记录备份时间。
 *
 * 顺序上唯一值得争论的是最后一步，见下面 `exportBackup` 的注释。
 */

export interface ExportBackupResult {
  fileName: string;
  size: number;
  exportedAt: Millis;
  /** 给用户看的量级统计；也会由调用方写进提示文案 */
  summary: BackupSummary;
}

/**
 * @param options.exportedAt 导出时刻。测试里显式传值以得到稳定的文件名，
 *   将来若支持定时备份也可以复用；不传则用当前时间。
 */
export async function exportBackup(
  db: SQLiteDatabase,
  options: { exportedAt?: Millis } = {},
): Promise<ExportBackupResult> {
  const exportedAt = options.exportedAt ?? nowMs();

  const payload = await buildBackupPayload(db, { exportedAt });
  // 缩进 2 空格：这份文件是给人看、给人手改的（见 types/backup.ts 的说明），
  // 一行压平会让它失去可读性。体积代价在几百 KB 的量级上可以忽略。
  const text = JSON.stringify(payload, null, 2);

  await cleanupStaleTempFiles();
  const tempFile = await writeBackupTempFile(text, exportedAt);
  await shareBackupFile(tempFile);

  /**
   * 分享面板走完之后才写 `lastBackupAt`。
   *
   * 计划里的原话是「分享成功才写」，这里要如实说明一个 API 限制：
   * SDK 57 的 `shareAsync` 返回 `Promise<void>`，**拿不到「用户是否真的分享了」**
   * ——用户在面板里划掉取消，App 这边同样只是 resolve。
   * 于是能拿到的最强信号就是「面板正常走完、没抛错」，
   * 因此这里比原定口径宽松一点：取消分享也会记上备份时间。
   *
   * 这个偏差的代价是可接受的：`lastBackupAt` 的用途是提醒「你很久没备份了」，
   * 偶尔乐观一次不会误导用户，反倒是漏记会让提醒一直挂着。
   */
  try {
    await updateAppSettings(db, { lastBackupAt: exportedAt });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // 文件已经出去了，但本地没记上 —— 两件事都说清楚，不要让用户以为整体失败
    throw new Error(`备份文件已经导出，但本地记录备份时间失败：${reason}`);
  }

  return {
    fileName: tempFile.name,
    size: tempFile.size,
    exportedAt,
    // 复用 validate 里的同一份统计口径，不在这里誊第二遍
    summary: summarizeBackupFile(payload),
  };
}
