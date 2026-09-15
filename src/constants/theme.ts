/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
    /**
     * 危险操作（删除 / 清空）。
     * 模板原配色只有中性色，而「删除物品」这类不可逆操作必须有明确的视觉区分，
     * 因此在这里补齐 token —— 而不是在组件里硬编码 hex，
     * 那样会同时丢掉深色模式适配、并在后续组件里被复制粘贴。
     */
    danger: '#C42B35',
    /** 危险色块上的文字色（保证两种模式下都满足对比度） */
    onDanger: '#ffffff',
    /** 危险色的淡底：用于「告急」这类需要提醒、但还没到实心红程度的标签 */
    dangerSoft: '#FBE9EA',
    /** 警示色（库存偏低 / 该补货了），语义弱于 danger */
    warning: '#A85F00',
    /** 警示色的淡底 */
    warningSoft: '#FBEFDF',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
    danger: '#D93843',
    onDanger: '#ffffff',
    dangerSoft: '#3A1F21',
    warning: '#E8A54B',
    warningSoft: '#3A2C18',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
