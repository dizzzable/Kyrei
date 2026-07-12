import { Input, SegmentedControl, Switch, type SegmentOption } from "@/components/ui";

/** A labeled settings row: title/description on the left, control on the right. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  stacked,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? "space-y-1.5 py-2.5" : "flex flex-col items-stretch gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-foreground">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p>}
      </div>
      <div className={stacked ? "" : "shrink-0 self-start sm:self-auto"}>{children}</div>
    </div>
  );
}

export function BoolField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Switch checked={value} onCheckedChange={onChange} aria-label={label} />
    </Field>
  );
}

export function EnumField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <SegmentedControl value={value} options={options} onChange={onChange} size="sm" />
    </Field>
  );
}

export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-1 w-40 cursor-pointer accent-(--color-primary)"
          aria-label={label}
        />
        <span className="w-12 text-right text-[12px] tabular-nums text-secondary">
          {format ? format(value) : value}
        </span>
      </div>
    </Field>
  );
}

export function TextField({
  label,
  hint,
  value,
  type = "text",
  placeholder,
  onChange,
  trailing,
}: {
  label: string;
  hint?: string;
  value: string;
  type?: string;
  placeholder?: string;
  onChange: (v: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <Field label={label} hint={hint} stacked>
      <div className="flex gap-2">
        <Input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1"
        />
        {trailing}
      </div>
    </Field>
  );
}
