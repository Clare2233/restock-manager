import { Tabs } from 'expo-router/js-tabs';
import { SymbolView } from 'expo-symbols';

import { useTheme } from '@/hooks/use-theme';

/**
 * 底部标签栏。
 *
 * ## 为什么用 `expo-router/js-tabs` 而不是别的那几个
 * `expo-router` 下并存三套标签栏实现，选型理由：
 * - `expo-router/js-tabs`：react-navigation 的 JS 版底部标签栏，**三端行为一致**，
 *   图标可以用任意 React 节点（这里用 `SymbolView`）。← 选它
 * - `expo-router/unstable-native-tabs`：真正的原生标签栏，观感最好，
 *   但名字里的 unstable 是实情，且图标只吃图片资源，做不了矢量符号。
 * - `expo-router/ui`：无样式原语，Web 上那套顶部胶囊导航就是它做的，
 *   要在手机上还原成底部栏还得自己写一堆布局，得不偿失。
 *
 * ## 图标为什么写成 { ios, android, web } 对象
 * `SymbolView` 传**字符串**时只在 iOS 渲染，Android / Web 会静默留白。
 * 传对象才会在各平台各取所需（iOS 用 SF Symbols，其余用 Material Symbols）。
 *
 * 页面自己处理标题和安全区（`headerShown: false`），避免和标签栏叠出两层头部。
 */
const TABS = [
  { name: 'index', title: '首页', icon: { ios: 'house.fill', android: 'home', web: 'home' } },
  {
    name: 'inventory',
    title: '库存',
    icon: { ios: 'shippingbox.fill', android: 'inventory_2', web: 'inventory_2' },
  },
  {
    name: 'stats',
    title: '统计',
    icon: { ios: 'chart.bar.fill', android: 'bar_chart', web: 'bar_chart' },
  },
  {
    name: 'settings',
    title: '设置',
    icon: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
  },
] as const;

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // 主题里没有强调色（只有中性色加 danger / warning 两族），
        // 所以选中态靠「最强前景色 vs 次级色」的明度差区分，而不是靠色相
        tabBarActiveTintColor: theme.text,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.background,
          borderTopColor: theme.backgroundSelected,
        },
      }}>
      {TABS.map(({ name, title, icon }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ color }) => <SymbolView name={icon} size={24} tintColor={color} />,
          }}
        />
      ))}
    </Tabs>
  );
}
