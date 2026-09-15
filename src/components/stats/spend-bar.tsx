import { StyleSheet, View } from 'react-native';

import { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { clampNumber } from '@/utils/number';

/**
 * 占比条（纯 View 实现，不引图表库）。
 *
 * 一条灰底轨道 + 一段彩色填充，填充宽度是 `ratio × 100%`。
 * 刻意做成**单条**：一个组件负责「画一条比例」，创建 bar chart / 分类明细列表
 * 都由若干个它拼出来，组件本身不需要知道自己在哪个容器里。
 *
 * 两个边界：
 * - `ratio` 夹到 [0, 1]。金额分摊时浮点误差可能给出 1.0000000002，
 *   直接喂给百分比宽度会让 RN 报 invalid flex/percentage 样式。
 * - 金额为 0 的分类仍保留 1 的视觉宽度（`MIN_VISIBLE_RATIO`）：
 *   完全空心的条看起来像没加载出来，而不是「这一项真的是 0」。
 */
export type SpendBarProps = {
  /** 占比（0~1） */
  ratio: number;
  /** 填充色 token；不传用主文字色，保证黑白模式下也有对比度 */
  color?: ThemeColor;
  /** 轨道与填充的高度 */
  height?: number;
  /** 圆角；传 0 得到直角（柱子用） */
  radius?: number;
};

const MIN_VISIBLE_RATIO = 0.02;

export function SpendBar({ ratio, color = 'text', height = 8, radius = 4 }: SpendBarProps) {
  const theme = useTheme();
  const safeRatio = clampNumber(Number.isFinite(ratio) ? ratio : 0, 0, 1);
  const width = safeRatio <= 0 ? MIN_VISIBLE_RATIO : Math.max(safeRatio, MIN_VISIBLE_RATIO);

  return (
    <View
      style={[styles.track, { height, borderRadius: radius, backgroundColor: theme.backgroundSelected }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`占比 ${Math.round(safeRatio * 100)}%`}>
      <View
        style={[
          styles.fill,
          { width: `${width * 100}%`, borderRadius: radius, backgroundColor: theme[color] },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
  },
});
