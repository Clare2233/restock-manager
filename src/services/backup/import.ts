import type { SQLiteDatabase } from 'expo-sqlite';

import { cancelAllScheduledJobs, rescheduleAll } from '@/notifications/scheduler';
import { pickBackupFile, readBackupText } from '@/services/backup/file-transfer';
import { clearAllDataCore, restoreBackup, type RestoreCounts } from '@/services/backup/restore';
import { parseBackupFile } from '@/services/backup/validate';
import { bumpDataEpoch } from '@/store/data-epoch';
import type { BackupFile, BackupSummary } from '@/types/backup';
import type { Millis } from '@/types/models';

/**
 * 「**整份数据被替换**」的编排层：导入备份，以及清空数据（还原到出厂状态）。
 *
 * 两个操作放在同一个文件里，是因为它们要走**完全相同的顺序**，
 * 而这段顺序有一处错了就是事故（见 `applyReplacement`）：
 *
 *   ① 事务外：取消系统里已排的通知
 *   ② 事务内：清表 → 插入 → 重算库存 → 写设置
 *   ③ 成功后：广播 epoch + `rescheduleAll({ force: true })`
 *   ④ 失败后：`rescheduleAll({ force: true })` 把**旧数据的通知排回来**
 *
 * 第 ① 步必须在最前面，而且**绝不能进事务**：
 * identifier 只存在 `notification_jobs` 里，一旦第 ② 步把表清了，
 * 那些已经排进系统的通知就再也取消不掉了 —— 它们会在旧时间点照响，
 * 而 App 已经不认识它们。反过来，把异步原生调用塞进 SQLite 事务
 * 会让两边互相等待，属于禁区。
 *
 * 第 ④ 步同理重要：事务回滚后库是旧的，但系统里的通知已经被 ① 取消了，
 * 必须把旧的排回来，否则「导入失败」之后用户会发现提醒也一起消失了。
 *
 * `restore.ts` 之所以不干这些事，是为了让它在 Node 里能被直接跑
 * （`scripts/backup-smoke.mjs`）：那里没有 expo-notifications。
 */

/** 选完文件、通过校验的备份，等待用户在确认弹窗里点头 */
export interface PickedBackup {
  file: BackupFile;
  /** 确认弹窗要用到的量级统计 */
  summary: BackupSummary;
}

/**
 * 选文件 → 读文本 → 校验。**到这一步为止不碰数据库**。
 *
 * @returns 用户取消时返回 `null`（调用方应静默处理，不要弹错误）
 * @throws 文件读不了 / 格式不对 / 超过体积上限
 */
export async function pickAndValidateBackup(): Promise<PickedBackup | null> {
  const picked = await pickBackupFile();
  if (!picked) return null;

  const text = await readBackupText(picked);
  const result = parseBackupFile(text);
  if (!result.ok) {
    throw new Error(`「${picked.name}」不是有效的备份文件：${result.error}`);
  }

  return { file: result.file, summary: result.summary };
}

/**
 * 用备份文件替换现有数据。**这一步不可逆**，调用方必须先让用户确认。
 *
 * @throws 事务失败（库会回滚到导入前的样子，通知也会排回来）
 */
export async function applyBackupFile(
  db: SQLiteDatabase,
  file: BackupFile,
  options: { now?: Millis } = {},
): Promise<RestoreCounts> {
  const counts = await applyReplacement(db, (target) =>
    restoreBackup(target, file, { now: options.now }),
  );
  return counts;
}

/**
 * 清空全部数据回到出厂状态（设置页「清空数据」）。同样不可逆。
 *
 * 与 `clearAllDataCore` 的关系：后者只是「事务里删六张表」这条 SQL 片段，
 * 这里的额外职责是通知与缓存 —— 那些 SQL 片段接触不到的东西。
 */
export async function clearAllLocalData(db: SQLiteDatabase): Promise<void> {
  await applyReplacement(db, clearAllDataCore);
}

/**
 * 上面两个操作的公共骨架，把「顺序」这件事只写一遍。
 *
 * `replace` 必须是**单个事务**（由 `restore.ts` 内部保证）：
 * 它在抛出时，库已经自动回到操作前的状态。
 */
async function applyReplacement<T>(
  db: SQLiteDatabase,
  replace: (db: SQLiteDatabase) => Promise<T>,
): Promise<T> {
  // ① 事务外：取消系统里已排的通知（内部已 best-effort，不会抛）
  await cancelAllScheduledJobs(db);

  try {
    // ② 单个事务
    const result = await replace(db);

    // ③ 数据换了 → 让各页面的缓存失效；它们下次聚焦时会无条件重查
    bumpDataEpoch();
    // ③' 把新数据该有的通知排回去
    await rescheduleQuietly(db, '数据替换后重排通知失败');

    return result;
  } catch (error) {
    // ④ 事务已回滚，库还是旧的 → 把旧通知排回来
    await rescheduleQuietly(db, '操作失败、恢复旧通知失败');
    throw error;
  }
}

/**
 * 重排是**旁路**：它失败不应该把「导入成功」变成「导入失败」——
 * 数据已经落库了，用户看到失败会以为没导入。但也不能静默，
 * 所以按项目一贯的做法落到 `console.warn`（同 `reschedule-debounce.ts`）。
 */
async function rescheduleQuietly(db: SQLiteDatabase, context: string): Promise<void> {
  try {
    await rescheduleAll(db, { force: true });
  } catch (error) {
    console.warn(
      `[backup] ${context}：`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
