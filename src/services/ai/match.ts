import { normalizePackSize, packToBase, resolvePurchaseUnitName } from '@/domain/units';
import type { Item } from '@/types/models';
import type { MatchResult, UnitCheckResult } from '@/types/ai';

/**
 * 本地物品匹配 + 单位一致性检查（第三批次）。
 *
 * 这一层回答两个问题：**模型说的物品是不是库里那个**、**它说的单位能不能直接用**。
 * 两者都只出结论，**不做落库、不弹 UI、不触发新建** —— 决定权始终在用户手上。
 *
 * 三条刻意的设计：
 * - **纯函数**：不碰数据库、不发请求，输入物品数组输出结果，好测也好调；
 * - **不做打分排序**：家庭物品量小，候选不会失控，「取最优」反而会掩盖歧义；
 * - **不做截断**：候选多不多是 UI 的呈现问题（>5 个加搜索框），不是匹配层的判断问题。
 */

/**
 * 名字归一化：去掉所有空白 + 转小写。
 *
 * 去空白是为了吃掉「手 帕 纸」这类输入（中文输入法很容易带空格）；
 * 转小写只影响 ASCII（kg / ml / L），中文不受影响 —— 数据库 LIKE 对 ASCII
 * 也是大小写不敏感的，这里保持一致。
 */
export function normalizeName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

/** trim 后全等（同样忽略 ASCII 大小写） */
function isTrimmedEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 把模型给的物品名匹配到本地物品，返回三态。
 *
 * 三级递进，**命中即停**（上一级命中就不会再往下走）：
 * 1. trim 后全等 —— 模型原样抄了列表里的名字，绝大多数情况在这一级命中；
 * 2. 去空格全等 —— 吃掉空格差异，语义上仍是「同一个名字」；
 * 3. 包含关系（双向）—— 「纸巾」 vs 「手帕纸」这类别名/简称，本质是猜，所以全部返回让人选。
 *
 * 注意第 3 级**即使只命中 1 个也返回 candidates**：它和 exact 的语义不同
 * （名字并没有真的对上），让 UI 统一按候选渲染比让它自己判断「一个候选算不算精确」更可预测。
 *
 * @param itemName 模型给的物品名（来自 `AiParseResult.itemName`）
 * @param items 候选物品池，通常是未归档物品列表；**顺序即结果的顺序**
 */
export function matchItem(itemName: string, items: readonly Item[]): MatchResult {
  const target = itemName.trim();
  const targetKey = normalizeName(target);

  // 没有名字就没有匹配对象（parse 层已挡过，这里再兜一次防止将来被别处直接调用）
  if (targetKey === '') {
    return { status: 'none', itemName: target };
  }

  // 一级：trim 后全等
  const trimmed = items.find((item) => isTrimmedEqual(item.name, target));
  if (trimmed) {
    return { status: 'exact', item: trimmed };
  }

  // 二级：去空格全等。重名物品会命中多个，那就交给用户选
  const compact = items.filter((item) => normalizeName(item.name) === targetKey);
  if (compact.length === 1) {
    return { status: 'exact', item: compact[0] };
  }
  if (compact.length > 1) {
    return { status: 'candidates', items: compact };
  }

  // 三级：包含关系（双向）。命中几个返回几个，不截断、不排序
  const fuzzy = items.filter((item) => {
    const key = normalizeName(item.name);
    if (key === '') return false;
    return key.includes(targetKey) || targetKey.includes(key);
  });
  if (fuzzy.length > 0) {
    return { status: 'candidates', items: fuzzy };
  }

  return { status: 'none', itemName: target };
}

/**
 * 单位一致性检查：模型给的单位，能不能当成物品的**基础单位**直接用。
 *
 * 为什么必须查：实测「扔了一瓶过期牛奶」，模型返回 `unit: "瓶"`，而物品「牛奶」的
 * 基础单位是「盒」—— 数量 1 瓶 ≠ 1 盒，直接落库就是一条错流水。
 *
 * 三种结论：
 * - `same`：与基础单位一致，或模型压根没提单位（那就按基础单位理解）；
 * - `converted`：与物品的**采购单位**一致且 `packSize > 1`，返回换算系数；
 * - `review`：对不上且没法换算 —— 不能静默接受，必须让用户过一遍。
 *
 * 现实约束：种子数据 `packSize = 1`、`packUnit = null`（见 `db/seed.ts`），
 * 所以目前 `converted` 基本走不到，绝大多数不一致都会落到 `review`。
 * 这正是想要的行为 —— 换算能力还没打开时，宁可让人看一眼。
 *
 * @param aiUnit 模型给的单位原文（`AiParseResult.unit`，已由 parse 层归一过）
 * @param item 目标物品（exact 命中，或用户从候选里选中的那个）
 */
export function checkUnitMatch(aiUnit: string | null, item: Item): UnitCheckResult {
  const baseUnit = item.unit;
  const ai = aiUnit?.trim() || null;

  // 模型没提单位：按基础单位理解。这不是「猜」，是唯一的合理解释
  if (ai === null) {
    return {
      status: 'same',
      aiUnit: null,
      baseUnit,
      factor: 1,
      message: null,
    };
  }

  if (normalizeName(ai) === normalizeName(baseUnit)) {
    return { status: 'same', aiUnit: ai, baseUnit, factor: 1, message: null };
  }

  const purchaseUnit = resolvePurchaseUnitName(item.packUnit, baseUnit);
  const size = normalizePackSize(item.packSize);
  if (normalizeName(ai) === normalizeName(purchaseUnit) && size > 1) {
    return {
      status: 'converted',
      aiUnit: ai,
      baseUnit,
      factor: size,
      message: `已按 1 ${purchaseUnit} = ${size} ${baseUnit} 换算`,
    };
  }

  return {
    status: 'review',
    aiUnit: ai,
    baseUnit,
    factor: 1,
    message: `单位对不上：说的是「${ai}」，这个物品按「${baseUnit}」记`,
  };
}

/**
 * 按 `checkUnitMatch` 的结论换算数量（采购单位 → 基础单位）。
 *
 * **只有 `converted` 才真的乘**：`review` 时数量不可信，换算等于把错误固化下来，
 * 那种情况该做的是让人改，不是算得更精确。
 */
export function applyUnitFactor(
  quantity: number | null,
  check: UnitCheckResult,
): number | null {
  if (quantity === null) return null;
  if (check.status !== 'converted') return quantity;
  return packToBase(quantity, check.factor);
}
