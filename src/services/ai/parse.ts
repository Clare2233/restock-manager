import { AiError, parseWithDeepSeek, type AiRequestOptions } from '@/services/ai/deepseek';
import type { AiAction, AiErrorCode, AiParseRequest, AiParseResult } from '@/types/ai';

/**
 * 解析编排 + 语义兜底（第二批次）。
 *
 * 这一层是「LLM 说的话」和「App 敢用的数据」之间的闸门：
 * - `deepseek.ts` 保证**形状对**（字段类型、取值域合法）；
 * - **本文件**保证**语义可用**（这条结果能不能拿去生成确认卡片）。
 *
 * 三条刻意的分工：
 * - **不碰 UI**：只返回结构化结果，不吐文案（文案是页面的事）；
 * - **不做物品匹配**：`itemName` 原样往下传，匹配是 `match.ts`（第三批次）的事；
 * - **不直接 fetch**：网络全在 `deepseek.ts`，这里只管编排与降级。
 *
 * 返回值**统一是 outcome 对象，不抛异常**：解析失败是这个功能的正常分支，
 * 「网络挂了」和「没听懂」都要走「退回手动录入」，用异常表达会逼着每个调用点写 try/catch。
 */

/**
 * 置信度阈值：低于它就不能自动确认，必须让用户过一遍。
 *
 * ## 第五批次实测（10 条典型输入，`deepseek-chat`）
 *
 * 8 条拿到了卡片，2 条直接 unrecognized。分布是**双峰、中间是空的**：
 *
 * | 档位 | 样本 | 区间 | 均值 |
 * | --- | --- | --- | --- |
 * | 信息足够 | 6 | 0.85 ~ 0.95 | 0.908 |
 * | 缺关键信息 | 2 | 0.5 ~ 0.8 | 0.650 |
 *
 * 也就是说 0.6 / 0.7 / 0.8 这三个值在这批样本上**判定完全一样**（中间的 0.5~0.85 是无人区），
 * 只有降到 0.5 才会漏掉「好像用了一些纸」这条。**保留 0.6**：它在这个安全区里最宽松的一头，
 * 既不冤枉用户，也不是拍脑袋的孤值了。
 *
 * 顺带一个结论：**挡住模糊输入的其实主要是「数量缺失」而不是这条阈值** ——
 * 两条例本里的模糊样本都被 `collectReviewReasons` 的 quantity === null 抓住了，
 * 置信度阈值只补到了其中一条。两条防线各管各的，别指望单靠阈值。
 *
 * 样本只有 10 条（n=8 有分），**够证伪「0.6 明显不合适」，不够支撑精细调参**；
 * 真要再动这个数，先把样本扩到 30 条以上重跑一遍。
 */
export const CONFIDENCE_THRESHOLD = 0.6;

export interface ParseUtteranceOptions extends AiRequestOptions {
  /** 覆盖置信度阈值，仅供测试与调参；生产用 `CONFIDENCE_THRESHOLD` */
  confidenceThreshold?: number;
}

/** 解析成功。注意：**成功只代表「能生成卡片」，不代表可以直接落库** */
export interface AiParseSuccess {
  success: true;
  /** 归一化后的解析结果（单位已归一，字段已校验） */
  result: AiParseResult;
  /**
   * true = 这张卡片必须由用户自己过一遍，UI 不能给「一键确认」的默认焦点。
   * 触发条件见 `collectReviewReasons`。
   */
  needsReview: boolean;
  /** 需要复核的原因，UI 可原样展示（例如「没说清数量，请补一个」） */
  reviewReasons: string[];
}

/**
 * 解析失败。
 *
 * `fallbackToManual` 恒为 true 且**故意冗余地写死在类型里**：
 * 它在提醒调用方 —— 失败时唯一正确的动作就是退回手动录入，
 * 不存在「失败但也渲染个卡片」的中间态。
 */
export interface AiParseFailure {
  success: false;
  fallbackToManual: true;
  /** 失败原因，UI 靠它选提示文案与是否给「重试」 */
  code: AiErrorCode;
  /** 给用户看的一句话（已脱敏，不含 Key、不含原始响应） */
  message: string;
}

export type AiParseOutcome = AiParseSuccess | AiParseFailure;

/**
 * 解析用户的一句话。
 *
 * 输入：`AiParseRequest`（用户原话 + 已登记物品的名称/单位）
 * 输出：`AiParseOutcome` —— 成功带 `result` + 是否需要复核，失败带 `code` + 提示文案
 *
 * 永远不抛异常：`missing_key` / `timeout` / `network` / `empty` 等都被翻译成
 * `AiParseFailure`，调用方（第四批次的 UI）只需要一个 `if (!outcome.success)`。
 */
export async function parseUtterance(
  request: AiParseRequest,
  options: ParseUtteranceOptions = {},
): Promise<AiParseOutcome> {
  const threshold = options.confidenceThreshold ?? CONFIDENCE_THRESHOLD;

  // 空输入不发请求：省一次调用，也避免模型对着空白自由发挥出一个「未知物品」
  if (request.text.trim() === '') {
    return failure('unrecognized', '还没输入内容');
  }

  try {
    const parsed = await parseWithDeepSeek(request, options);
    return validate(parsed, threshold);
  } catch (cause) {
    if (cause instanceof AiError) {
      return failure(cause.code, toUserMessage(cause));
    }
    // 非 AiError：属于代码 bug 或运行环境异常，不能把原始堆栈当文案给用户看
    return failure('unexpected', '解析出错，请手动录入');
  }
}

/**
 * 语义校验 + 归一化。
 *
 * 与 `deepseek.ts` 的形状校验**故意重复了一遍**：形状校验保证「类型系统成立」，
 * 这里保证「业务上可用」，两者的失败含义不同（前者是响应坏了，后者是这条不能落库）。
 * 重复的成本是几行，省掉的成本是某一层改动时悄悄漏掉一条约束。
 */
function validate(parsed: AiParseResult, threshold: number): AiParseOutcome {
  // 1. action 在枚举范围内。'unknown' 不是错误，是模型主动交白卷。
  //
  // **必须排在 itemName 检查之前**：模型「看不懂」时是 itemName 空 + action=unknown
  // 一起返回的（规则 7 就是这么要求的）。若先查 itemName，这类输入会全部撞上
  // bad_shape，'unrecognized' 永远不可达，UI 也就拿不到「没看懂」这个准确的文案。
  if (parsed.action === 'unknown') {
    return failure('unrecognized', '没看懂这句话记的是哪个物品');
  }

  // 2. itemName 非空 —— 没有物品名就没有落库对象，卡片也无从生成
  if (parsed.itemName === '') {
    return failure('bad_shape', '没识别出物品名');
  }

  // 3. quantity 的取值域。**0 对 adjust 是合法的**（deepseek 层已放过，这里再挡一次）
  if (parsed.quantity !== null && !isQuantityAllowed(parsed.quantity, parsed.action)) {
    return failure('bad_shape', '数量不是正数');
  }

  // 4. confidence 必须在 0~1；NaN 也算非法（Number.isFinite 已被 deepseek 层挡过）
  if (!(parsed.confidence >= 0 && parsed.confidence <= 1)) {
    return failure('bad_shape', '置信度取值异常');
  }

  const result: AiParseResult = {
    ...parsed,
    unit: normalizeUnit(parsed.unit),
  };

  const reviewReasons = collectReviewReasons(result, threshold);

  return {
    success: true,
    result,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}

/**
 * 这个数量在这个动作下是否合法。
 *
 * **`adjust` 允许 0**：「手帕纸还剩 0 包」是把库存盘成 0 的唯一说法。
 * 禁掉 0，用户就没办法用 AI 把已经写错的负库存修回来 —— 真机第一步就是卡死在这里的。
 * 其余动作必须是正数（消耗 0 件等于什么都没发生），负数任何时候都不合法。
 */
function isQuantityAllowed(quantity: number, action: AiAction): boolean {
  if (quantity < 0) return false;
  if (quantity === 0) return action === 'adjust';
  return true;
}

/**
 * 哪些情况必须让用户复核。
 *
 * 判定标准只有一条：**凡是模型「没说清」而我们要替用户做决定的地方，都要问**。
 * 宁可多点一次确认，也不能让一条错流水进库 —— 库存是流水求和出来的，
 * 写错一条，用户要自己翻历史对账才能发现。
 */
function collectReviewReasons(result: AiParseResult, threshold: number): string[] {
  const reasons: string[] = [];

  if (result.confidence < threshold) {
    reasons.push(`识别把握不高（${result.confidence.toFixed(2)}），请确认`);
  }
  // 数量缺失是最常见也最危险的一种：模型给个默认值等于替用户编了一次消耗。
  //
  // **但 0 不算缺失**：adjust + quantity 0 是「明确盘成 0」，模型在数量上没有留白，
  // 这时还让用户「补一个数量」是在逼他改自己已经说过的话。
  // （早年 quantity 0 在这里被当成 null，表现就是「盘点 0 被拦住，提示数量未填」。）
  if (result.quantity === null) {
    reasons.push('没说清数量，请补一个');
  }

  return reasons;
}

/**
 * 单位归一：把模型给的单位原文收敛成和物品基础单位可比的写法。
 *
 * 只做**保守归一** —— 去掉空白、统一大小写、查同义词表。刻意不做激进的规则
 * （比如砍掉任意后缀）：「卷纸」能归一成「卷」，但「抽纸」砍成「抽」就有风险，
 * 所以同义词表是**显式列举**的，看得到、改得动、不会误伤。
 *
 * 归一**不等于换算**：「瓶」和「升」之间的换算依赖物品的 packSize，
 * 那是第三批次 `match.ts` 拿到物品之后的事，这里不做（也没法做）。
 */
export function normalizeUnit(unit: string | null): string | null {
  if (unit === null) return null;
  const compact = unit.replace(/\s+/g, '').trim();
  if (compact === '') return null;
  return UNIT_SYNONYMS[compact.toLowerCase()] ?? compact;
}

/**
 * 同义词表：口语/包装说法 → 物品表单里常见的单位。
 * 需要新增时直接往里加，别改成模糊匹配规则。
 */
const UNIT_SYNONYMS: Record<string, string> = {
  卷纸: '卷',
  抽纸: '抽',
  提纸: '提',
  瓶装: '瓶',
  袋装: '袋',
  盒装: '盒',
  罐装: '罐',
  箱装: '箱',
  包装: '包',
  公斤: '千克',
  kg: '千克',
  g: '克',
  克重: '克',
  ml: '毫升',
  毫升数: '毫升',
  l: '升',
};

/** 构造失败结果。收在一处，避免每处都手写字面量导致 code 与 message 对不上 */
function failure(code: AiErrorCode, message: string): AiParseFailure {
  return { success: false, fallbackToManual: true, code, message };
}

/**
 * 把 `AiError` 翻成用户能看懂的一句话。
 *
 * 只按 `code` 分档，**不拼接原始 message**（里面可能有 URL、响应片段），
 * 调试信息该进日志而不是给用户看。
 */
function toUserMessage(error: AiError): string {
  switch (error.code) {
    case 'missing_key':
      return 'AI 录入未启用，请手动录入';
    case 'timeout':
      return '识别超时，请重试或手动录入';
    case 'network':
      return '网络不可用，请手动录入';
    case 'auth':
      return 'AI 服务鉴权失败，请手动录入';
    case 'http':
      return 'AI 服务暂时不可用，请手动录入';
    case 'empty':
    case 'bad_json':
    case 'bad_shape':
      return '没看懂这句话，请手动录入';
    default:
      return '解析失败，请手动录入';
  }
}
