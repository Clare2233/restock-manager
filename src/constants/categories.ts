import type { ItemCategory } from '@/types/models';

/** 分类元数据 */
export interface CategoryMeta {
  key: ItemCategory;
  label: string;
}

/** 全部物品分类（顺序即展示顺序） */
export const ITEM_CATEGORIES: readonly CategoryMeta[] = [
  { key: 'cleaning', label: '清洁' },
  { key: 'paper', label: '纸品' },
  { key: 'drink', label: '饮水' },
  { key: 'personal', label: '个护' },
  { key: 'other', label: '其他' },
] as const;

/** 兜底分类 */
export const DEFAULT_CATEGORY: ItemCategory = 'other';

const CATEGORY_KEYS: ReadonlySet<string> = new Set(ITEM_CATEGORIES.map((c) => c.key));

/** 判断任意值是否是合法分类 */
export function isItemCategory(value: unknown): value is ItemCategory {
  return typeof value === 'string' && CATEGORY_KEYS.has(value);
}

/**
 * 把任意值收窄为合法分类。
 * 用于兼容早期数据、备份导入等不可信来源。
 */
export function normalizeCategory(value: unknown): ItemCategory {
  return isItemCategory(value) ? value : DEFAULT_CATEGORY;
}

/** 取分类中文名；未知分类回落到「其他」 */
export function getCategoryLabel(value: unknown): string {
  const category = normalizeCategory(value);
  return ITEM_CATEGORIES.find((c) => c.key === category)?.label ?? '其他';
}
