import type { Millis } from '@/types/models';
import { toISODate } from '@/utils/date';

/**
 * 备份文件的「外部契约」：叫什么名字、什么类型、多大算太大。
 *
 * 单独一个小文件的原因：平台相关的实现有两个（`file-transfer.ts` /
 * `file-transfer.web.ts`，Metro 按平台二选一），但**文件名与大小上限
 * 必须是同一套** —— 否则 web 版登记的档位与 native 版迟早漂移，
 * 而这种漂移只在某一边被改动时才出现，最难发现。
 */

/**
 * 选择器选中的文件。
 * 放在这里而不是两个平台实现里各写一遍：两边必须是同一个形状，
 * 否则 `File` 与 `.web.ts` 迟早对不上。
 */
export interface PickedBackupFile {
  /** 可以直接喂给 `File` 的本地 URI（选择器已复制到缓存目录） */
  uri: string;
  /** 原始文件名，只用于报错文案 */
  name: string;
}

/** 已写好、正等着被分享出去的临时文件 */
export interface WrittenBackupFile {
  uri: string;
  name: string;
  /** 体积（字节），用于给用户一个「导出成功了多大」的反馈 */
  size: number;
}

/** json 的标准 MIME；Android 的分享 Intent 用它 */
export const BACKUP_MIME_TYPE = 'application/json';

/** iOS 的 Uniform Type Identifier；与上面同一个类型，只是系统不同叫法不同 */
export const BACKUP_UTI = 'public.json';

/** 导出文件名前缀；临时文件的清理靠它识别「这是我写的文件」 */
export const BACKUP_FILE_PREFIX = '囤货清单备份';

/**
 * 导入文件的大小上限（20 MB）。
 *
 * 为什么要有：读文件是**整份读进内存再 JSON.parse**（见 file-transfer），
 * 没有上限的话，用户在文件管理器里随手选中一个 800MB 的视频，
 * App 会在解析阶段被系统杀掉 —— 表现出来就是「闪退」，而且没有堆栈。
 *
 * 20MB 够不够：一件物品大约 500B、一条流水 200B，
 * 20MB 换算下来是上万件物品 + 几十万条流水，远超一个家庭的量级。
 */
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

/** 刻意不加随机后缀：同一天重复导出会覆盖同一个文件，缓存不会越积越多 */
export function buildBackupFileName(exportedAt: Millis): string {
  return `${BACKUP_FILE_PREFIX}-${toISODate(exportedAt)}.json`;
}

/** 报错文案用的可读体积；按 1024 进制，与系统的「MB」口径一致 */
export function describeBackupBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * 大小守卫。
 *
 * `null / undefined` 表示拿不到体积（选择器没报告），此时**放行**：
 * 真正的边界在意侧的 `file.size` 上还会再守一次（见 `readBackupText`），
 * 这里放行好过误杀一个正常文件。
 */
export function assertBackupWithinLimit(bytes: number | null | undefined): void {
  if (bytes === null || bytes === undefined) return;
  if (bytes <= MAX_BACKUP_BYTES) return;

  throw new Error(
    `这个文件有 ${describeBackupBytes(bytes)}，超过上限 ${describeBackupBytes(MAX_BACKUP_BYTES)}；` +
      '备份文件通常只有几百 KB，请确认选中的是备份文件而不是别的文件',
  );
}
