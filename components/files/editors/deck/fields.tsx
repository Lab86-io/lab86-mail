'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { slideColor } from '../deck-model';

/**
 * Small, dense controls for the slide inspector. Every control has a
 * visible label on the left and takes app tokens; slide colors pass through
 * `slideColor` so only the exportable hex subset reaches the model.
 */

export function InspectorSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn('deck-inspector-section', className)}>
      <h3 className="deck-inspector-heading">{title}</h3>
      {children}
    </section>
  );
}

export function FieldRow({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="deck-field">
      <label className="deck-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="deck-field-control">{children}</div>
      {hint ? <p className="deck-field-hint">{hint}</p> : null}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  unit,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  unit?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <div className="deck-number" data-unit={unit ? '' : undefined}>
        <input
          id={id}
          type="number"
          aria-label={label}
          className="control-field h-8 w-full px-2 text-xs"
          value={value ?? ''}
          placeholder={placeholder}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') {
              onChange(undefined);
              return;
            }
            const next = Number(raw);
            if (!Number.isFinite(next)) return;
            const low = typeof min === 'number' ? Math.max(min, next) : next;
            onChange(typeof max === 'number' ? Math.min(max, low) : low);
          }}
        />
        {unit ? <span className="deck-number-unit">{unit}</span> : null}
      </div>
    </FieldRow>
  );
}

/** Two numbers on one row, for x/y and width/height. */
export function NumberPair({
  left,
  right,
}: {
  left: Parameters<typeof NumberField>[0];
  right: Parameters<typeof NumberField>[0];
}) {
  return (
    <div className="deck-field-pair">
      <NumberField {...left} />
      <NumberField {...right} />
    </div>
  );
}

export function ColorField({
  label,
  value,
  fallback,
  onChange,
  disabled,
  clearLabel,
}: {
  label: string;
  /** The stored value; undefined means the theme decides. */
  value: string | undefined;
  /** What the slide shows when the value is unset. */
  fallback: string;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  /** When set, a control clears the value back to the theme. */
  clearLabel?: string;
}) {
  const id = useId();
  const shown = slideColor(value, slideColor(fallback, '#000000'));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commitHex = (raw: string) => {
    const normalized = raw.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) onChange(`#${normalized.toUpperCase()}`);
    else setDraft(shown);
  };
  return (
    <FieldRow label={label} htmlFor={id}>
      <div className="deck-color">
        <input
          id={id}
          type="color"
          aria-label={label}
          className="deck-color-swatch"
          value={shown}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        <input
          type="text"
          aria-label={`${label} hex`}
          className="control-field h-8 w-full px-2 font-mono text-xs uppercase"
          value={draft}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commitHex(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitHex(event.currentTarget.value);
            }
          }}
        />
        {clearLabel ? (
          <button
            type="button"
            className="deck-field-action"
            disabled={disabled || value === undefined}
            onClick={() => onChange(undefined)}
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
    </FieldRow>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <select
        id={id}
        aria-label={label}
        className="control-field h-8 w-full px-2 text-xs"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

export function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <input
        id={id}
        type="text"
        aria-label={label}
        className="control-field h-8 w-full px-2 text-xs"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldRow>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <Switch
        id={id}
        size="sm"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </FieldRow>
  );
}

/** A row of small text choices, one active. */
export function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={label}>
      <fieldset className="deck-choice">
        <legend className="sr-only">{label}</legend>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="deck-choice-item"
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    </FieldRow>
  );
}
