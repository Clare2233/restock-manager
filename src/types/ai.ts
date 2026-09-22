import type { Item, MovementType } from '@/types/models';

/**
 * 自然语言录入（AI）的类型契约。
 *
 * 这一层只描述「LLM 说了什么」，**不**描述「本地有没有这个物品」——
 * 匹配是 `services/ai/match.ts` 的事，两个关注点分开，
 * 才能在 LLM 说错的时候把「解析结果」和「匹配结果」分别呈现给用户。
 */

/**
 * 喂给 LLM 的物品上下文。
 *
 * 刻意只给 `name` + `unit`，不给库存、价格、分类：
 * - prompt 越短越便宜，也不容易被模型抓错重点；
 * - 库存是「流水求和」的缓存值（见 `types/models` 的说明），
 *   让模型看着库存去猜「还剩多少」，等于主动喂它幻觉素材。
 */
export interface AiItemContext {
  name: string;
  unit: string;
}

/** 一次解析请求 */
export interface AiParseRequest {
  /** 用户原话，不要预先清洗（标点、口语都是有用的线索） */
  text: string;
  /** 当前未归档物品列表，用于帮助模型对齐命名 */
  items: readonly AiItemContext[];
}

/**
 * 解析出的动作。
 *
 * `MovementType` 直接复用领域模型，避免「AI 一套枚举、流水一套枚举」的对账成本。
 *
 * `'unknown'` 是**显式的一等公民**：模型没看懂时必须能说出来，
 * 而不是被硬塞进 `consume` 猜一个。宁可让用户手动录，也不能悄悄写错一条流水 ——
 * 流水是库存的唯一事实来源，写错一条要用户自己去对账才发现。
 */
export type AiAction = MovementType | 'unknown';

/** LLM 解析结果。**注意：这里的每个字段都是「模型的看法」，未经本地校验 */
export interface AiParseResult {
  /**
   * 模型给出的物品名，**未做本地匹配**。
   * 可能命中、可能是别名（"手帕纸" → "纸巾"）、也可能库里根本没有。
   */
  itemName: string;
  action: AiAction;
  /**
   * 数量，恒为**正数**。
   * 符号是流水层的事：consume / discard 落库时取负（见 `RecordMovementInput`）。
   * null = 用户没说清（"买了点洗衣液"），由 UI 去问。
   */
  quantity: number | null;
  /**
   * 模型认为的单位原文（"瓶" / "袋" / "卷"）。
   * 它和物品的**基础单位**经常不是一回事，换算由后续批次处理。
   */
  unit: string | null;
  /**
   * 实付总额（元），仅 purchase 有意义。
   * 刻意不叫 `unitPrice`：用户说的是「花了 45 块」，那是总额，
   * 单价要除以数量才得到 —— 交给后面的层算，不在 LLM 输出里做除法。
   */
  price: number | null;
  /** 模型自评置信度，0..1。低于阈值时 UI 不该直接替用户确认 */
  confidence: number;
}

// ---------------------------------------------------------------------------
// 本地匹配（第三批次）
// ---------------------------------------------------------------------------

/**
 * 三态匹配结果（由 `services/ai/match.ts` 产出）。
 *
 * 刻意**不做打分排序**：家庭物品量在 10~30 件，候选不会失控；
 * 而 LLM 给的 `itemName` 天生有歧义，系统自己「取最优」会让用户在不知情的情况下
 * 接受一个错的物品。宁可多一次点击，也别悄悄选错 —— 这跟「AI 解析、人确认」是同一条原则。
 */
export type MatchResult = MatchExact | MatchCandidates | MatchNone;

/** 名字对得上（trim 全等 / 去空格全等） */
export interface MatchExact {
  status: 'exact';
  item: Item;
}

/**
 * 名字对不上但沾边（包含关系）。
 * `items` 可能只有 1 个 —— **单一模糊命中也走这一态**，
 * 这样 UI 可以统一按「候选列表」渲染，不必区分「1 个候选要不要弹选择器」。
 */
export interface MatchCandidates {
  status: 'candidates';
  /** 按传入顺序排列，**不做截断、不排序**；超过 5 个时由 UI 加搜索框 */
  items: Item[];
}

/** 库里没有，UI 负责问「要不要新建」；这一层只报状态，不触发新建 */
export interface MatchNone {
  status: 'none';
  /** 原样回传模型给的名字，供 UI 预填新建表单 */
  itemName: string;
}

/** 单位一致性检查的结论 */
export type UnitCheckStatus =
  /** 与物品基础单位一致（或模型没提单位），无需换算 */
  | 'same'
  /** 与物品的采购单位一致且 packSize > 1，已换算成基础单位 */
  | 'converted'
  /** 对不上且无法换算 —— 不能静默接受，必须让用户过一遍 */
  | 'review';

export interface UnitCheckResult {
  status: UnitCheckStatus;
  /** 模型给的单位（已 trim），null = 模型没提单位 */
  aiUnit: string | null;
  /** 物品的基础单位 */
  baseUnit: string;
  /**
   * 采购单位 → 基础单位的换算系数。
   * 仅 `status === 'converted'` 时 > 1，其余恒为 1（**此时不能拿它去乘数量**）。
   */
  factor: number;
  /** 给用户看的一句话；`same` 时为 null（没什么可解释的） */
  message: string | null;
}

/**
 * 失败原因。UI 靠它决定「退回手动录入」时该显示哪句话，
 * 所以按**用户能理解的维度**分，而不是按 HTTP 状态码分。
 */
export type AiErrorCode =
  /** 没配 Key：功能未启用，静默降级到手动录入 */
  | 'missing_key'
  /** 请求超时（默认 15s）。移动网络常见，值得明确「再试一次」 */
  | 'timeout'
  /** 断网 / DNS / TLS：fetch 直接抛了，拿不到 response */
  | 'network'
  /** 401 / 403：Key 无效或额度没了 */
  | 'auth'
  /** 其它非 2xx（含 429 限流） */
  | 'http'
  /** 2xx 但没有 content —— DeepSeek 的 JSON Output 偶尔会返回空，官方已知问题 */
  | 'empty'
  /** content 不是合法 JSON */
  | 'bad_json'
  /** JSON 合法但形状不对（比如根本没有 itemName 字段） */
  | 'bad_shape'
  /** 模型明确表示没看懂（action 为 unknown，或压根没输入内容）。不是错误，是兜底信号 */
  | 'unrecognized'
  /** 非预期异常（非 AiError）。兜底用，UI 统一按「解析失败，请手动录入」处理 */
  | 'unexpected';
