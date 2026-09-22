/**
 * AI 解析层冒烟测试 —— `npm run ai:smoke`
 *
 * ===========================================================================
 * 为什么连 Prompt 都要有测试
 * ===========================================================================
 *
 * 真机上「手帕纸还剩 0 包」卡住的那一刻，三层各错了一点：
 * 1. **Prompt** 写死了「quantity 只给正数」→ 模型不敢给 0，改给 null；
 * 2. **deepseek.ts** 用 `toPositiveNumber` 收窄 → 就算模型给了 0 也会被吞成 null；
 * 3. **parse.ts** 把 quantity === null 判成「没说清数量」→ 提示用户补一个他**已经给了**的数量。
 *
 * 这三处错在任何一层修好后都能单独通过测试，也**任何一层漏改都过不了** —— 所以要在
 * 同一个脚本里把「Prompt 说了什么」和「代码怎么收窄」钉在一起。
 *
 * ---------------------------------------------------------------------------
 * 怎么跑 / 前置条件
 * ---------------------------------------------------------------------------
 *     npm run ai:smoke
 *
 * **不发网络请求**：把 `globalThis.fetch` 换成返回固定 JSON 的假实现
 * （`deepseek.ts` 只读 `response.ok` 与 `response.json()`，够用了）。
 * 所以不需要真的 API Key，也不消耗额度 —— 测的是**我们自己的两层级收窄**，
 * 不是模型的理解力。也不用数据库。
 *
 * 与同类脚本共用 `scripts/lib/ts-path-alias-loader.mjs`，需要 Node >= 22.18。
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

// 必须先注册 hook，后面的 import('@/...') 才能解析
register('./lib/ts-path-alias-loader.mjs', import.meta.url);

// ---------------------------------------------------------------------------
// 加载被测代码（真实源码，不是副本）
// ---------------------------------------------------------------------------

const LOAD_HINT =
  '本脚本需要 Node >= 22.18（默认开启 TS 类型擦除），' + `当前版本：${process.version}`;

let parseModule;
let promptModule;
let matchModule;
try {
  parseModule = await import('@/services/ai/parse');
  promptModule = await import('@/services/ai/prompt');
  matchModule = await import('@/services/ai/match');
} catch (error) {
  console.error(`[FAIL] 无法加载被测源码。\n  ${LOAD_HINT}\n  原始错误：${error.message}`);
  process.exit(1);
}

const { parseUtterance } = parseModule;
const { buildMessages } = promptModule;
const { checkUnitMatch, matchItem } = matchModule;

/** 给 parse 层的 options：显式 Key + 超时拉高，避免脚本里走到 missing_key / timeout 分支 */
const OPTIONS = { apiKey: 'smoke-key', timeoutMs: 5_000 };

// ---------------------------------------------------------------------------
// 假的 DeepSeek
// ---------------------------------------------------------------------------

/** 指定模型这次「说」了什么 */
function stubModelReply(content) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

/** 用字符串口令推出一个 JSON 正文 —— 写用例时只想得到字段，不想手拼 JSON */
function reply(fields) {
  return JSON.stringify({
    itemName: fields.itemName ?? '手帕纸',
    action: fields.action,
    quantity: fields.quantity ?? null,
    unit: fields.unit ?? null,
    price: fields.price ?? null,
    confidence: fields.confidence ?? 0.9,
  });
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

class SmokeFailure extends Error {}

function expect(label, actual, expected) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new SmokeFailure(`断言失败：${label}\n    期望：${expectedText}\n    实际：${actualText}`);
  }
  console.log(`  [ ok ] ${label} = ${actualText}`);
}

function expectTrue(label, actual, detail) {
  if (actual !== true) {
    throw new SmokeFailure(`断言失败：${label}\n    ${detail}`);
  }
  console.log(`  [ ok ] ${label}`);
}

/** 跑一次完整解析，返回成功结果的 `result` 与 `needsReview` / `reviewReasons` */
async function parseOnce(fields) {
  stubModelReply(reply(fields));
  const outcome = await parseUtterance(
    { text: fields.text ?? '今天用了一卷纸', items: [{ name: '手帕纸', unit: '包' }] },
    OPTIONS,
  );
  if (!outcome.success) {
    throw new SmokeFailure(
      `断言失败：这一条应当解析成功，实际失败（${outcome.code}）：${outcome.message}`,
    );
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

const GROUPS = [
  {
    name: 'prompt：规则还在不在',
    describe: 'prompt.ts 一旦改回去，模型又会不敢给 0 —— 这一组是防改丢',
    async run() {
      const messages = buildMessages({ text: '手帕纸还剩 0 包', items: [{ name: '手帕纸', unit: '包' }] });
      const system = messages.find((message) => message.role === 'system').content;

      expectTrue(
        'system 里出现 JSON 这个词（response_format 生效的前提）',
        system.includes('JSON'),
        `实际没有，system 前 40 字：${system.slice(0, 40)}`,
      );
      expectTrue(
        'adjust 允许 0 已写进规则',
        system.includes('adjust 可以是 0 或正数'),
        '规则 3 里没有找到「adjust 可以是 0 或正数」',
      );
      expectTrue(
        '「还剩 0 / 用完了」归盘点已写进规则 2',
        system.includes('还剩 0'),
        '规则 2 里没有找到「还剩 0」的举例',
      );
      expectTrue(
        'few-shot 里有一条 quantity 为 0 的盘点示例',
        system.includes('"action":"adjust","quantity":0'),
        '示例里找不到 quantity:0 的 adjust',
      );

      // 第二起事故：输入「猫罐头」（列表里没有）返回了 unrecognized 而不是 none。
      // 模型把「列表里没有」理解成了「这句话没在记录物品」，于是按规则 7 交了白卷。
      // 下面三条是「别再混淆这两件事」的护栏。
      expectTrue(
        '规则 1 明确说了「列表里没有就交白卷」是错的',
        system.includes('列表里没有就交白卷'),
        '规则 1 里没有找到「列表里没有就交白卷」这句话',
      );
      expectTrue(
        'few-shot 里有一条「列表里没有」的正例',
        system.includes('"itemName":"猫罐头"'),
        '示例里找不到猫罐头（新物品）那条',
      );
      expectTrue(
        'few-shot 里有一条真·unknown 的反例（礼貌/闲聊）',
        system.includes('"action":"unknown","quantity":null'),
        '示例里找不到 unknown 的反例；正反例成对才有边界',
      );
    },
  },
  {
    name: '数量取值域：0 只对 adjust 成立',
    describe: 'bug 的正例：adjust 0 必须活下来；反例：其余动作的 0 仍然是「没说清」',
    async run() {
      const adjustZero = await parseOnce({ action: 'adjust', quantity: 0, unit: '包' });
      expect('adjust 0 → 数量保留为 0（不是 null）', adjustZero.result.quantity, 0);
      expect('adjust 0 → 不再要求用户补数量', adjustZero.needsReview, false);
      expect('adjust 0 → 没有复核原因', adjustZero.reviewReasons, []);

      const adjustHalf = await parseOnce({ action: 'adjust', quantity: 0.5 });
      expect('adjust 0.5 仍然照旧', adjustHalf.result.quantity, 0.5);

      for (const [label, fields] of [
        ['consume', { action: 'consume', quantity: 0 }],
        ['purchase', { action: 'purchase', quantity: 0 }],
        ['discard', { action: 'discard', quantity: 0 }],
        ['adjust（负数）', { action: 'adjust', quantity: -1 }],
        ['consume（负数）', { action: 'consume', quantity: -2 }],
      ]) {
        const outcome = await parseOnce(fields);
        expect(`${label} 给了非法数量 → 收窄成 null`, outcome.result.quantity, null);
        expect(`${label} → 必须让用户复核`, outcome.needsReview, true);
        expectTrue(
          `${label} → 复核原因是「没说清数量」`,
          outcome.reviewReasons.some((reason) => reason.includes('没说清数量')),
          `实际原因：${JSON.stringify(outcome.reviewReasons)}`,
        );
      }

      const consume = await parseOnce({ action: 'consume', quantity: 1, unit: '卷' });
      expect('consume 1 不受影响', consume.result.quantity, 1);
      expect('consume 1 不需要复核', consume.needsReview, false);
    },
  },
  {
    name: '问题 4：黄色单位提示条的前置条件',
    describe:
      '用户说「扔了一瓶过期牛奶」没看到黄条 —— 这里把「到底差哪一环」算清楚，' +
      '结论就可以直接拿去跟用户核对，不用在群里猜',
    async run() {
      // 种子数据的物品（src/db/seed.ts）。这里不连库，照抄一份只为验证匹配层的行为
      const SEED_ITEMS = [
        { id: 1, name: '垃圾袋', unit: '个' },
        { id: 2, name: '酒精棉片', unit: '片' },
        { id: 3, name: '酒精湿巾', unit: '片' },
        { id: 4, name: '饮用水', unit: '瓶' },
        { id: 5, name: '香皂', unit: '块' },
        { id: 6, name: '手帕纸', unit: '包' },
      ];

      // --- 问题 1：用户的物品列表里有没有「牛奶」？ ---
      const milk = matchItem('牛奶', SEED_ITEMS);
      expect('种子列表里有「牛奶」吗 → 没有，match 落到 none', milk.status, 'none');
      console.log(
        '         =============> ' +
          '结论：库里没有「牛奶」时，卡片走的是 none 分支（去新建），' +
          'unitCheck 从一开始就是 null，黄条按设计就不该出现。',
      );

      // --- 问题 2/3：假设用户自己建了「牛奶」，基础单位是「盒」 ---
      const milkBox = {
        id: 99,
        name: '牛奶',
        unit: '盒',
        packSize: 1,
        packUnit: null,
        stock: 4,
      };
      const review = checkUnitMatch('瓶', milkBox);
      expect('AI 说「瓶」+ 物品按「盒」记 → review', review.status, 'review');
      expectTrue(
        'review 带用户能看懂的文案（UI 渲染黄条的前提）',
        review.message !== null && review.message.includes('瓶'),
        `实际文案：${JSON.stringify(review.message)}`,
      );
      expect('review 时不换算数量（交给用户改）', review.factor, 1);

      expect('单位一致时是 same，不给提示', checkUnitMatch('盒', milkBox).status, 'same');
      expect(
        '模型没提单位 → 按基础单位理解，也不给提示',
        checkUnitMatch(null, milkBox).status,
        'same',
      );

      // packSize > 1 时才有 converted（种子数据 packSize = 1，所以平时走不到）
      const milkCase = { ...milkBox, packSize: 12, packUnit: '箱' };
      const converted = checkUnitMatch('箱', milkCase);
      expect('采购单位且 packSize > 1 → converted', converted.status, 'converted');
      expect('箱 → 盒 的换算系数', converted.factor, 12);

      console.log(
        '         =============> ' +
          '结论：只要物品存在且单位对不上，第 2、3 步一定产出 review + 文案，' +
          '第 4 步的 UI（ai-confirm-card.tsx:275）会把黄条渲染出来。' +
          '所以「没看到黄条」= 卡片根本没走到 review = 没有这个物品。',
      );
    },
  },
  {
    name: '数量缺失：仍然要拦',
    describe: '修 0 不能顺手把「真的没说数量」也放过去',
    async run() {
      for (const action of ['consume', 'purchase', 'adjust', 'discard']) {
        const outcome = await parseOnce({ action, quantity: null });
        expect(`${action} 没给数量 → null`, outcome.result.quantity, null);
        expect(`${action} 没给数量 → 要求复核`, outcome.needsReview, true);
      }
    },
  },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let failures = 0;

console.log('='.repeat(76));
console.log('AI 解析层冒烟测试（scripts/ai-parse-smoke.mjs）');
console.log('='.repeat(76));
console.log(`  Node              : ${process.version}`);
console.log(`  项目根目录        : ${PROJECT_ROOT}`);
console.log('  网络              : 已 stub，不发真实请求');

for (const [index, group] of GROUPS.entries()) {
  console.log('');
  console.log('-'.repeat(76));
  console.log(`分组 ${index + 1}/${GROUPS.length}：${group.name}`);
  console.log(`  ${group.describe}`);
  console.log('-'.repeat(76));

  try {
    await group.run();
    console.log('  结果：通过');
  } catch (error) {
    failures += 1;
    console.error(
      `  [FAIL] ${error instanceof SmokeFailure ? error.message : (error.stack ?? String(error))}`,
    );
  }
}

console.log('');
console.log('='.repeat(76));
console.log(failures === 0 ? `全部通过：${GROUPS.length}/${GROUPS.length}` : `失败 ${failures} 项，共 ${GROUPS.length} 项`);
console.log('='.repeat(76));

process.exitCode = failures === 0 ? 0 : 1;
