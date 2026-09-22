import { useCallback, useMemo, useState } from 'react';

import { formatStock } from '@/domain/units';
import { applyUnitFactor, checkUnitMatch, matchItem } from '@/services/ai/match';
import { parseUtterance } from '@/services/ai/parse';
import { itemsStore } from '@/store/items.store';
import type { AiParseResult, MatchResult, UnitCheckResult } from '@/types/ai';
import type { Item } from '@/types/models';

/**
 * AI 自然语言录入的**状态机**（第四批次）。
 *
 * 页面只负责把 `phase` 渲染成对应的 UI，所有「什么时候能确认、单位要不要换算、
 * 数量到底写多少」的判断都在这里 —— 这些是业务规则，散进组件就会在第二次改需求时漏掉。
 *
 * 关键约束（与 PRD 一致）：**任何情况下都不直接落库**。
 * `parseUtterance` 出结果 → `matchItem` 匹配 → 生成 draft → 用户确认 → 才写流水。
 *
 * 状态流转：
 * ```
 * idle ──submit(text)──> parsing ──成功──> confirm ──confirm()──> idle（写成功）
 *                            │                  └──cancel()──> idle
 *                            └──失败──> error ──> idle
 * ```
 */

/** 待确认的一张卡片：LLM 的结果 + 本地匹配结果 + 用户的选择，三者分开存 */
export interface AiDraft {
  /** 用户原话，卡片上要回显，让用户知道自己在确认什么 */
  text: string;
  /** LLM 解析结果。**用户可以在卡片上直接改它**（数量 / 价格） */
  result: AiParseResult;
  /** 本地匹配结果 */
  match: MatchResult;
  /** 用户从候选里选中的物品 id；exact 时与 `match.item.id` 相同 */
  selectedItemId: number | null;
  /** 单位检查结果；还没确定物品时为 null */
  unitCheck: UnitCheckResult | null;
  /** 必须让用户过一遍的原因（来自 parse 层） */
  reviewReasons: string[];
  /** parse 层判定的低置信度 / 数量缺失 */
  needsReview: boolean;
}

/** 用户能在卡片上改的字段。刻意只开放数量与价格 —— 物品与动作改起来等于重新输入 */
export type AiDraftPatch = Partial<Pick<AiParseResult, 'quantity' | 'price'>>;

export type AiEntryPhase =
  | { kind: 'idle' }
  /** 请求中。保留 text 是为了 loading 文案能带上原话 */
  | { kind: 'parsing'; text: string }
  | { kind: 'confirm'; draft: AiDraft }
  /** 解析失败或写库失败。message 已脱敏，可直接显示 */
  | { kind: 'error'; message: string };

export interface UseAiEntryResult {
  phase: AiEntryPhase;
  /** 写库中（确认按钮转 loading，防重复提交） */
  saving: boolean;
  /** 用户按了发送 */
  submit: (text: string) => Promise<void>;
  /** 从候选里选中某个物品；会连带重算单位检查 */
  selectItem: (itemId: number) => void;
  /** 在卡片上直接改数量 / 价格 */
  patchDraft: (patch: AiDraftPatch) => void;
  /** 确认落库。返回是否成功，失败时 phase 变成 error */
  confirm: () => Promise<boolean>;
  /** 放弃这张卡片 */
  cancel: () => void;
}

/**
 * 从匹配结果里确定「到底是哪个物品」。
 *
 * 导出给 UI 用：卡片要靠它决定「显示确认按钮还是让用户先选」。
 */
export function resolveAiItem(match: MatchResult, selectedItemId: number | null): Item | null {
  if (match.status === 'exact') return match.item;
  if (match.status === 'candidates') {
    if (selectedItemId === null) return null;
    return match.items.find((item) => item.id === selectedItemId) ?? null;
  }
  return null;
}

/**
 * 本次消耗 / 丢弃会不会把库存扣穿。**返回 null = 没问题**，否则是给用户看的原因文案。
 *
 * ## 为什么要单独算一次（数据层已经有同样的检查）
 *
 * 数据层那道是兜底，抛错时用户已经按了「确认」，反应是「怎么失败了」，
 * 而且是在卡片消失之后才知道。这里提前算一遍，卡片就能**内联警示 + 禁用确认键**，
 * 用户可以当场把数量改小 —— 冲突解决向前挪了一步。
 *
 * ## 两个刻意的选择
 *
 * - **每次渲染时算，不存进 `AiDraft`**：数量（`patchDraft`）和物品（`selectItem`）
 *   都会变，存成字段就得记得每处都要重算，漏一处就展示过期结论（「改了数量却还是不让提交」）。
 * - **只看 `item.stock` 缓存**：这一层的目的是即时反馈，卡片上别处显示的也是同一个值，
 *   两边一致才不会自相矛盾。真正的判定仍然以数据层的 `SUM(quantity)` 为准。
 */
export function resolveStockIssue(draft: AiDraft, item: Item | null): string | null {
  if (!item) return null;
  const action = draft.result.action;
  if (action !== 'consume' && action !== 'discard') return null;

  const check = draft.unitCheck ?? checkUnitMatch(draft.result.unit, item);
  const quantity = applyUnitFactor(draft.result.quantity, check);
  if (quantity === null || quantity <= 0) return null;
  if (quantity <= item.stock) return null;

  const label = action === 'consume' ? '消耗' : '丢弃';
  if (item.stock < 0) {
    return (
      `库存已经是负数：「${item.name}」当前 ${formatStock(item.stock, item.unit)}，` +
      `先盘点把它修正成 0 再记录${label}`
    );
  }
  return (
    `库存不足：「${item.name}」当前只剩 ${formatStock(item.stock, item.unit)}，` +
    `本次要${label} ${formatStock(quantity, item.unit)}`
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '写入失败，请手动录入';
}

export function useAiEntry(items: readonly Item[]): UseAiEntryResult {
  const [phase, setPhase] = useState<AiEntryPhase>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  /**
   * 喂给 LLM 的上下文。
   * 只给 name + unit（见 `AiItemContext` 的说明），且用 `useMemo` 稳住引用：
   * 物品列表不变时不该因为父组件重渲染就重新生成数组。
   */
  const context = useMemo(() => items.map((item) => ({ name: item.name, unit: item.unit })), [items]);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') return;

      setPhase({ kind: 'parsing', text: trimmed });

      const outcome = await parseUtterance({ text: trimmed, items: context });
      if (!outcome.success) {
        setPhase({ kind: 'error', message: outcome.message });
        return;
      }

      const match = matchItem(outcome.result.itemName, items);
      const resolved = resolveAiItem(match, null);
      setPhase({
        kind: 'confirm',
        draft: {
          text: trimmed,
          result: outcome.result,
          match,
          selectedItemId: resolved?.id ?? null,
          unitCheck: resolved ? checkUnitMatch(outcome.result.unit, resolved) : null,
          reviewReasons: outcome.reviewReasons,
          needsReview: outcome.needsReview,
        },
      });
    },
    [context, items],
  );

  /** 重算单位检查：换了物品就得按新物品的基础单位再判一次 */
  const withRecomputedUnit = useCallback(
    (draft: AiDraft, item: Item | null): AiDraft => ({
      ...draft,
      selectedItemId: item?.id ?? null,
      unitCheck: item ? checkUnitMatch(draft.result.unit, item) : null,
    }),
    [],
  );

  const selectItem = useCallback(
    (itemId: number) => {
      setPhase((current) => {
        if (current.kind !== 'confirm') return current;
        const draft = current.draft;
        const pool =
          draft.match.status === 'candidates'
            ? draft.match.items
            : draft.match.status === 'exact'
              ? [draft.match.item]
              : [];
        const picked = pool.find((item) => item.id === itemId) ?? null;
        return { kind: 'confirm', draft: withRecomputedUnit(draft, picked) };
      });
    },
    [withRecomputedUnit],
  );

  const patchDraft = useCallback(
    (patch: AiDraftPatch) => {
      setPhase((current) => {
        if (current.kind !== 'confirm') return current;
        const result: AiParseResult = { ...current.draft.result, ...patch };
        const draft: AiDraft = { ...current.draft, result };
        // 数量改了不影响单位检查，但物品可能已选中，保持 unitCheck 与当前物品一致即可
        const item = resolveAiItem(draft.match, draft.selectedItemId);
        return { kind: 'confirm', draft: withRecomputedUnit(draft, item) };
      });
    },
    [withRecomputedUnit],
  );

  const cancel = useCallback(() => {
    setSaving(false);
    setPhase({ kind: 'idle' });
  }, []);

  const confirm = useCallback(async () => {
    if (phase.kind !== 'confirm') return false;
    const { draft } = phase;
    const item = resolveAiItem(draft.match, draft.selectedItemId);
    const action = draft.result.action;

    // 缺任何一样都不能写：没有物品 = 不知道写给谁，没有数量 = 等于替用户编了一个数
    if (!item || draft.result.quantity === null || action === 'unknown') return false;

    const check = draft.unitCheck ?? checkUnitMatch(draft.result.unit, item);
    // 只有 converted 才换算（review 时数量不可信，换算等于把错误固化下来）
    const quantity = applyUnitFactor(draft.result.quantity, check);
    if (quantity === null) return false;

    // 写库前再判一次：卡片已经禁用确认键了，这里是「调用方绕过 UI」时的最后一道防线。
    // 静默什么都不做是最差的结局，所以把原因摆到 error 相位上给用户看。
    const stockIssue = resolveStockIssue(draft, item);
    if (stockIssue !== null) {
      setPhase({ kind: 'error', message: stockIssue });
      return false;
    }

    setSaving(true);
    try {
      await itemsStore.recordAiMovement({
        itemId: item.id,
        action,
        quantity,
        price: draft.result.price,
      });
      setPhase({ kind: 'idle' });
      return true;
    } catch (error) {
      setPhase({ kind: 'error', message: toErrorMessage(error) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [phase]);

  return { phase, saving, submit, selectItem, patchDraft, confirm, cancel };
}
