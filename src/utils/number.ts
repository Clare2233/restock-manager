import { QUANTITY_DECIMALS } from '@/constants/defaults';

/** 把任意值转成有限数字；非法时返回兜底值 */
export function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 四舍五入到指定小数位（用于落库前收敛浮点误差） */
export function roundTo(value: number, digits = QUANTITY_DECIMALS): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 夹到 [min, max] */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** 金额 / 数量是否为正的有限数 */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 求和 */
export function sumNumbers(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

/** 去掉小数末尾多余的 0：'1.50' → '1.5'，'2.00' → '2' */
function trimTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * 数量展示：'1.5 个' / '2 个'。
 * `unit` 为空时只返回数字。
 */
export function formatQuantity(
  value: number,
  unit?: string | null,
  digits = QUANTITY_DECIMALS,
): string {
  const text = trimTrailingZeros(toFiniteNumber(value).toFixed(digits));
  return unit ? `${text} ${unit}` : text;
}

/** 带符号数量展示：'+2 个' / '-1 个' */
export function formatSignedQuantity(
  value: number,
  unit?: string | null,
  digits = QUANTITY_DECIMALS,
): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatQuantity(value, unit, digits)}`;
}

/** 金额展示：'¥12.50'（金额固定两位小数，符合记账习惯） */
export function formatMoney(amount: number, symbol = '¥'): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${symbol}${safe.toFixed(2)}`;
}

/** 百分比展示：入参是比率（0.42 → '42%'） */
export function formatPercent(ratio: number, digits = 0): string {
  const safe = Number.isFinite(ratio) ? ratio : 0;
  return `${(safe * 100).toFixed(digits)}%`;
}
