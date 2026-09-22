import { buildMessages } from '@/services/ai/prompt';
import type {
  AiAction,
  AiErrorCode,
  AiParseRequest,
  AiParseResult,
} from '@/types/ai';

/**
 * DeepSeek 调用层（第一批次：基础设施）。
 *
 * ## 这一层负责什么
 * 把「用户说的一句话」换成「一个**形状可信**的结构化对象」。
 * 就这一件事 —— 不碰数据库、不做物品匹配、不做业务降级，
 * 那些是 `prompt.ts` / `parse.ts` / `match.ts` 的事（后续批次）。
 *
 * 分工边界（后面两批次都建立在这个约定上）：
 * - **本文件**：网络 + 形状。返回的 `AiParseResult` 保证字段类型对、取值合法域对。
 * - **parse.ts**：语义 + 兜底。置信度门槛、数量/单位归一、失败时怎么退回手动录入。
 *
 * ## 为什么不用 SDK
 * 就是一次 POST，fetch 够用。不引依赖既能省包体积，
 * 也避免给这个「只有三个文件的小功能」挂一棵依赖树。
 *
 * ## 关于 API Key（写进文档的那条已知限制）
 * `EXPO_PUBLIC_` 前缀的变量会被 Metro **内联进客户端包**（Expo 官方机制），
 * 也就是任何拿到安装包的人都能把它解出来。
 * 个人项目接受这个取舍（额度小、可随时吊销），生产环境必须改成后端代理。
 */

/** DeepSeek 的 OpenAI 兼容端点。base_url 不带 /v1，路径是固定的 */
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * 模型名。
 *
 * 实测（2026-09）：请求 `deepseek-chat` 时，响应里的 `model` 字段回的是 **`deepseek-flash`** ——
 * 服务端把 `deepseek-chat` 这个别名指向了当前默认的档位，调用方式不变，
 * 但输出分布会随这次映射变化。所以这里**刻意保留成常量**：
 * 第五批次拿 10 条样本测准确率时，如果表现不稳，直接改这一个值
 * （`deepseek-reasoner` 或显式版本号）跑一次对比即可，不用动别的逻辑。
 */
export const DEFAULT_MODEL = 'deepseek-chat';

/**
 * 超时 15 秒。
 * 移动端弱网下一句中文解析通常 2~4 秒回来；给到 15 秒是留出「首次连接 + 冷启动」的余量，
 * 再长用户就已经以为卡死了 —— 与其让他等，不如明确失败并给一次重试。
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * max_tokens 给 300。
 * 目标输出是一个 6 字段的 JSON，正常不到 80 token；
 * 给太少（比如 60）会把 JSON 截在半路 —— DeepSeek 的 JSON Output 需要**合理**的上限，
 * 这是官方明确提到的失效原因之一。
 */
const DEFAULT_MAX_TOKENS = 300;

export interface AiRequestOptions {
  /** 覆盖默认超时（测试里可以调小） */
  timeoutMs?: number;
  model?: string;
  maxTokens?: number;
  /** 显式传 Key，覆盖环境变量（便于测试与将来接后端代理） */
  apiKey?: string;
}

/** 调用失败。UI 靠 `code` 决定提示文案与是否给「重试」按钮 */
export class AiError extends Error {
  readonly code: AiErrorCode;
  /** HTTP 状态码；仅 code 为 'auth' / 'http' 时有值 */
  readonly status?: number;

  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 功能是否可用（Key 有没有配）。
 *
 * 存在的意义是让**调用方先问一句**，而不是让请求打出去了再靠 catch 兜：
 * 没配 Key 属于「功能未启用」，不该弹「网络错误」去吓用户。
 */
export function isAiConfigured(): boolean {
  return readApiKey() !== null;
}

/**
 * 读 Key。
 *
 * 必须写成 `process.env.EXPO_PUBLIC_DEEPSEEK_API_KEY` 这种**静态属性访问**：
 * Expo 的 Metro 只内联这种写法，`process.env['...']` 和解构都不会被替换（官方文档明确说明）。
 */
function readApiKey(): string | null {
  const key = process.env.EXPO_PUBLIC_DEEPSEEK_API_KEY;
  const trimmed = typeof key === 'string' ? key.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * 合法动作集合。用于把模型的输出**收窄**成 `AiAction`：
 * 模型偶尔会给出 "buy"、"使用" 这类自造词，逐个去兼容是条没尽头的路，
 * 统一降级成 'unknown'，交给上层决定要不要让用户自己选。
 */
const ACTION_VALUES: readonly AiAction[] = [
  'consume',
  'purchase',
  'adjust',
  'discard',
  'unknown',
];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * 一次解析请求。
 *
 * @throws {AiError} 任何失败都以 `AiError` 抛出（不抛裸 Error），
 *   好让上层 `parse.ts` 能用 `error.code` 做降级，而不是去 match 错误文案。
 */
export async function parseWithDeepSeek(
  request: AiParseRequest,
  options: AiRequestOptions = {},
): Promise<AiParseResult> {
  const apiKey = options.apiKey?.trim() || readApiKey();
  // Key 缺失在这里就拦掉：它是「配置问题」而非「调用失败」，
  // 让上层能一眼区分「功能没开」和「这次没成功」。
  if (!apiKey) {
    throw new AiError('missing_key', '未配置 DeepSeek API Key');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * 超时用 AbortController 而不是 Promise.race：
   * race 只是让调用方不等了，底层 socket 还挂着；abort 是真的把请求掐断。
   */
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        messages: buildMessages(request),
        // 开启 JSON Output：模型被约束成只输出合法 JSON，省掉一层「从散文里抠 JSON」的脆弱逻辑
        response_format: { type: 'json_object' },
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        // 录入解析要的是稳定复现，不是文采
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    // AbortError 只说明「被掐断了」，是不是超时要看我们自己打的标记
    if (timedOut) {
      throw new AiError('timeout', `解析超时（超过 ${timeoutMs} 毫秒）`);
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AiError('network', `网络请求失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const code: AiErrorCode = response.status === 401 || response.status === 403 ? 'auth' : 'http';
    throw new AiError(code, detail, response.status);
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new AiError('bad_json', '响应不是合法 JSON');
  }

  const content = payload.choices?.[0]?.message?.content ?? '';
  /**
   * 空 content 单独成一个错误码。
   * DeepSeek 官方在 JSON Output 文档里明确写了「API 偶尔会返回空内容」，
   * 这是已知的服务端行为，不是我们解析错了 —— 分开报才能对症下药（重试/改 prompt）。
   */
  if (content.trim() === '') {
    throw new AiError('empty', '模型返回了空内容');
  }

  return toParseResult(extractJson(content));
}

/** 抽取服务端错误文案；读不出来就退化成状态码，保证 message 永不为空 */
async function readErrorDetail(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as ChatCompletionResponse;
    detail = body.error?.message ?? '';
  } catch {
    // 忽略：非 JSON 的错误响应（网关 502 之类）很常见
  }
  return detail !== '' ? detail : `HTTP ${response.status}`;
}

/**
 * 从模型输出里取出 JSON。
 *
 * 即使开了 JSON Output 也保留「剥 ```json 围栏」这一步：
 * 模型偶尔还是会把 JSON 裹在代码块里返回，剥一下的成本远低于整条录入失败。
 */
function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(source);
  } catch {
    throw new AiError('bad_json', '模型返回的内容不是合法 JSON');
  }
}

/**
 * 把 unknown 收成 `AiParseResult`：只做**类型与取值域**的收敛，不做业务判断。
 *
 * 三条刻意的宽松：
 * - `action` 认不出来 → 降级成 'unknown'，而不是抛错。拿不到动作只是「这条要用户自己选」，
 *   远好过整句录入失败；真正的兜底策略由 parse.ts 决定。
 * - `quantity` / `price` 拿不到 → null，交给 UI 去问用户（比让模型编一个数字安全得多）。
 * - `confidence` 拿不到 → 0（最保守），宁可多问一次也不自动确认。
 */
function toParseResult(raw: unknown): AiParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AiError('bad_shape', '模型返回的不是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;

  const itemName = typeof obj.itemName === 'string' ? obj.itemName.trim() : '';
  const action = ACTION_VALUES.includes(obj.action as AiAction)
    ? (obj.action as AiAction)
    : 'unknown';

  // 连物品名都没有、动作又不是 unknown —— 这份结果对用户毫无用处，
  // 属于「形状不对」，让上层当失败处理（退回手动录入）。
  if (itemName === '' && action !== 'unknown') {
    throw new AiError('bad_shape', '模型没有返回 itemName');
  }

  return {
    itemName,
    action,
    quantity: toQuantity(obj.quantity, action),
    unit: typeof obj.unit === 'string' && obj.unit.trim() !== '' ? obj.unit.trim() : null,
    price: toNonNegativeNumber(obj.price),
    confidence: toConfidence(obj.confidence),
  };
}

/**
 * 数量取值域。**为什么这里要按 action 分**：
 *
 * `adjust` 必须允许 0 —— 「手帕纸还剩 0 包」是「把库存盘成 0」的唯一说法，
 * 而 0 一旦在这一层被吞成 null，「说了 0」和「没说数量」就再也区分不开了，
 * 上层（parse.ts）即使放宽也拿不回这个信息。所以分动作的取值域必须放在**最早拿到
 * action 的这一层**，这也是「Bitmap 型 ugui vs 语义层」这条分界里唯一越界的地方，值得写清楚。
 *
 * consume / purchase / discard 必须是正数，负数任何时候都不合法；
 * 不合法一律回 null，交给 UI 去问用户，不替模型猜数。
 */
function toQuantity(value: unknown, action: AiAction): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // 'unknown' 也按正数要求：动作都没定，谈不上「盘点成 0」
  if (value === 0) return action === 'adjust' ? 0 : null;
  return value;
}

/** 金额：0 元（赠品）是合理的，负数不是 */
function toNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 置信度：夹到 0..1；非数字一律按 0 处理 */
function toConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
