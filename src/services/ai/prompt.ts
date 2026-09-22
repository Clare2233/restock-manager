import type { AiParseRequest } from '@/types/ai';

/**
 * Prompt 组装（第二批次）。
 *
 * **纯函数**：只把「用户的话 + 已登记物品」拼成消息数组，不发请求、不读 Key、不碰数据库。
 * 这样它才能被单独调试和替换 —— Prompt 是这个功能里唯一需要反复调的东西，
 * 跟网络耦合在一起就没法快速迭代了。
 *
 * 三条来自 DeepSeek 官方文档的硬约束，改动时别破坏：
 * 1. system 或 user 里**必须出现 "JSON" 这个词**，否则 `response_format: json_object` 不保证生效；
 * 2. 要给**格式示例**（few-shot），模型才知道 JSON 长什么样；
 * 3. `max_tokens` 要留够（在 deepseek.ts 里），否则 JSON 会被截断。
 */

/** 对话消息。与 DeepSeek 的 OpenAI 兼容格式一致 */
export interface AiChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * 物品上下文最多带 200 件。
 * 一个家庭的实际物品量在几十件，200 是防「误把归档物品全塞进来」的护栏：
 * 超过之后多出来的物品对消歧的帮助趋近于 0，却要实打实付 token。
 */
const MAX_CONTEXT_ITEMS = 200;

/**
 * 系统提示词。
 *
 * 措辞上刻意做的几件事：
 * - **先定角色再定任务**：「你是谁」放在第一句，模型对角色越明确，越不容易自由发挥。
 * - **「只输出 JSON」说了两遍**：一遍在开头（正向要求），一遍在结尾（收尾强调）。
 *   这是实测最容易踩的点 —— 模型偶尔会在 JSON 前后加一句「好的，解析结果如下：」。
 * - **规则编号**：模型对编号列表的遵循度明显高于散文段落。
 * - **negative case 也给了示例**：只给「该怎么做」的话，遇到看不懂的输入它会硬猜一个；
 *   明确告诉它「看不懂就给 unknown + 低分」，才拿得到可用的兜底信号。
 * - **action 枚举与 `stock_movements` 表对齐**：特意保留了 `discard`。
 *   「扔了一瓶过期牛奶」被归成 consume 会让流水语义错，将来按类型统计查不到。
 */
const SYSTEM_PROMPT = `你是「囤货管家」的家庭消耗品记录助手。
任务：把用户的一句口语记录，转换成严格 JSON 格式的结构化字段，供 App 写入库存流水。

要求：只输出一个 JSON 对象。不要输出解释、前后缀、Markdown 代码块，也不要输出任何其它文字。

输出字段（六个，缺一不可）：
- itemName: string，物品名称
- action: 只能是 "consume"、"purchase"、"adjust"、"discard" 或 "unknown"
- quantity: number 或 null，consume / purchase / discard 恒为正数，adjust 可以为 0
- unit: string 或 null
- price: number 或 null，单位元，仅 purchase 有意义
- confidence: number，0 到 1 之间的小数

判断规则：
1. 优先从下文的「已登记物品」里挑 itemName，并且**原样使用列表中的名字**（不要改字、不要加后缀）。列表里确实没有的，**就直接用用户口中的名称** —— 列表不全不代表这句话没在记录物品，**不要因为列表里没有就交白卷**。只有整句话根本不是在记录物品时才用 "unknown"（见规则 7，例如打招呼、闲聊、提问）。
2. 用了 / 消耗掉 / 开封 → consume；买了 / 囤了 / 补货 → purchase；还剩 / 盘点 / 现在有 → adjust；扔了 / 过期丢掉 / 倒掉 → discard。其中「还剩 0 / 用完了 / 现在没有了 / 一件都不剩」也是 adjust，quantity 给 0。
3. quantity 的取值：consume / purchase / discard 只给正数（符号由 App 处理，0 对这三类没有意义）；**adjust 可以是 0 或正数，0 表示「现在一件都没有」** —— 这是合法的，不要因为没有正数就退回 null。用户确实没说数量才给 null，**不要猜**。
4. unit 是用户口中的单位原文（卷 / 瓶 / 袋 / 包 / 升 / 斤 …），没提到就给 null。
5. price 只在 purchase 且用户明确说了金额时才给，是**实付总额**不是单价。
6. confidence 反映你对 itemName 和 action 的把握程度：信息越足越接近 1，信息不足就老实给低分，不要虚高。**物品不在「已登记物品」里不等于把握低**：只要话里说清了物品和动作，照样可以给高分。
7. 完全看不懂、或者这句话根本不是在记录物品（而不是「记录了但列表里没有」） → itemName 给空字符串，action 给 "unknown"，confidence 给 0.1 以下。

示例（输入 → 输出）：
今天用了一卷纸 → {"itemName":"手帕纸","action":"consume","quantity":1,"unit":"卷","price":null,"confidence":0.9}
买了3瓶洗衣液花了45块 → {"itemName":"洗衣液","action":"purchase","quantity":3,"unit":"瓶","price":45,"confidence":0.95}
猫粮还剩半袋 → {"itemName":"猫粮","action":"adjust","quantity":0.5,"unit":"袋","price":null,"confidence":0.7}
手帕纸还剩 0 包 → {"itemName":"手帕纸","action":"adjust","quantity":0,"unit":"包","price":null,"confidence":0.9}
扔了一瓶过期牛奶 → {"itemName":"牛奶","action":"discard","quantity":1,"unit":"瓶","price":null,"confidence":0.9}
猫罐头用了一个（列表里没有这个物品） → {"itemName":"猫罐头","action":"consume","quantity":1,"unit":"个","price":null,"confidence":0.85}
今天天气不错（这不是在记录物品） → {"itemName":"","action":"unknown","quantity":null,"unit":null,"price":null,"confidence":0.05}

再强调一次：只输出 JSON 对象本身，不要任何额外文字。`;

/**
 * 组装消息。
 *
 * 物品上下文放在 **user** 消息里（而不是 system）：
 * system 里的内容应该是「稳定不变的角色与规则」，物品列表每次请求都不同，
 * 混进 system 会让规则部分被可变内容挤到后面、稀释注意力。
 */
export function buildMessages(request: AiParseRequest): AiChatMessage[] {
  const catalog = formatCatalog(request.items);

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `已登记物品（名称 · 单位）：
${catalog}

用户这句话：${request.text}

请输出 JSON：`,
    },
  ];
}

/** 物品清单片段。列表为空时也要给一句话，否则模型会以为「上下文丢了」而自由发挥 */
function formatCatalog(items: readonly AiParseRequest['items'][number][]): string {
  if (items.length === 0) {
    return '（当前还没有任何已登记物品。请直接用用户口中的名称）';
  }
  return items
    .slice(0, MAX_CONTEXT_ITEMS)
    .map((item) => `- ${item.name}（${item.unit}）`)
    .join('\n');
}
