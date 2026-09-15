import { useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { AppButton } from '@/components/common/app-button';
import { FieldRow } from '@/components/common/field-row';
import { SectionCard } from '@/components/common/section-card';
import { ThemedText } from '@/components/themed-text';
import { ITEM_CATEGORIES, normalizeCategory } from '@/constants/categories';
import { COMMON_UNITS, DEFAULT_LEAD_DAYS, DEFAULT_REMIND_DAYS } from '@/constants/defaults';
import { Spacing } from '@/constants/theme';
import { formatStock } from '@/domain/units';
import { useTheme } from '@/hooks/use-theme';
import type { CreateItemInput, Item, ItemCategory } from '@/types/models';

/**
 * 物品表单 —— 新建与编辑共用。
 *
 * ## 两种模式
 * - **新建**（`item` 不传）：多一个「当前库存」输入框，可填期初库存。
 * - **编辑**（传入 `item`）：该行改成只读展示当前库存。
 *   库存**不能在这里直接改** —— 它必须走流水（消耗 / 进货 / 盘点），
 *   否则会出现「改了数字却没留下痕迹」的脏数据（见 types/models.ts）。
 *
 * ## props
 * - `item`：编辑模式传入待编辑物品；不传 / 传 null 即新建模式。
 * - `onSubmit`：校验**通过后**回调，拿到已收敛成领域类型的 `ItemFormValues`。
 *   校验不通过时不会触发，错误直接显示在对应字段处。
 * - `onCancel`：点「取消」。不传时取消按钮置灰（而不是消失，避免按钮位置跳动）。
 * - `submitting`：提交中。两个按钮都禁用，保存按钮显示 loading 防重复提交。
 * - `submitLabel` / `cancelLabel`：覆盖按钮文案，默认「创建 / 保存」与「取消」。
 * - `style`：外层样式微调。
 *
 * ## 为什么不自己套 ScrollView
 * 表单出现在详情页 / 新建页里，那两处页面自己负责滚动与键盘避让。
 * 这里再包一层会出现嵌套滚动，也会和页面的 `keyboardShouldPersistTaps` 打架。
 *
 * ## 切换编辑对象时请用 key 强制重挂载
 * 表单是「受控 + 内部 state」，初值只在首次挂载时从 `item` 读一次。
 * 从一个物品切到另一个物品时请写 `<ItemForm key={item.id} item={item} … />`，
 * 否则会残留上一个物品的输入。这比监听 `item` 变化再手动同步简单，
 * 也顺便把「用户已经改了一半」的状态自然丢弃掉。
 *
 * ## 关于默认值
 * 提前提醒天数 / 采购缓冲天数留空时回落到 `DEFAULT_REMIND_DAYS` / `DEFAULT_LEAD_DAYS`
 * —— 与 `items.repo.ts` 的 `normalizeCreateInput` 是同一组常量，
 * 所以「用户留空」和「数据层兜底」结果一致，不会出现表单显示 3 天、入库却是别的值。
 *
 * ## 校验时机
 * 只在**点提交之后**开始显示错误，之后随输入实时更新。
 * 一上来就把每个必填项标红是最容易被讨厌的表单行为。
 */
export type ItemFormValues = Omit<CreateItemInput, 'initialStock'> & {
  /** 仅新建模式产出；编辑模式不产出（改库存必须走流水） */
  initialStock?: number;
  category: ItemCategory;
  unit: string;
  estimatedCycleDays: number | null;
  note: string | null;
};

export type ItemFormProps = {
  item?: Item | null;
  onSubmit: (values: ItemFormValues) => void;
  onCancel?: () => void;
  submitting?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** 右侧输入框的最小宽度：保证「标签 + 短值」的行里点按区域不会被压成一条 */
const INPUT_MIN_WIDTH = 120;

/** 单位快捷候选：直接复用 `COMMON_UNITS`，仍然是输入框，填自定义单位也不受限 */
const UNIT_OPTIONS: readonly { key: string; label: string }[] = COMMON_UNITS.map((unit) => ({
  key: unit,
  label: unit,
}));

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

/**
 * 空串 → `null`（表示「没填」）；合法数字 → 数值；其余 → `NaN`（表示「填错了」）。
 *
 * 为什么要区分「没填」和「填错」：数字字段留空是合法的（走默认值），
 * 写错则必须报错。用 `null` / `NaN` 两个哨兵，比一个 `undefined` 混着判断清晰。
 */
function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** 合法：没填（null），或 >= 0 的有限数（库存类字段允许小数） */
function isOptionalNonNegative(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0);
}

/** 合法：没填（null），或 >= 0 的整数（天数类字段） */
function isOptionalNonNegativeInt(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0 && Number.isInteger(value));
}

/** 合法：没填（null），或 >= 1 的整数（预计使用周期，0 天没有意义） */
function isOptionalPositiveInt(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 1 && Number.isInteger(value));
}

/** 数值输入框的初值：null 显示成空串，而不是「null」或 0 */
function toInputText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

type FormErrors = Partial<
  Record<
    | 'name'
    | 'unit'
    | 'initialStock'
    | 'safetyStock'
    | 'remindDays'
    | 'leadDays'
    | 'estimatedCycleDays',
    string
  >
>;

// ---------------------------------------------------------------------------
// 内部子组件
// ---------------------------------------------------------------------------

/**
 * 统一的输入框外观：**填充色底 + 无描边**，与模板「圆角实心块、不用 border」一致。
 *
 * 两个必须显式设置的颜色（否则深色模式下会坏掉）：
 * - `color: theme.text` —— RN 的 TextInput 默认文字色是黑色，深色底上直接看不见；
 * - `placeholderTextColor: theme.textSecondary` —— 同理，默认灰在深色底上对比度不够。
 */
function FormInput({
  value,
  onChangeText,
  accessibilityLabel,
  placeholder,
  keyboardType = 'default',
  multiline = false,
  aligned = 'right',
}: {
  value: string;
  onChangeText: (text: string) => void;
  accessibilityLabel: string;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  multiline?: boolean;
  /** 右对齐用于「标签 + 短值」的行；备注这类整块输入用左对齐 */
  aligned?: 'right' | 'left';
}) {
  const theme = useTheme();

  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      accessibilityLabel={accessibilityLabel}
      placeholder={placeholder}
      placeholderTextColor={theme.textSecondary}
      keyboardType={keyboardType}
      multiline={multiline}
      style={[
        styles.input,
        { backgroundColor: theme.backgroundSelected, color: theme.text },
        aligned === 'right' ? styles.inputRight : styles.inputBlock,
        multiline ? styles.inputMultiline : null,
      ]}
    />
  );
}

/**
 * 整块型字段：标签在上、控件占满整行，下方是提示或红色错误。
 *
 * 为什么这三处（分类 / 单位 / 备注）不用 `FieldRow`：
 * `FieldRow` 是「左标签 + 右内容」的单行布局，右侧内容区只有 `flexShrink: 1`、
 * 没有 `flexGrow`，不会撑满；而分类的标签组需要整行换行、
 * 备注的多行输入框需要整行宽度，塞进右侧会被压成很窄一条。
 * 这里的间距与分隔线刻意和 `FieldRow` 保持一致，视觉上仍是同一套行。
 */
function FormBlock({
  label,
  hint,
  error,
  hideDivider = false,
  children,
}: {
  label: string;
  hint?: string;
  /** 传了就顶掉 `hint` —— 两者共用同一行位置，只有颜色不同 */
  error?: string;
  hideDivider?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  const message = error ?? hint;

  return (
    <View style={styles.block}>
      <ThemedText>{label}</ThemedText>
      {children}
      {message ? (
        <ThemedText type="small" themeColor={error ? 'danger' : 'textSecondary'}>
          {message}
        </ThemedText>
      ) : null}
      {hideDivider ? null : (
        <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />
      )}
    </View>
  );
}

/**
 * 可点选的横向标签组（换行排列，不引 Picker 库）。
 *
 * 选中态用**反色**（`theme.text` 底 + `theme.background` 字）而不是新增强调色，
 * 与 `AppButton` 的 `primary` 完全同一套取色，两种模式下对比度都天然达标。
 */
function ChipGroup({
  options,
  selectedKey,
  onSelect,
}: {
  options: readonly { key: string; label: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  const theme = useTheme();

  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const selected = option.key === selectedKey;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onSelect(option.key)}
            style={({ pressed }) => [
              styles.chip,
              { backgroundColor: selected ? theme.text : theme.backgroundSelected },
              pressed ? styles.pressed : null,
            ]}>
            <ThemedText type="small" themeColor={selected ? 'background' : 'text'}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function ItemForm({
  item,
  onSubmit,
  onCancel,
  submitting = false,
  submitLabel,
  cancelLabel = '取消',
  style,
}: ItemFormProps) {
  const isEdit = item != null;

  const [name, setName] = useState(() => item?.name ?? '');
  const [category, setCategory] = useState<ItemCategory>(() => item?.category ?? 'other');
  const [unit, setUnit] = useState(() => item?.unit ?? '个');
  const [initialStock, setInitialStock] = useState('');
  const [safetyStock, setSafetyStock] = useState(() => toInputText(item?.safetyStock ?? 0));
  const [remindDays, setRemindDays] = useState(() =>
    toInputText(item?.remindDays ?? DEFAULT_REMIND_DAYS),
  );
  const [leadDays, setLeadDays] = useState(() =>
    toInputText(item?.leadDays ?? DEFAULT_LEAD_DAYS),
  );
  const [estimatedCycleDays, setEstimatedCycleDays] = useState(() =>
    toInputText(item?.estimatedCycleDays),
  );
  const [note, setNote] = useState(() => item?.note ?? '');
  // 只有点过提交才开始显示错误，之后随输入实时更新
  const [submitted, setSubmitted] = useState(false);

  const parsedInitialStock = parseOptionalNumber(initialStock);
  const parsedSafetyStock = parseOptionalNumber(safetyStock);
  const parsedRemindDays = parseOptionalNumber(remindDays);
  const parsedLeadDays = parseOptionalNumber(leadDays);
  const parsedCycleDays = parseOptionalNumber(estimatedCycleDays);

  const errors: FormErrors = {};
  if (!name.trim()) errors.name = '请填写物品名称';
  if (!unit.trim()) errors.unit = '请填写计量单位';
  if (!isEdit && !isOptionalNonNegative(parsedInitialStock)) {
    errors.initialStock = '请填写 0 或正数';
  }
  if (!isOptionalNonNegative(parsedSafetyStock)) errors.safetyStock = '请填写 0 或正数';
  if (!isOptionalNonNegativeInt(parsedRemindDays)) errors.remindDays = '请填写 0 或正整数天数';
  if (!isOptionalNonNegativeInt(parsedLeadDays)) errors.leadDays = '请填写 0 或正整数天数';
  if (!isOptionalPositiveInt(parsedCycleDays)) {
    errors.estimatedCycleDays = '请填写大于 0 的整数天数';
  }
  const hasErrors = Object.keys(errors).length > 0;

  /** 没点过提交就不报错 */
  const errorOf = (key: keyof FormErrors): string | undefined =>
    submitted ? errors[key] : undefined;

  /** 错误顶掉帮助文案：两者共用同一行位置，只有颜色不同 */
  const hintFor = (key: keyof FormErrors, help?: string) => {
    const error = errorOf(key);
    return {
      hint: error ?? help,
      hintTone: error ? ('danger' as const) : ('secondary' as const),
    };
  };

  const handleSubmit = () => {
    setSubmitted(true);
    if (hasErrors) return;

    onSubmit({
      name: name.trim(),
      category,
      unit: unit.trim(),
      // 编辑模式不产出 initialStock：改库存必须走流水
      ...(isEdit ? {} : { initialStock: parsedInitialStock ?? 0 }),
      safetyStock: parsedSafetyStock ?? 0,
      remindDays: parsedRemindDays ?? DEFAULT_REMIND_DAYS,
      leadDays: parsedLeadDays ?? DEFAULT_LEAD_DAYS,
      estimatedCycleDays: parsedCycleDays,
      note: note.trim() || null,
    });
  };

  return (
    <View style={[styles.container, style]}>
      <SectionCard title="基本信息">
        <FieldRow label="名称" {...hintFor('name')}>
          <FormInput
            value={name}
            onChangeText={setName}
            accessibilityLabel="物品名称"
            placeholder="例如 抽纸"
          />
        </FieldRow>

        <FormBlock label="分类" hint="目前只有这五类，选择会影响图标与分组">
          <ChipGroup
            options={ITEM_CATEGORIES}
            selectedKey={category}
            onSelect={(key) => setCategory(normalizeCategory(key))}
          />
        </FormBlock>

        <FormBlock
          label="单位"
          hint="库存与流水都按这个单位记账"
          error={errorOf('unit')}
          hideDivider>
          <FormInput
            value={unit}
            onChangeText={setUnit}
            accessibilityLabel="计量单位"
            placeholder="个"
            aligned="left"
          />
          <ChipGroup options={UNIT_OPTIONS} selectedKey={unit} onSelect={setUnit} />
        </FormBlock>
      </SectionCard>

      <SectionCard title="库存">
        {item ? (
          <FieldRow
            label="当前库存"
            value={formatStock(item.stock, item.unit)}
            hint="库存只能通过消耗 / 进货 / 盘点变更，不在这里直接改"
          />
        ) : (
          <FieldRow
            label="当前库存"
            {...hintFor('initialStock', '会记成一条「期初库存」调整流水，留空按 0 处理')}>
            <FormInput
              value={initialStock}
              onChangeText={setInitialStock}
              accessibilityLabel="当前库存"
              placeholder="0"
              keyboardType="decimal-pad"
            />
          </FieldRow>
        )}

        <FieldRow label="安全库存" {...hintFor('safetyStock', '库存降到这个数及以下就提醒')} hideDivider>
          <FormInput
            value={safetyStock}
            onChangeText={setSafetyStock}
            accessibilityLabel="安全库存"
            placeholder="0"
            keyboardType="decimal-pad"
          />
        </FieldRow>
      </SectionCard>

      <SectionCard title="提醒">
        <FieldRow
          label="提前提醒天数"
          {...hintFor('remindDays', '距离建议购买日还有几天时开始提醒')}>
          <FormInput
            value={remindDays}
            onChangeText={setRemindDays}
            accessibilityLabel="提前提醒天数"
            keyboardType="number-pad"
          />
        </FieldRow>

        <FieldRow label="采购缓冲天数" {...hintFor('leadDays', '下单到到货大概几天，预留出来')}>
          <FormInput
            value={leadDays}
            onChangeText={setLeadDays}
            accessibilityLabel="采购缓冲天数"
            keyboardType="number-pad"
          />
        </FieldRow>

        <FieldRow
          label="预计使用周期"
          {...hintFor('estimatedCycleDays', '没有消耗记录时按「库存 ÷ 本值」估算；留空则不估算')}
          hideDivider>
          <FormInput
            value={estimatedCycleDays}
            onChangeText={setEstimatedCycleDays}
            accessibilityLabel="预计使用周期"
            placeholder="留空则不估算"
            keyboardType="number-pad"
          />
        </FieldRow>
      </SectionCard>

      <SectionCard title="备注">
        <FormBlock label="备注" hint="品牌、购买渠道、使用心得…留空则不显示" hideDivider>
          <FormInput
            value={note}
            onChangeText={setNote}
            accessibilityLabel="物品备注"
            placeholder="例如：3M 抽纸，京东囤的，纸质偏厚"
            multiline
            aligned="left"
          />
        </FormBlock>
      </SectionCard>

      <View style={styles.actions}>
        <AppButton
          label={cancelLabel}
          onPress={onCancel}
          disabled={!onCancel || submitting}
          style={styles.action}
        />
        <AppButton
          label={submitLabel ?? (isEdit ? '保存' : '创建')}
          variant="primary"
          onPress={handleSubmit}
          loading={submitting}
          style={styles.action}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.three,
  },
  block: {
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    lineHeight: 20,
  },
  inputRight: {
    textAlign: 'right',
    minWidth: INPUT_MIN_WIDTH,
  },
  inputBlock: {
    width: '100%',
  },
  inputMultiline: {
    minHeight: 88,
    // Android 下多行输入默认垂直居中，显式顶对齐
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    // 高 36，与 AppButton size="small" 对齐；选中态用反色，见 ChipGroup 注释
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.five,
  },
  pressed: {
    opacity: 0.7,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  action: {
    flex: 1,
  },
});
