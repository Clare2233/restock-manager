import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AppButton } from '@/components/common/app-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BUILD_ID } from '@/constants/defaults';
import { Spacing } from '@/constants/theme';
import { DatabaseStartupError, getReadyDatabase, type DbDiagnostics } from '@/db/client';
import { useNotificationResponder } from '@/hooks/use-notification-responder';
import { useNotificationScheduler } from '@/hooks/use-notification-scheduler';
import { configureNotificationHandler, rescheduleAll } from '@/notifications/scheduler';

// 先拦住开屏图的自动隐藏：等启动引导把数据库准备好（或明确失败）之后再放行，
// 中途不会露出白屏。真正调用 hideAsync() 的是下面的 AnimatedSplashOverlay。
SplashScreen.preventAutoHideAsync();

/**
 * 通知的接线全部收在下面的 `NotificationBridge` 里。
 *
 * 它们**必须等数据库 ready 之后**才挂：`rescheduleAll` 要读库算计划，
 * 而模块顶层在 DB 引导完成之前就执行了 —— 那时 `getReadyDatabase()` 还没兑现。
 * 所以这里用一个只渲染在 ready 子树里的空组件承载三个 hook，
 * 而不是在 `RootLayout` 里直接调用（那会无条件执行，也绕不开 hook 规则）。
 */

type BootState = 'pending' | 'ready' | 'failed';

/** 启动失败时要在错误页上展示的东西 */
interface BootFailureInfo {
  message: string;
  /** 数据库引导失败时的现场；其他原因的失败为 null */
  diagnostics: DbDiagnostics | null;
}

/**
 * 根布局。
 *
 * ## 为什么自己写启动引导，而不是用 `SQLiteProvider`
 * `SQLiteProvider` 把「打开数据库」和「渲染子树」绑死，出错时只能抛给
 * ErrorBoundary，很难给用户一个可读、可重试的界面。
 * 这里用 `useEffect` + `getReadyDatabase()` 显式控制三个状态
 * （pending / ready / failed），失败时给的是带「重试」的错误页而不是白屏或崩溃。
 *
 * ## 为什么开屏图要等到引导结束才收
 * 见下方 `AnimatedSplashOverlay` 处的注释 —— 顺序错了会出现「卡在启动屏」。
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [bootState, setBootState] = useState<BootState>('pending');
  const [bootFailure, setBootFailure] = useState<BootFailureInfo | null>(null);
  /** 重试计数：每次自增就重新跑一遍初始化 */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 初始化是异步的，而用户可能中途点「重试」。
    // 用 cancelled 保证「上一次的结果」晚到时不会把新状态覆盖回去。
    let cancelled = false;
    setBootState('pending');
    setBootFailure(null);

    getReadyDatabase().then(
      () => {
        if (!cancelled) setBootState('ready');
      },
      (error: unknown) => {
        if (cancelled) return;
        // DatabaseStartupError 额外带着数据库现场（user_version / 列名 / 步骤），
        // 错误页会把整块渲染出来 —— 真机排查时截一张图就够了。
        setBootFailure({
          message: error instanceof Error && error.message ? error.message : String(error),
          diagnostics: error instanceof DatabaseStartupError ? error.diagnostics : null,
        });
        setBootState('failed');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  let content: ReactNode;
  if (bootState === 'ready') {
    content = (
      <Stack>
        {/* (tabs) 组自带底部标签栏，Stack 再叠一层头部就重复了 */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="shopping" options={{ title: '购物清单' }} />
        <Stack.Screen name="item/new" options={{ title: '新建物品' }} />
        {/* 详情页会在页面里用物品名覆盖这里的通用标题 */}
        <Stack.Screen name="item/[id]/index" options={{ title: '物品详情' }} />
        <Stack.Screen name="item/[id]/edit" options={{ title: '编辑物品' }} />
        {/* 消耗 / 补货是轻量表单，用 modal 形态弹出，与主浏览流区分 */}
        <Stack.Screen name="item/[id]/consume" options={{ title: '记录消耗', presentation: 'modal' }} />
        <Stack.Screen name="item/[id]/purchase" options={{ title: '补货入库', presentation: 'modal' }} />
      </Stack>
    );
  } else if (bootState === 'failed') {
    content = (
      <BootFailure
        failure={bootFailure ?? { message: '未知错误', diagnostics: null }}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  } else {
    content = <BootPending />;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {content}
      {bootState === 'ready' ? <NotificationBridge /> : null}
      {/*
        开屏遮罩只在「已经有内容可显示」之后才挂载。
        它是整个应用里唯一调用 SplashScreen.hideAsync() 的地方，所以：
        - 初始化期间不挂 → 原生启动屏继续盖着，用户看到的是开屏图而不是白屏；
        - 失败时也挂 → 否则开屏图永远不隐藏，错误页会被永久挡在后面，
          用户看到的是「卡在启动屏」，比看到错误提示糟糕得多。
      */}
      {bootState === 'pending' ? null : <AnimatedSplashOverlay />}
    </ThemeProvider>
  );
}

/**
 * 通知桥接：把通知模块接到 App 生命周期上。
 *
 * 三件事，全部只在 ready 子树里发生（见上面 `content` 处的说明）：
 *
 * 1. 注册「收到通知时怎么展示」的 handler —— 只注册一次，
 *    不注册的话 expo-notifications 默认**不展示**，通知会「响了却看不见」；
 * 2. 启动后立刻重排一次 —— 通知由系统带外触发，昨天排了什么、
 *    响过没有，只有重排的时候才对得上账（补计入账 + 按今天重算）；
 * 3. 挂上「切回前台重排」与「点通知跳转」两个 hook。
 *
 * 重排失败只 warn 不抛：它是旁路功能，失败时 App 该照常用，
 * 只是通知可能还是旧的；但也不能静默 —— 否则「没提醒我」这类反馈无从查起。
 */
function NotificationBridge() {
  useNotificationScheduler();
  useNotificationResponder();

  useEffect(() => {
    configureNotificationHandler();
    void getReadyDatabase()
      .then((db) => rescheduleAll(db))
      .catch((error: unknown) => {
        console.warn(
          '[notifications] 启动重排失败：',
          error instanceof Error ? error.message : String(error),
        );
      });
  }, []);

  return null;
}

/** 初始化进行中。正常情况下它被原生启动屏盖着，这是兜底（比如 Web 端）。 */
function BootPending() {
  return (
    <ThemedView style={styles.centered}>
      <ActivityIndicator />
      <ThemedText type="small" themeColor="textSecondary">
        正在准备本地数据…
      </ThemedText>
    </ThemedView>
  );
}

/**
 * 初始化失败页。
 *
 * 必须把原始错误和数据库现场都显示出来 —— 只说「出错了」，用户既无法自助，
 * 也没法在反馈时提供有效信息。真机排查时这张截图就够了，所以：
 * - `BUILD_ID` 放最顶部：一眼确认手机上跑的是哪一版 JS（排除「包没更新」）；
 * - 大段等宽文本放进 `ScrollView`，再长也能滚到底，不要截断。
 */
function BootFailure({ failure, onRetry }: { failure: BootFailureInfo; onRetry: () => void }) {
  return (
    <ThemedView style={styles.failureRoot}>
      <ScrollView style={styles.failureScroll} contentContainerStyle={styles.failureScrollContent}>
        <ThemedText type="code" style={styles.buildId}>
          BUILD_ID: {BUILD_ID}
        </ThemedText>
        <ThemedText type="smallBold">本地数据打不开</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.failureText}>
          数据库没能初始化，应用读不到库存数据。重试通常可以解决；若一直失败，请重启应用。
        </ThemedText>
        <ThemedText type="code" themeColor="textSecondary" style={styles.diagnosticBlock}>
          {failure.message}
        </ThemedText>
        <ThemedText type="code" themeColor="textSecondary" style={styles.diagnosticBlock}>
          {formatDiagnostics(failure.diagnostics)}
        </ThemedText>
      </ScrollView>
      <ThemedView style={styles.failureActions}>
        <AppButton label="重试" variant="primary" onPress={onRetry} />
      </ThemedView>
    </ThemedView>
  );
}

/** 把诊断对象铺成等宽文本块（可直接截图反馈） */
function formatDiagnostics(diagnostics: DbDiagnostics | null): string {
  if (!diagnostics) {
    return '未采集到数据库诊断信息（失败发生在数据库引导之外）。';
  }

  const columns = diagnostics.itemColumns;
  const lines = [
    `库文件: ${diagnostics.databaseName}`,
    `user_version: ${diagnostics.userVersion ?? '读取失败'}`,
    `items 列(${columns?.length ?? 0}):`,
    columns && columns.length > 0 ? columns.join(', ') : '读取失败 / items 表不存在',
    `缺失列: ${
      diagnostics.missingColumns.length > 0 ? diagnostics.missingColumns.join(', ') : '无'
    }`,
    `删库重建: ${diagnostics.rebuilt ? '已执行' : '未执行'}`,
  ];

  if (diagnostics.steps.length > 0) {
    lines.push('', '步骤:', ...diagnostics.steps.map((step) => `- ${step}`));
  }

  return lines.join('\n');
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.five,
  },
  failureRoot: {
    flex: 1,
  },
  failureScroll: {
    flex: 1,
  },
  failureScrollContent: {
    gap: Spacing.two,
    padding: Spacing.five,
  },
  buildId: {
    // 顶部居中：截图第一眼就能确认手机上跑的是哪一版代码
    textAlign: 'center',
  },
  failureActions: {
    alignItems: 'center',
    padding: Spacing.five,
  },
  failureText: {
    textAlign: 'center',
  },
  diagnosticBlock: {
    // 左对齐 + 等宽（type="code"）；不加 numberOfLines，诊断必须完整
    alignSelf: 'stretch',
  },
});
