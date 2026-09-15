import { useCallback, useRef, useState } from 'react';

import { getReadyDatabase } from '@/db/client';
import { countItems } from '@/db/repositories/items.repo';
import { countAllMovements } from '@/db/repositories/movements.repo';
import { useAppSettings } from '@/hooks/use-app-settings';
// 别名导入：下面要用同名的 `exportBackup` 作为对外暴露的 action，
// 直接同名会让回调内部递归调用自己（且 TypeScript 不会报错）
import {
  exportBackup as exportBackupFile,
  type ExportBackupResult,
} from '@/services/backup/export';
import { BACKUP_TRANSFER_SUPPORTED } from '@/services/backup/file-transfer';
import {
  applyBackupFile,
  clearAllLocalData,
  pickAndValidateBackup,
  type PickedBackup,
} from '@/services/backup/import';
import type { RestoreCounts } from '@/services/backup/restore';
import type { Millis } from '@/types/models';

/**
 * 备份操作的页面状态机（第三批次设置页的数据层）。
 *
 * ## 为什么要一个明确的 phase
 * 三个操作都会开 SQLite 事务并整表重写，耗时几百毫秒起。
 * 这段时间内如果用户又点一次「导入」，第二次调用会在第一次的事务还没提交时
 * 再开一个清表 —— 结果不可预测。**「忙」必须是一个页面看得见的状态**，
 * 按钮禁用靠它，防重复进入也靠它。
 *
 * ## 为什么「用户取消」不算错误
 * 在文件选择器 / 分享面板里划掉是最常见的分支（比失败常见得多）。
 * 把它当成失败会弹出「导出失败」，用户会以为 App 坏了。
 * 所以取消统一表现为「返回 null / 什么都没发生」，只有真正的失败进 `error`。
 */

export type BackupPhase = 'idle' | 'exporting' | 'importing' | 'clearing';

/** 「清空数据」确认弹窗要显示的量级 */
export interface DataCounts {
  items: number;
  movements: number;
}

export interface UseBackupResult {
  /** 当前在做的事；'idle' = 可以接受新操作 */
  phase: BackupPhase;
  busy: boolean;
  /** 最近一次失败原因；新操作开始时自动清空 */
  error: string | null;
  /** 设置里记录的备份/恢复时间，用于「上次备份：…」这类文案 */
  lastBackupAt: Millis | null;
  lastRestoreAt: Millis | null;
  /** 最近一次成功导入的量级，成功后给用户一个明确反馈 */
  lastRestoreCounts: RestoreCounts | null;
  /**
   * 导出：组装 → 分享面板 → 记时间。成功返回文件信息给页面做提示；
   * 失败返回 `null`，原因进 `error`。
   *
   * 注意这里**无法**表达「用户在分享面板里划掉了」：SDK 57 的 `shareAsync`
   * 对「分享成功」与「取消」都是 resolve（见 `services/backup/export.ts`），
   * 所以面板走完一律按成功处理。
   */
  exportBackup: () => Promise<ExportBackupResult | null>;
  /** 选文件并校验（用于给确认弹窗备料）；用户取消返回 null */
  pickBackup: () => Promise<PickedBackup | null>;
  /** 用户确认之后真正落库；这是不可逆的一步 */
  applyBackup: (picked: PickedBackup) => Promise<RestoreCounts | null>;
  /** 清空全部数据回到出厂状态 */
  clearAllData: () => Promise<boolean>;
  /**
   * 现库里有多少东西，给「清空数据」的确认弹窗用词。
   * 每次弹窗前查一次：这一刻的数字才是有意义的，缓存会骗人。
   */
  loadDataCounts: () => Promise<DataCounts | null>;
  clearError: () => void;
  refreshTimes: () => Promise<void>;
}

export function useBackup(): UseBackupResult {
  const { settings, refresh: refreshSettings } = useAppSettings();
  const [phase, setPhase] = useState<BackupPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastRestoreCounts, setLastRestoreCounts] = useState<RestoreCounts | null>(null);

  /**
   * 「忙」的真相在这里，不在 state 里。
   *
   * `setPhase` 是异步的：同一次事件里连点两次，两次读到的 phase 都还是 'idle'。
   * 用一个 ref 当互斥锁才能真正挡住第二次进入。
   */
  const busyRef = useRef(false);

  const runInPhase = useCallback(
    async <T>(nextPhase: BackupPhase, action: () => Promise<T>): Promise<T | null> => {
      if (busyRef.current) return null;
      if (!BACKUP_TRANSFER_SUPPORTED) {
        setError('网页版不支持导出 / 导入备份文件，请在手机 App 里操作');
        return null;
      }

      busyRef.current = true;
      setPhase(nextPhase);
      setError(null);
      try {
        return await action();
      } catch (cause) {
        setError(toMessage(cause));
        return null;
      } finally {
        busyRef.current = false;
        setPhase('idle');
      }
    },
    [],
  );

  const exportBackup = useCallback(
    () =>
      runInPhase('exporting', async () => {
        const db = await getReadyDatabase();
        const result = await exportBackupFile(db);
        // 让「上次备份时间」立刻显示新值，而不是等用户离开再回来才发现它变了
        await refreshSettings();
        return result;
      }),
    [runInPhase, refreshSettings],
  );

  const pickBackup = useCallback(
    () => runInPhase('importing', () => pickAndValidateBackup()),
    [runInPhase],
  );

  const applyBackup = useCallback(
    (picked: PickedBackup) =>
      runInPhase('importing', async () => {
        const db = await getReadyDatabase();
        const counts = await applyBackupFile(db, picked.file);
        setLastRestoreCounts(counts);
        await refreshSettings();
        return counts;
      }),
    [runInPhase, refreshSettings],
  );

  const clearAllData = useCallback(
    () =>
      runInPhase('clearing', async () => {
        const db = await getReadyDatabase();
        await clearAllLocalData(db);
        setLastRestoreCounts(null);
        await refreshSettings();
        return true;
      }).then((ok) => ok !== null),
    [runInPhase, refreshSettings],
  );

  /**
   * 计量这条刻意放在 hook 里而不是服务层：它只为 UI 的确认弹窗服务，
   * 与「怎么删」无关，进 `restore.ts` 会把那份纯 SQL 片段弄脏。
   *
   * `includeArchived: true` —— 清空连带归档物品一起删，
   * 少算那部分会出现「弹窗说删 3 件、结果没了 5 件」。
   */
  const loadDataCounts = useCallback(async (): Promise<DataCounts | null> => {
    try {
      const db = await getReadyDatabase();
      const [items, movements] = await Promise.all([
        countItems(db, { includeArchived: true }),
        countAllMovements(db),
      ]);
      return { items, movements };
    } catch (cause) {
      setError(toMessage(cause));
      return null;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    phase,
    busy: phase !== 'idle',
    error,
    lastBackupAt: settings.lastBackupAt,
    lastRestoreAt: settings.lastRestoreAt,
    lastRestoreCounts,
    exportBackup,
    pickBackup,
    applyBackup,
    clearAllData,
    loadDataCounts,
    clearError,
    refreshTimes: refreshSettings,
  };
}

function toMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text === 'undefined' || text === '' ? '未知错误' : text;
}
