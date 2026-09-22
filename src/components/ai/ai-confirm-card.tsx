import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { formatStock } from '@/domain/units';
import { useTheme } from '@/hooks/use-theme';
import { resolveStockIssue } from '@/hooks/use-ai-entry';
import type { AiDraft, AiDraftPatch } from '@/hooks/use-ai-entry';
import type { AiAction } from '@/types/ai';
import type { Item } from '@/types/models';

/**
 * AI 解析结果的确认卡片（第四批次）。
 *
 * **这张卡片是「AI 解析、人确认」这条原则的落点**：
 * 它存在的唯一目的就是让用户在写库之前看清楚「系统理解成了什么」，
 * 所以解析依据（物品 / 动作 / 数量 / 单位）必须逐项摊开，不能只给一句「确认吗」。
 *
 * 四条呈现上的取舍：
 * - **单位不一致用黄色提示条，不阻断提交**：它不是错误，只是「按基础单位记」，
 *   阻断会让用户每次多点一次（见 `docs/ai-feature.md` 决策 6）；
 * - **库存会被扣穿用红色提示条，阻断提交**：与单位提示条正好相反。
 *   这一条描述的是「写下去就是错的」（库存 0 还要扣 1 会变成 -1），
 *   而数量本来就在卡片上改得动，用户看到警示可以当场改小再提交 ——
 *   比让它写进库失败后再弹错误有用得多；
 * - **模糊匹配一律标明「（模糊匹配）」并给「换一个」**：单一候选也不当精确命中提交，
 *   用户得知道这是猜的；
 * - **改得了的只有数量与价格**：物品和动作改起来等于重新输入，那该走取消。
 */

/** 动作文案。与 `MovementType` 一一对应，'unknown' 不会出现在这里（parse 层已挡） */
const ACTION_LABEL: Record<Exclude<AiAction, 'unknown'>, string> = {
  consume: '消耗',
  purchase: '补货',
  adjust: '盘点',
  discard: '丢弃',
};

const ICON_CHECK = { ios: 'checkmark', android: 'check', web: 'check' } as const;
const ICON_CHEVRON = { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' } as const;

/** 输入转成数字：空 → null（未填），非法 → null（填错了，确认键会被禁用） */
function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export type AiConfirmCardProps = {
  draft: AiDraft;
  /** 已确定的物品（exact 命中或用户从候选里选中）；null = 还得让用户选 */
  item: Item | null;
  /** 全部物品，「换一个」时从这里挑 */
  allItems: readonly Item[];
  /** 写库中：确认键转 loading、取消与遮罩点击暂时失效 */
  saving: boolean;
  onSelectItem: (itemId: number) => void;
  onPatch: (patch: AiDraftPatch) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 匹配不到时的「新建物品」入口，参数是模型给的名字（用于预填新建表单） */
  onCreateItem: (itemName: string) => void;
  style?: StyleProp<ViewStyle>;
};

export function AiConfirmCard({
  draft,
  item,
  allItems,
  saving,
  onSelectItem,
  onPatch,
  onConfirm,
  onCancel,
  onCreateItem,
  style,
}: AiConfirmCardProps) {
  const theme = useTheme();
  // 「换一个」的展开态与搜索词都是纯 UI 状态，不进 hook
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { result, match, unitCheck } = draft;
  const action = result.action === 'unknown' ? null : result.action;

  const candidates = match.status === 'candidates' ? match.items : [];
  // 单一模糊命中：按决策显示「匹配到：X（模糊匹配）」+ [就是这个][换一个]
  const singleFuzzy = candidates.length === 1 ? candidates[0] : null;

  const pool = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const source = pickerOpen ? allItems : candidates;
    if (keyword === '') return source;
    return source.filter((entry) => entry.name.toLowerCase().includes(keyword));
  }, [allItems, candidates, pickerOpen, search]);

  /**
   * 库存会不会被扣穿。刻意**在渲染时算**而不是存进 draft：
   * 用户改了数量（`onPatch`）或换了物品（`onSelectItem`）就必须立刻重新判定，
   * 派生值天然跟着一起变，不存在「忘了同步」这种情况。
   */
  const stockIssue = resolveStockIssue(draft, item);

  const canConfirm =
    item !== null && result.quantity !== null && stockIssue === null && !saving;

  /** 解析依据那一行：动作 + 数量 + 单位，尽量贴近用户原话 */
  const summary = [
    action ? ACTION_LABEL[action] : null,
    result.quantity !== null ? String(result.quantity) : '数量未填',
    item?.unit ?? result.unit ?? null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={saving ? undefined : onCancel}>
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={saving ? undefined : onCancel}
          accessibilityRole="button"
          accessibilityLabel="关闭确认卡片"
        />

        <ThemedView accessibilityViewIsModal style={[styles.card, style]}>
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled">
            <ThemedText type="small" themeColor="textSecondary">
              你说的是
            </ThemedText>
            <ThemedText style={styles.utterance}>「{draft.text}」</ThemedText>

            {/* 解析依据：物品名 + 动作 / 数量 / 单位，逐项摊开 */}
            <View style={[styles.summary, { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText style={styles.summaryTitle}>
                {item?.name ?? result.itemName}
              </ThemedText>
              {summary !== '' ? (
                <ThemedText type="small" themeColor="textSecondary">
                  识别到：{summary}
                </ThemedText>
              ) : null}
            </View>

            {match.status === 'exact' ? null : match.status === 'candidates' ? (
              <View style={styles.block}>
                {singleFuzzy && item === null ? (
                  <>
                    <ThemedText type="small" themeColor="warning">
                      匹配到：{singleFuzzy.name}（模糊匹配）
                    </ThemedText>
                    <View style={styles.inlineActions}>
                      <AppButton
                        label="就是这个"
                        size="small"
                        variant="primary"
                        onPress={() => onSelectItem(singleFuzzy.id)}
                      />
                      <AppButton
                        label="换一个"
                        size="small"
                        onPress={() => {
                          setPickerOpen(true);
                          setSearch('');
                        }}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <ThemedText type="small" themeColor="textSecondary">
                      {item === null
                        ? `找到 ${candidates.length} 个可能的物品，选一个`
                        : `已选：${item.name}`}
                    </ThemedText>
                    <View style={styles.candidateList}>
                      {(pickerOpen ? pool : candidates).map((entry) => {
                        const selected = entry.id === item?.id;
                        return (
                          <Pressable
                            key={entry.id}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            onPress={() => onSelectItem(entry.id)}
                            style={({ pressed }) => [
                              styles.candidate,
                              {
                                backgroundColor: selected
                                  ? theme.backgroundSelected
                                  : theme.backgroundElement,
                              },
                              pressed ? styles.pressed : null,
                            ]}>
                            <ThemedText>{entry.name}</ThemedText>
                            <ThemedText type="small" themeColor="textSecondary">
                              {entry.unit}
                            </ThemedText>
                            {selected ? (
                              <SymbolView
                                name={ICON_CHECK}
                                size={16}
                                tintColor={theme.text}
                              />
                            ) : (
                              <SymbolView
                                name={ICON_CHEVRON}
                                size={16}
                                tintColor={theme.textSecondary}
                              />
                            )}
                          </Pressable>
                        );
                      })}
                    </View>
                    {pickerOpen ? (
                      <TextInput
                        value={search}
                        onChangeText={setSearch}
                        accessibilityLabel="搜索物品"
                        placeholder="搜物品名"
                        placeholderTextColor={theme.textSecondary}
                        style={[
                          styles.input,
                          { backgroundColor: theme.backgroundSelected, color: theme.text },
                        ]}
                      />
                    ) : (
                      <AppButton
                        label="换一个"
                        size="small"
                        onPress={() => {
                          setPickerOpen(true);
                          setSearch('');
                        }}
                      />
                    )}
                  </>
                )}
              </View>
            ) : (
              <View style={styles.block}>
                <ThemedText type="small" themeColor="textSecondary">
                  没找到「{match.itemName}」，要不要新建这个物品？
                </ThemedText>
                <AppButton label="去新建" size="small" onPress={() => onCreateItem(match.itemName)} />
              </View>
            )}

            {/*
              单位提示条：review 用警示色，但**不阻断**提交 ——
              用户看一眼确认「就是按盒记」即可，不需要多点一次。
            */}
            {unitCheck?.status === 'review' && unitCheck.message !== null ? (
              <View style={[styles.notice, { backgroundColor: theme.warningSoft }]}>
                <ThemedText type="small" themeColor="warning" style={styles.noticeText}>
                  {unitCheck.message}
                </ThemedText>
              </View>
            ) : null}

            {unitCheck?.status === 'converted' && unitCheck.message !== null ? (
              <View style={[styles.notice, { backgroundColor: theme.backgroundSelected }]}>
                <ThemedText type="small" themeColor="textSecondary" style={styles.noticeText}>
                  {unitCheck.message}
                </ThemedText>
              </View>
            ) : null}

            {/*
              库存提示条：红色 + 阻断提交。文案来自 resolveStockIssue，
              里面已经带上当前库存与本次要扣的量 —— 用户看得见差多少，才知道该改成多少。
            */}
            {stockIssue !== null ? (
              <View style={[styles.notice, { backgroundColor: theme.dangerSoft }]}>
                <ThemedText type="small" themeColor="danger" style={styles.noticeText}>
                  {stockIssue}
                </ThemedText>
              </View>
            ) : null}

            {draft.reviewReasons.length > 0 ? (
              <View style={styles.block}>
                {draft.reviewReasons.map((reason) => (
                  <ThemedText key={reason} type="small" themeColor="warning">
                    {reason}
                  </ThemedText>
                ))}
              </View>
            ) : null}

            {/* 修改区：只开放数量与价格，改完立刻反映到上面的「识别到」一行 */}
            <View style={styles.block}>
              <View style={styles.field}>
                <ThemedText type="small" themeColor="textSecondary">
                  数量{action === 'adjust' ? '（盘点后的库存）' : ''}
                </ThemedText>
                <TextInput
                  value={result.quantity === null ? '' : String(result.quantity)}
                  onChangeText={(text) => onPatch({ quantity: parseNumberInput(text) })}
                  accessibilityLabel="数量"
                  keyboardType="decimal-pad"
                  placeholder="必填"
                  placeholderTextColor={theme.textSecondary}
                  style={[
                    styles.input,
                    { backgroundColor: theme.backgroundSelected, color: theme.text },
                  ]}
                />
              </View>

              {/* 要扣库存的动作才显示：让用户先知道有多少，而不是等警示条出来 */}
              {item !== null && (action === 'consume' || action === 'discard') ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {item.name} 当前库存 {formatStock(item.stock, item.unit)}
                </ThemedText>
              ) : null}

              {action === 'purchase' ? (
                <View style={styles.field}>
                  <ThemedText type="small" themeColor="textSecondary">
                    实付总额（元）
                  </ThemedText>
                  <TextInput
                    value={result.price === null ? '' : String(result.price)}
                    onChangeText={(text) => onPatch({ price: parseNumberInput(text) })}
                    accessibilityLabel="实付总额"
                    keyboardType="decimal-pad"
                    placeholder="留空则不记支出"
                    placeholderTextColor={theme.textSecondary}
                    style={[
                      styles.input,
                      { backgroundColor: theme.backgroundSelected, color: theme.text },
                    ]}
                  />
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View style={styles.actions}>
            <View style={styles.actionSlot}>
              <AppButton label="取消" onPress={onCancel} disabled={saving} fullWidth />
            </View>
            <View style={styles.actionSlot}>
              <AppButton
                label="确认"
                variant="primary"
                onPress={onConfirm}
                disabled={!canConfirm}
                loading={saving}
                fullWidth
              />
            </View>
          </View>
        </ThemedView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  card: {
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    // 底部留给系统手势区 / Home 指示条
    paddingBottom: Spacing.four,
    gap: Spacing.two,
    maxHeight: '85%',
  },
  content: {
    gap: Spacing.two,
  },
  utterance: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: 600,
  },
  summary: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
  },
  summaryTitle: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: 600,
  },
  block: {
    gap: Spacing.two,
  },
  inlineActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  candidateList: {
    gap: Spacing.one,
  },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  notice: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  noticeText: {
    flexShrink: 1,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  input: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    lineHeight: 20,
    minWidth: 120,
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  actionSlot: {
    flex: 1,
  },
  pressed: {
    opacity: 0.7,
  },
});
