import { formatQuantity, roundTo, toFiniteNumber } from '@/utils/number';

/**
 * 计量单位与「大包换算」的纯函数。
 *
 * 背景：库存与流水永远用**基础单位**（片/个/瓶）记账；
 * 采购时人习惯说「买了一提」「买了两包」，两者之间用 `packSize` 换算。
 * 目前种子数据 `packSize = 1`（即不换算），字段已就位，用到时再打开。
 *
 * 注意所有函数都做了「坏输入兜底」：packSize <= 1 或非数字一律当作 1，
 * 保证换算永远不会产生除零、负数或 NaN。
 */

/** 把 packSize 收敛到 >= 1；非法值当 1 处理 */
export function normalizePackSize(packSize?: number | null): number {
  const value = toFiniteNumber(packSize, 1);
  return value >= 1 ? value : 1;
}

/** 采购单位数量 → 基础单位数量（2 提 × 12 瓶 = 24 瓶） */
export function packToBase(packs: number, packSize?: number | null): number {
  return roundTo(toFiniteNumber(packs) * normalizePackSize(packSize));
}

/** 基础单位数量 → 采购单位数量（24 瓶 ÷ 12 = 2 提），保留 3 位小数 */
export function baseToPack(quantityInBase: number, packSize?: number | null): number {
  return roundTo(toFiniteNumber(quantityInBase) / normalizePackSize(packSize), 3);
}

/**
 * 把基础单位的数量**向上取整到整包**（买 13 瓶而 1 提 = 12 瓶 → 返回 24 瓶）。
 * 数量 <= 0 时返回一个采购单位，保证「建议买」至少是能买到的量。
 */
export function ceilToPack(quantityInBase: number, packSize?: number | null): number {
  const size = normalizePackSize(packSize);
  const value = toFiniteNumber(quantityInBase);
  if (value <= 0) return size;
  // 先收紧到 6 位小数，避免 12.0000000001 / 12 被向上取整成 2 包
  const packs = Math.ceil(roundTo(value / size, 6));
  return roundTo(packs * size);
}

/** 采购单位名；未设置时回落为基础单位名 */
export function resolvePurchaseUnitName(
  packUnit: string | null | undefined,
  baseUnit: string,
): string {
  const trimmed = packUnit?.trim();
  return trimmed ? trimmed : baseUnit;
}

/** 换算说明文案：'1 提 = 12 瓶'；不涉及换算时返回 null */
export function describePackaging(
  packSize: number | null | undefined,
  packUnit: string | null | undefined,
  baseUnit: string,
): string | null {
  const name = packUnit?.trim();
  const size = normalizePackSize(packSize);
  if (!name || size <= 1) return null;
  return `1 ${name} = ${formatQuantity(size, baseUnit)}`;
}

/** 基础单位数量展示：'24 瓶' */
export function formatBaseQuantity(
  value: number,
  unit: string,
  digits?: number,
): string {
  return formatQuantity(value, unit, digits);
}

/**
 * 采购视角的数量展示：'2 提（24 瓶）'；不涉及换算时退化为 '24 瓶'。
 */
export function formatPackQuantity(
  quantityInBase: number,
  packSize: number | null | undefined,
  packUnit: string | null | undefined,
  baseUnit: string,
): string {
  const size = normalizePackSize(packSize);
  const name = packUnit?.trim();
  const baseText = formatQuantity(quantityInBase, baseUnit);
  if (!name || size <= 1) return baseText;
  const packs = baseToPack(quantityInBase, size);
  return `${formatQuantity(packs, name)}（${baseText}）`;
}

/** 库存展示：数量优先取整（库存 12.0 显示 '12 个'，12.5 显示 '12.5 个'） */
export function formatStock(stock: number, unit: string): string {
  const value = toFiniteNumber(stock);
  const isWhole = Math.abs(value - Math.round(value)) < 1e-9;
  return formatQuantity(value, unit, isWhole ? 0 : 2);
}
