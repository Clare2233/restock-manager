import Constants from 'expo-constants';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppButton } from '@/components/common/app-button';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { FieldRow } from '@/components/common/field-row';
import { SectionCard } from '@/components/common/section-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BUILD_ID } from '@/constants/defaults';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { getReadyDatabase } from '@/db/client';
import { useAppSettings } from '@/hooks/use-app-settings';
import type { DataCounts } from '@/hooks/use-backup';
import { useBackup } from '@/hooks/use-backup';
import { useRefreshOnFocus } from '@/hooks/use-items';
import { useNotificationPermission } from '@/hooks/use-notification-permission';
import { useTheme } from '@/hooks/use-theme';
import type { NotificationPermissionState } from '@/notifications/permissions';
import { rescheduleAll } from '@/notifications/scheduler';
import { describeBackupBytes } from '@/services/backup/backup-file';
import { BACKUP_TRANSFER_SUPPORTED } from '@/services/backup/file-transfer';
import type { PickedBackup } from '@/services/backup/import';
import { isValidClock, toISODate } from '@/utils/date';

const ICON_SETTINGS = { ios: 'gearshape', android: 'settings', web: 'settings' } as const;
const ICON_MOBILE = { ios: 'iphone', android: 'smartphone', web: 'smartphone' } as const;

/** app.json 里的 `expo.version`；`Constants.expoConfig` 在极少数启动路径下也可能是 null */
const APP_VERSION = Constants.expoConfig?.version ?? '未知';

/**
 * 开源许可的地址。
 *
 * 项目里既没有 `package.json.repository` 也没有 README 链接，
 * 所以这里指向 MIT 许可证的官方文本（仓库根目录的 `LICENSE` 就是 MIT）。
 * 将来有了自己的仓库地址，改这一个常量即可。
 */
const LICENSE_URL = 'https://opensource.org/license/mit';

/** 权限状态的中文展示；与 `useNotificationPermission` 的四态一一对应 */
const PERMISSION_TEXT: Record<NotificationPermissionState, string> = {
  granted: '已授权',
  denied: '已被系统关闭',
  undetermined: '还没询问过',
  unsupported: '当前平台不支持',
};

/**
 * 设置页。
 *
 * 四块内容，从上到下：
 * 1. 补货提醒 —— 开关 / 每日提醒时间 / 重复提醒间隔；
 * 2. 系统权限 —— 状态展示 + 「去系统设置」的入口；
 * 3. **数据** —— 备份导出 / 导入 / 清空（三个不可逆程度不同的操作）；
 * 4. 关于 —— 版本、构建标识、开源许可。
 *
 * 两个刻意的设计：
 * - **开关立即写库，时间与间隔点「保存」才写**。
 *   开关是「有没有」，改完立刻生效符合直觉；而时间/间隔要校验，
 *   边打字边写库会在中间态（比如 "0" 、""）写出非法值。
 * - **写什么都要重排一次通知**。设置变了，系统里那条待发通知
 *   不会自己更新，只有重排才会换成新的时间与文案。
 *   重排是幂等的，重复调用不会多排。
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { settings, loading, saving, error, update } = useAppSettings();
  const { permission, granted, request } = useNotificationPermission();

  const [timeText, setTimeText] = useState(settings.defaultNotifyTime);
  const [intervalText, setIntervalText] = useState(String(settings.reRemindIntervalDays));
  /** 用户是否已经改过输入：改过之后就不该再被异步回来的设置覆盖 */
  const [touched, setTouched] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 设置是异步读回来的，读完把输入框初值对齐一次
  useEffect(() => {
    if (loading || touched) return;
    setTimeText(settings.defaultNotifyTime);
    setIntervalText(String(settings.reRemindIntervalDays));
  }, [loading, settings, touched]);

  const reschedule = async (): Promise<void> => {
    try {
      const db = await getReadyDatabase();
      await rescheduleAll(db);
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // 权限变成已授权（典型场景：从系统设置里打开后切回来）→ 补一次重排。
  // 否则这次授权要等到下次写操作或跨天才真正排上通知。
  // 幂等，进页面时多跑一次也不会重复排。
  useEffect(() => {
    if (granted) void reschedule();
    // reschedule 每次渲染都是新函数，只在 granted 变化时才该跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted]);

  const parsedInterval = Number(intervalText.trim());
  const timeError = isValidClock(timeText.trim()) ? null : '请填 HH:mm，例如 09:00';
  const intervalError =
    Number.isInteger(parsedInterval) && parsedInterval >= 1 && parsedInterval <= 90
      ? null
      : '请填 1 到 90 之间的整数';
  const canSave = !saving && timeError === null && intervalError === null;

  const handleToggle = async (value: boolean) => {
    const ok = await update({ notificationsEnabled: value });
    if (ok) await reschedule();
  };

  const handleSave = async () => {
    if (!canSave) return;
    const ok = await update({
      defaultNotifyTime: timeText.trim(),
      reRemindIntervalDays: parsedInterval,
    });
    if (ok) {
      setTouched(false);
      await reschedule();
    }
  };

  const handleRequestPermission = async () => {
    const next = await request();
    // 授权成功立刻补排；被拒则保持现状，用户能看见状态与「去系统设置」按钮
    if (next === 'granted') await reschedule();
  };

  /**
   * 备份状态机整体挂在 `useBackup()` 里（阶段、错误、动作都是它的），
   * 页面只持有「弹窗该不该开着」这类纯 UI 状态。
   *
   * `pendingImport` 存的是**整个** `PickedBackup`（选中的文件 + 已解析出的统计），
   * 而不是把几个字段摊平成多个 state：弹窗显示的统计与确认时真正导入的
   * 必须是同一个对象，摊平之后就可能出现「显示 A 的统计、结果导入了 B」的错位。
   */
  const backup = useBackup();
  useRefreshOnFocus();

  /** 选完文件、等待用户在弹窗里点头 */
  const [pendingImport, setPendingImport] = useState<PickedBackup | null>(null);
  /** 「清空数据」弹窗是否打开。与 counts 分开：见 `handlePressClear` 的说明 */
  const [clearOpen, setClearOpen] = useState(false);
  /** 「清空数据」弹窗要念出的量级；取不到时用兜底文案 */
  const [clearCounts, setClearCounts] = useState<DataCounts | null>(null);
  /** 成功提示。失败提示不在这里 —— 它由 `backup.error` 直接渲染 */
  const [successText, setSuccessText] = useState<string | null>(null);

  const handleExport = async () => {
    setSuccessText(null);
    const result = await backup.exportBackup();
    if (result) {
      setSuccessText(`已导出 ${result.fileName}（${describeBackupBytes(result.size)}）`);
    }
  };

  const handlePickImport = async () => {
    setSuccessText(null);
    const picked = await backup.pickBackup();
    // 在文件选择器里划掉是最常见的分支：安静地什么都不做，不要弹任何提示
    if (picked) setPendingImport(picked);
  };

  const handleConfirmImport = async () => {
    const target = pendingImport;
    if (!target) return;
    const counts = await backup.applyBackup(target);
    // 成败都收起弹窗：失败原因显示在页面下方的 feedback 区，
    // 留在弹窗里会被遮罩挡住，用户看到的是「点了没反应」。
    setPendingImport(null);
    if (counts) {
      setSuccessText(`已导入 ${counts.items} 件物品、${counts.movements} 条流水`);
    }
  };

  /**
   * 「弹窗是否打开」与「念出多少」是**两个** state，不能合成一个 `clearCounts !== null`。
   * 因为统计是即时查出来的，查失败时 `clearCounts` 为 null ——
   * 若用它的有无控制弹窗，用户点「清空数据」就只是「点了没反应」，
   * 失败原因还藏在页面下方。所以取数失败也照常开弹窗，只是不念数量。
   */
  const handlePressClear = async () => {
    setSuccessText(null);
    setClearCounts(await backup.loadDataCounts());
    setClearOpen(true);
  };

  const handleConfirmClear = async () => {
    const ok = await backup.clearAllData();
    setClearOpen(false);
    setClearCounts(null);
    if (ok) setSuccessText('数据已清空，可以导入备份恢复');
  };

  const importSummaryText =
    pendingImport === null
      ? ''
      : `将导入 ${pendingImport.summary.items} 件物品、${pendingImport.summary.movements} 条流水、` +
        `${pendingImport.summary.shoppingListItems} 条清单条目；现有数据全部清空，无法撤销`;

  const clearSummaryText =
    clearCounts === null
      ? '现有数据全部清空，无法撤销'
      : `将删除 ${clearCounts.items} 件物品、${clearCounts.movements} 条流水；无法撤销`;

  const lastBackupHint =
    backup.lastBackupAt === null ? '还没导出过' : `上次导出 ${toISODate(backup.lastBackupAt)}`;

  return (
    <ThemedView style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.three,
            paddingBottom: BottomTabInset + Spacing.five,
          },
        ]}
        showsVerticalScrollIndicator={false}>
        {permission === 'unsupported' ? (
          // 非原生平台没有通知，整块隐藏比显示一堆点不动的开关好
          <EmptyState
            icon={<SymbolView name={ICON_SETTINGS} size={24} tintColor={theme.textSecondary} />}
            title="设置还没做"
            description="通知相关设置只在手机端提供；数据与版本信息在下面。"
          />
        ) : (
          <>
            <SectionCard
              title="补货提醒"
              description="开关立即生效；时间与间隔改完点下面的「保存」"
              flush>
              <FieldRow
                label="启用补货提醒"
                hint={
                  settings.notificationsEnabled && !granted
                    ? '还需要系统通知权限，见下面一块'
                    : '关掉后不会有任何通知，消耗记录照常生效'
                }
                hintTone={settings.notificationsEnabled && !granted ? 'danger' : 'secondary'}>
                <Switch
                  accessibilityLabel="启用补货提醒"
                  value={settings.notificationsEnabled}
                  disabled={saving}
                  onValueChange={(value) => void handleToggle(value)}
                />
              </FieldRow>

              <FieldRow
                label="每日提醒时间"
                hint={timeError ?? '到点后把该买的凑成一条发给你'}
                hintTone={timeError ? 'danger' : 'secondary'}>
                <TextInput
                  value={timeText}
                  onChangeText={(text) => {
                    setTouched(true);
                    setTimeText(text);
                  }}
                  accessibilityLabel="每日提醒时间"
                  placeholder="09:00"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="numbers-and-punctuation"
                  style={[
                    styles.input,
                    { backgroundColor: theme.backgroundSelected, color: theme.text },
                  ]}
                />
              </FieldRow>

              <FieldRow
                label="重复提醒间隔"
                hint={intervalError ?? '同一件物品提醒过一次后，隔多少天再提醒'}
                hintTone={intervalError ? 'danger' : 'secondary'}
                hideDivider>
                <TextInput
                  value={intervalText}
                  onChangeText={(text) => {
                    setTouched(true);
                    setIntervalText(text);
                  }}
                  accessibilityLabel="重复提醒间隔天数"
                  placeholder="3"
                  placeholderTextColor={theme.textSecondary}
                  keyboardType="number-pad"
                  style={[
                    styles.input,
                    { backgroundColor: theme.backgroundSelected, color: theme.text },
                  ]}
                />
              </FieldRow>
            </SectionCard>

            <AppButton
              label="保存"
              variant="primary"
              onPress={() => void handleSave()}
              disabled={!canSave}
              loading={saving}
              fullWidth
            />

            <SectionCard
              title="系统权限"
              description="在系统里关掉通知后，只能回系统设置重新打开"
              flush>
              <FieldRow
                label="通知权限"
                value={PERMISSION_TEXT[permission]}
                hint={
                  permission === 'denied'
                    ? 'App 无法再弹出权限框，需要去系统设置里手动打开'
                    : permission === 'undetermined'
                      ? '还没问过你，可以现在开启'
                      : '已授权，到点就会收到提醒'
                }
                hideDivider
              />
            </SectionCard>

            {permission === 'denied' ? (
              <AppButton
                label="去系统设置开启"
                onPress={() => void Linking.openSettings()}
                fullWidth
              />
            ) : null}

            {permission === 'undetermined' ? (
              <AppButton label="开启通知权限" onPress={() => void handleRequestPermission()} fullWidth />
            ) : null}
          </>
        )}

        <SectionCard
          title="数据"
          description="备份导出的是一个 json 文件，存网盘或发给自己都行"
          // 非空时才 flush： web 上内容是一个空状态卡片，它需要自己的内边距
          flush={BACKUP_TRANSFER_SUPPORTED}>
          {BACKUP_TRANSFER_SUPPORTED ? (
            <>
              <FieldRow
                label="导出备份"
                hint={backup.phase === 'exporting' ? '正在组装备份文件…' : lastBackupHint}
                disabled={backup.busy}
                onPress={() => void handleExport()}
              />
              <FieldRow
                label="导入备份"
                hint={backup.phase === 'importing' ? '正在处理…' : '将清空现有数据'}
                disabled={backup.busy}
                onPress={() => void handlePickImport()}
              />
              <FieldRow
                label="清空数据"
                hint="删除全部物品与流水，回到刚装好的状态"
                hintTone="danger"
                disabled={backup.busy}
                hideDivider
                onPress={() => void handlePressClear()}
              />
            </>
          ) : (
            <EmptyState
              compact
              icon={
                <SymbolView name={ICON_MOBILE} size={24} tintColor={theme.textSecondary} />
              }
              title="备份只支持手机端"
              description="网页版读写不了本地文件，请在 iOS / Android App 里导出或导入备份。"
            />
          )}
        </SectionCard>

        <SectionCard title="关于" flush>
          <FieldRow label="版本" value={APP_VERSION} />
          <FieldRow label="构建标识" value={BUILD_ID} />
          <FieldRow
            label="开源许可"
            hint="MIT"
            hideDivider
            onPress={() => void Linking.openURL(LICENSE_URL)}
          />
        </SectionCard>

        <View style={styles.feedback}>
          {error !== null ? (
            <ThemedText type="small" themeColor="danger">
              {error}
            </ThemedText>
          ) : null}
          {actionError !== null ? (
            <ThemedText type="small" themeColor="danger">
              通知重排失败：{actionError}
            </ThemedText>
          ) : null}
          {backup.error !== null ? (
            <ThemedText type="small" themeColor="danger">
              {backup.error}
            </ThemedText>
          ) : null}
          {successText !== null ? (
            <ThemedText type="smallBold" themeColor="text">
              {successText}
            </ThemedText>
          ) : null}
        </View>
      </ScrollView>

      {/*
        两个确认弹窗放在 ScrollView **外面**，避免被滚动容器裁剪、也不跟着页面上下滚。
        「有没有待确认的操作」各由一个 state 表达（`pendingImport` / `clearOpen`），
        而不是让弹窗自己再存一份 visible —— 两份真值迟早会对不上。
      */}
      <ConfirmDialog
        visible={pendingImport !== null}
        title="确认导入备份？"
        message={importSummaryText}
        confirmLabel="导入"
        destructive
        loading={backup.phase === 'importing'}
        onConfirm={() => void handleConfirmImport()}
        onCancel={() => setPendingImport(null)}
      />

      <ConfirmDialog
        visible={clearOpen}
        title="确认清空数据？"
        message={clearSummaryText}
        confirmLabel="清空"
        destructive
        loading={backup.phase === 'clearing'}
        onConfirm={() => void handleConfirmClear()}
        onCancel={() => {
          setClearOpen(false);
          setClearCounts(null);
        }}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    lineHeight: 20,
    minWidth: 120,
    textAlign: 'right',
  },
  feedback: {
    gap: Spacing.one,
  },
});
