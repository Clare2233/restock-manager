import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_APP_SETTINGS } from '@/constants/defaults';
import { getReadyDatabase } from '@/db/client';
import { getAppSettings, updateAppSettings } from '@/db/repositories/settings.repo';
import type { AppSettings } from '@/types/models';

/**
 * 全局设置的 React 入口。
 *
 * 与 `use-items` 不同，这里**不做模块级缓存**：设置是一份小 JSON，
 * 读一次的成本可以忽略；而多一份缓存就多一份失效逻辑
 * （设置页改完、别处也要立刻看到新值）。每次挂载直读即可。
 *
 * `update` 返回是否成功，由页面决定要不要提示 ——
 * 保存失败不能静默（用户会以为设置生效了，其实没写进去）。
 *
 * 注意：**写完不会自动重排通知**。重排由调用方显式触发
 * （设置页保存后自己调 `rescheduleAll`），因为「改设置」和「改库存」
 * 走的是两个不同的触发源，塞进这里会让这个 hook 悄悄依赖通知模块。
 */
export interface UseAppSettingsResult {
  settings: AppSettings;
  /** 首次读取中 */
  loading: boolean;
  /** 写入中 */
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<boolean>;
}

export function useAppSettings(): UseAppSettingsResult {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 「先发后到」保护：与 items.store / use-item-detail 同一套做法
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    try {
      const db = await getReadyDatabase();
      const next = await getAppSettings(db);
      if (token !== loadToken.current) return;
      setSettings(next);
      setError(null);
    } catch (cause) {
      if (token !== loadToken.current) return;
      setError(toMessage(cause));
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    setSaving(true);
    try {
      const db = await getReadyDatabase();
      // 用 repo 返回的那份（已与默认值合并、已夹取范围），而不是本地拼的对象
      const next = await updateAppSettings(db, patch);
      setSettings(next);
      setError(null);
      return true;
    } catch (cause) {
      setError(toMessage(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, loading, saving, error, refresh: load, update };
}

function toMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text === 'undefined' || text === '' ? '未知错误' : text;
}
