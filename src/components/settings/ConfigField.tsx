import { Input, SegmentedControl, Switch, type SegmentOption } from "@/components/ui";
import { cn } from "@/lib/utils";

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
    <div className={cn("py-2.5", stacked && "space-y-1.5")}>
      <div className={cn(!stacked && "@container")}>
        <div
          className={cn(
            !stacked && "grid gap-2 @2xl:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] @2xl:items-center @2xl:gap-4",
          )}
        >
          <div className="min-w-0">
            <label htmlFor={htmlFor} className="block text-[13px] font-medium text-foreground">
              {label}
            </label>
            {hint && <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p>}
          </div>
          <div className={cn(stacked ? "" : "min-w-0 self-start @2xl:justify-self-end @2xl:self-auto")}>{children}</div>
        </div>
      </div>
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
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <SegmentedControl value={value} options={options} onChange={onChange} size="sm" disabled={disabled} />
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
      <div className="@container">
        <div className="flex flex-col gap-2 @lg:flex-row">
        <Input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1"
        />
        {trailing}
        </div>
      </div>
    </Field>
  );
}
