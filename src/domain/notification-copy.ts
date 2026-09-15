import type { Prediction } from '@/domain/prediction';
import type { Item } from '@/types/models';

/**
 * 通知文案 —— 纯函数。
 *
 * ## 为什么单独一个文件
 * 输入只是几个字符串和布尔，输出只是 `{ title, body }`，**不碰 expo-notifications**。
 * 于是文案可以在 Node 里直接断言（见 `scripts/notifications-smoke.mjs`），
 * 不必发一条真通知到模拟器上看它长什么样 —— 那是这批代码里最难自动验证的一环。
 *
 * ## 文案是「合并之后」的形态
 * 所有待补货物品合并成**一条**每日摘要（正文列名 + 总件数），
 * 只有 P0「已用完」单独成条、突破摘要。
 *
 * 这样定是因为家庭场景里真正同时缺的往往就是那几件，
 * 每条一件通知的话，早上会连着响一串，用户第一反应就是关掉整个渠道。
 *
 * ## 「 （估算）」标记从哪来
 * 冷启动（没有消耗流水、但用户填了「预计使用周期」）算出来的日均，
 * 预测层会置 `isEstimated = true`。它会一路带到这里的名字后缀，
 * 让用户知道这条提醒的依据是估算而不是实测。
 */

/** 摘要正文最多列几个物品名，多出来的靠「等 N 件」兜住 */
export const MAX_LISTED_NAMES = 3;

const ESTIMATED_SUFFIX = '（估算）';

/** 摘要里的一件物品（只取文案需要的字段，方便单测轻量构造） */
export interface DigestEntry {
  itemName: string;
  /** 日均是否来自冷启动估算 */
  isEstimated: boolean;
}

export interface NotificationCopy {
  title: string;
  body: string;
}

/** 一个个拿着 `Prediction` 造摘要条目；scheduler 用它把物品映射成文案输入 */
export function toDigestEntry(item: Pick<Item, 'name'>, prediction: Prediction): DigestEntry {
  return { itemName: item.name, isEstimated: prediction.isEstimated };
}

function withEstimateMark(entry: DigestEntry): string {
  const name = entry.itemName.trim();
  return entry.isEstimated ? `${name}${ESTIMATED_SUFFIX}` : name;
}

/**
 * 每日摘要文案。
 *
 * `entries` 为空返回 `null` —— 调用方据此**不排**这条通知，
 * 而不是排出一条「0 件」的空通知：没有待补货物品时，正确的通知是「没有通知」。
 *
 * 件数措辞的口径：
 * - 1 件：只用那件物品的名字做标题（`垃圾袋快用完了`），读起来就是一句提醒；
 * - 2 件：`A、B 共 2 件` —— 名字全列了，「共」是确切数量；
 * - 3 件及以上：只列前 `MAX_LISTED_NAMES` 件，用「等 N 件」说明还有更多，
 *   避免通知栏被一长串名字撑开。
 */
export function buildDailyDigestCopy(
  entries: readonly DigestEntry[],
): NotificationCopy | null {
  if (entries.length === 0) return null;

  if (entries.length === 1) {
    return {
      title: `${withEstimateMark(entries[0] as DigestEntry)}快用完了`,
      body: '记得补货',
    };
  }

  const listed = entries
    .slice(0, MAX_LISTED_NAMES)
    .map(withEstimateMark)
    .join('、');
  const quantifier = entries.length > MAX_LISTED_NAMES ? '等' : '共';

  return {
    title: '家里这些快用完了',
    body: `${listed} ${quantifier} ${entries.length} 件，记得补货`,
  };
}

/**
 * P0「已用完」文案：单独成条，不受每日摘要合并的影响，也不受冷却限制
 * （`stock <= 0` 是确定事实，见 reminder.ts）。
 */
export function buildOutOfStockCopy(itemName: string): NotificationCopy {
  return {
    title: `${itemName.trim()}已用完`,
    body: '现在是补货的最佳时机',
  };
}
