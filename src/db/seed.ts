import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_APP_SETTINGS } from '@/constants/defaults';
import { createItemCore } from '@/db/repositories/items.repo';
import { writeAppSettingsCore } from '@/db/repositories/settings.repo';
import type { ItemCategory } from '@/types/models';

/**
 * 首批物品种子数据。
 *
 * 只在 `PRAGMA user_version` 从 0 升到 1 时写入一次（见 migrations.ts），
 * 之后用户怎么改都不会被覆盖。
 *
 * 几点取舍：
 * - `initialStock` 一律为 0：App 刚装上时你并不知道家里还剩多少，
 *   让用户第一次打开时自己盘点，比预填一个假数字更不容易误导预测。
 * - `packSize` 一律为 1（即采购单位 = 基础单位）：大包换算暂且关闭，
 *   等明确「1 提 = N 瓶」这类习惯后再逐个打开，避免预置错误换算比。
 * - `safetyStock` 是「低于这个数就该买」的兜底线，也是新物品在
 *   日均数据不足（< 7 天）时**唯一**能触发提醒的条件，所以必须给合适的值。
 */
interface SeedItemDefinition {
  name: string;
  category: ItemCategory;
  unit: string;
  safetyStock: number;
  quickConsumeQty: number;
  remindDays: number;
  leadDays: number;
}

const SEED_ITEMS: readonly SeedItemDefinition[] = [
  {
    name: '垃圾袋',
    category: 'cleaning',
    unit: '个',
    safetyStock: 10,
    quickConsumeQty: 1,
    remindDays: 5,
    leadDays: 2,
  },
  {
    name: '酒精棉片',
    category: 'cleaning',
    unit: '片',
    safetyStock: 20,
    quickConsumeQty: 5,
    remindDays: 7,
    leadDays: 3,
  },
  {
    name: '酒精湿巾',
    category: 'cleaning',
    unit: '片',
    safetyStock: 10,
    quickConsumeQty: 1,
    remindDays: 7,
    leadDays: 3,
  },
  {
    name: '饮用水',
    category: 'drink',
    unit: '瓶',
    safetyStock: 6,
    quickConsumeQty: 1,
    remindDays: 5,
    leadDays: 2,
  },
  {
    name: '香皂',
    category: 'personal',
    unit: '块',
    safetyStock: 1,
    quickConsumeQty: 1,
    remindDays: 14,
    leadDays: 3,
  },
  {
    name: '手帕纸',
    category: 'paper',
    unit: '包',
    safetyStock: 3,
    quickConsumeQty: 1,
    remindDays: 7,
    leadDays: 3,
  },
];

/**
 * 写入初始数据。**不开事务**：调用方（migrations.ts）已经在一个事务里。
 * 重复调用是安全的 —— settings 用 upsert，物品则会被再插一遍，
 * 因此只在版本升级路径上调用一次。
 */
export async function seedInitialData(db: SQLiteDatabase): Promise<void> {
  let sortOrder = 10;
  for (const seed of SEED_ITEMS) {
    await createItemCore(db, {
      name: seed.name,
      category: seed.category,
      unit: seed.unit,
      packSize: 1,
      packUnit: null,
      initialStock: 0,
      safetyStock: seed.safetyStock,
      quickConsumeQty: seed.quickConsumeQty,
      remindDays: seed.remindDays,
      leadDays: seed.leadDays,
      sortOrder,
    });
    sortOrder += 10;
  }

  await writeAppSettingsCore(db, { ...DEFAULT_APP_SETTINGS });
}
