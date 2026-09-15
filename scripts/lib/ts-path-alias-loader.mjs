/**
 * 让 Node 能直接 `import` 项目里的 `.ts` 源码，并解析 `@/` 路径别名。
 *
 * 为什么需要它：`src/db/**.ts` 内部用的是 `@/db/schema` 这类别名，
 * Node 原生不认识。用 module.register 挂一个 resolve hook 就够了，
 * 不需要引入 tsx / ts-node / esbuild —— 冒烟测试保持零额外依赖，
 * CI 里 `npm ci` 之后就能跑。
 *
 * 依赖的 Node 内置能力（缺一不可）：
 * - `module.register()`（>= 20.6）
 * - 默认开启的 TS 类型擦除（>= 22.18 / 23.6）—— 所以只能 import
 *   「纯类型标注」的代码，不能有 enum / namespace / 装饰器。
 *
 * 只被 `scripts/db-migrate-smoke.mjs` 使用，不参与 App 打包。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** scripts/lib/ -> scripts/ -> 项目根 */
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

/** `@/x` 依次尝试的补全后缀（不带前导点），顺序即优先级 */
const EXTENSIONS = ['ts', 'tsx', 'index.ts', 'index.tsx'];

const ALIAS_PREFIX = '@/';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(ALIAS_PREFIX)) {
    return nextResolve(specifier, context);
  }

  const base = path.join(SRC_DIR, specifier.slice(ALIAS_PREFIX.length));
  for (const extension of EXTENSIONS) {
    const candidate = `${base}.${extension}`;
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }

  throw new Error(
    `[smoke] 无法解析路径别名 ${specifier}：` +
      `尝试过 ${EXTENSIONS.map((extension) => `${base}.${extension}`).join('、')}，均不存在。`,
  );
}
