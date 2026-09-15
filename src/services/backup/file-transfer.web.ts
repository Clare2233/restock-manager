import type {
  PickedBackupFile,
  WrittenBackupFile,
} from '@/services/backup/backup-file';
import type { Millis } from '@/types/models';

export type { PickedBackupFile, WrittenBackupFile };

/**
 * 文件搬运层的 **web 空实现**（Metro 在 web 平台优先解析 `*.web.ts`）。
 *
 * 为什么每个函数都抛错而不是静默返回：备份是「看得见的一次操作」，
 * 用户点了「导出」就必须知道结果。静默成功会让将来接手的人以为
 * web 上这条路走得通，然后花很长时间排查「为什么文件没出现」。
 * 抛错在第一次被调用时就暴露出来，错误也容易被定位。
 *
 * 按计划，web 上的设置页显示 EmptyState（Q1），
 * 正常路径**不会**调到这里 —— 这些函数是防止误用的护栏。
 *
 * 这里**不能** import 任何 expo 运行时模块：`expo-file-system` /
 * `expo-sharing` 进 web 包会在运行时直接炸。
 */
export const BACKUP_TRANSFER_SUPPORTED = false;

function unsupported(): never {
  throw new Error('网页版不支持导出 / 导入备份文件，请在手机 App 里操作');
}

export async function writeBackupTempFile(
  _text: string,
  _exportedAt: Millis,
): Promise<WrittenBackupFile> {
  return unsupported();
}

export async function readBackupText(_picked: PickedBackupFile): Promise<string> {
  return unsupported();
}

export async function shareBackupFile(_file: WrittenBackupFile): Promise<void> {
  unsupported();
}

export async function pickBackupFile(): Promise<PickedBackupFile | null> {
  return unsupported();
}

export async function cleanupStaleTempFiles(): Promise<void> {
  // 没有写过的文件，也就没有可清理的东西；这里「什么都不做」是对的行为
}
