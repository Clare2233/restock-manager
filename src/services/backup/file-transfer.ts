import { File as ExpoFile, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

import type {
  PickedBackupFile,
  WrittenBackupFile,
} from '@/services/backup/backup-file';
import {
  BACKUP_FILE_PREFIX,
  BACKUP_MIME_TYPE,
  BACKUP_UTI,
  assertBackupWithinLimit,
  buildBackupFileName,
} from '@/services/backup/backup-file';
import type { Millis } from '@/types/models';

export type { PickedBackupFile, WrittenBackupFile };

/**
 * 文件搬运层（原生：Android / iOS）。
 *
 * **这一层是「平台边界」**：凡是涉及「文件在哪」「怎么把文件交给别的 App」
 * 的知识都只出现在这里，`export.ts` / `import.ts` 只认下面的几个函数。
 *
 * ## 用新版文件 API，不用 legacy
 * SDK 57 里 `FileSystem.readAsStringAsync` / `writeAsStringAsync` 已经标记
 * **废弃**（文档里写明「运行时会抛错」），新版分别是 `new File(...).write()` /
 * `.text()`。legacy 版本要从 `expo-file-system/legacy` 才能 import —— 那意味着
 * 为了备份这一个功能常年挂着一份正在退场的 API，不划算。
 *
 * ## 临时文件为什么写 `Paths.cache`
 * 导出文件的生命周期只有「从生成到分享出去」这一段，
 * cache 目录正是为此设计的（系统空间紧张时可以自行清理）。
 * 写 `Paths.document` 的话，用户的备份文件会长期占着属于 App 的存储空间，
 * 而且 iOS 的「文件」App 会把它们算进 App 的用量里。
 *
 * ## 分享结果为什么是 void
 * SDK 57 的 `shareAsync` 返回 `Promise<void>` —— **无法区分用户分享成功
 * 还是取消了分享面板**（iOS 的系统行为决定了给不出这个信息）。
 * 所以这里只要没抛错就当作「面板已经走完一轮」，调用方据此记账。
 * 详见 `export.ts` 里写 `lastBackupAt` 那段注释。
 */
export const BACKUP_TRANSFER_SUPPORTED = true;

/**
 * 把备份文本写成临时文件，返回它的 URI 给分享用。
 *
 * `overwrite: true`：同一天第二次导出会撞上同一个文件名，
 * 不覆盖的话 `create()` 会抛「文件已存在」，而用户只是又点了一次导出。
 */
export async function writeBackupTempFile(
  text: string,
  exportedAt: Millis,
): Promise<WrittenBackupFile> {
  const name = buildBackupFileName(exportedAt);
  const file = new ExpoFile(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(text);

  return { uri: file.uri, name, size: file.size };
}

/**
 * 读出选中文件的文本。**这里是 20MB 上限真正的落地点之一**：
 * `text()` 会把整份文件读进内存，所以先问 `size` 再决定读不读。
 */
export async function readBackupText(picked: PickedBackupFile): Promise<string> {
  const file = new ExpoFile(picked.uri);
  if (!file.exists) {
    // 选择器的默认行为是复制到 cache 目录，理论上一定可读；
    // 读不到通常意味着它在被夸平台传递的过程中被清掉了 —— 让用户重选一次即可。
    throw new Error('读不到这个文件了，它可能已被系统清理，请重新选择一次');
  }

  assertBackupWithinLimit(file.size);
  return await file.text();
}

/**
 * 弹出系统分享面板。
 *
 * `mimeType` 给 Android、`UTI` 给 iOS —— 两个参数同时传，
 * 各自平台取自己认识的那个（不认识的会被忽略）。
 */
export async function shareBackupFile(file: WrittenBackupFile): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('这台设备上没有可用的分享方式，无法导出备份文件');
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: BACKUP_MIME_TYPE,
    UTI: BACKUP_UTI,
    dialogTitle: `导出${file.name}`,
  });
}

/**
 * 打开系统文件选择器。**返回 null 表示用户取消了**，不是错误 ——
 * 取消分享/选择是最常见的分支，必须能在上层被安静地忽略掉。
 *
 * 刻意**不传 MIME 过滤器**：iOS / Android 上各家文件提供方对 json 的报告口径
 * 并不一致（同一个 .json 在微信里可能被报成 `application/octet-stream`），
 * 一旦过滤，用户可能**选不到自己的备份文件** —— 那比让他多选几个文件严重得多。
 * 格式判断交给 `validateBackupFile`，它报错时能说清楚缺了什么。
 */
export async function pickBackupFile(): Promise<PickedBackupFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset) return null;

  // 先按选择器报告的体积挡一道：避免把一个大家伙读进内存
  assertBackupWithinLimit(asset.size);

  return { uri: asset.uri, name: asset.name };
}

/**
 * 清掉上一次导出留下的临时文件（在写新文件之前调用）。
 *
 * 两个「为什么」：
 * - 为什么**不在分享完之后立刻删**：分享是异步的，接收方可能还在读文件，
 *   删早了会让对方拿到一个空/半文件（表现为 AirDrop 收到 0 字节）。
 * - 为什么还要删：不删的话缓存里会一直留着历次导出的备份，
 *   它们对用户不可见却占空间，也不该跟着 App 备份到 iCloud。
 *
 * best-effort：清理失败（比如正在被别的进程占用）不影响本次导出。
 */
export async function cleanupStaleTempFiles(): Promise<void> {
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof ExpoFile && entry.name.startsWith(BACKUP_FILE_PREFIX)) {
        entry.delete();
      }
    }
  } catch (error) {
    console.warn(
      '[backup] 清理旧的临时文件失败：',
      error instanceof Error ? error.message : String(error),
    );
  }
}
