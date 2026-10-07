'use client';

// One form question (docs/albatross-thread.md, "Questions are forms"). The
// chat's `ask_form` and the runner's `needs_answer` handoff both render it.
// Typed fields per kind; bound fields fill from the saved personal details and
// show where the value came from; the recommended option is selected first;
// "Save … to my details" appears when a bound value is new or different.
// Answered, it collapses to a receipt with label and value rows.

import { type ReactNode, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { checkFormAnswer } from '@/lib/albatross/form-question';
import {
  type AddressValue,
  type ContactValue,
  type FormAnswer,
  type FormField,
  type FormFieldValue,
  type FormQuestion,
  type NameValue,
  type PersonalDetailView,
} from '@/lib/albatross/thread-contract';
import {
  FORM_COPY,
  fieldsToSave,
  formReceiptRows,
  type PrefilledField,
  prefillForm,
  saveBoxLabel,
} from '@/lib/albatross/thread-view';
import { cn } from '@/lib/utils';

export interface FormReceipt {
  /** The answered values, or null when only the answer text is known. */
  values: Record<string, FormFieldValue> | null;
  /** Rows to show when `values` is null (an answer the run recorded as text). */
  rows?: Array<{ id: string; label: string; value: string }>;
  /** "Answered 10:44", "Answered in the chat.", "Skipped", "No longer open". */
  stateLine: string;
  /** The labels of the details the answer saved: "Phone". */
  savedLabels?: string[];
  /** The receipt still offers Undo for the save. */
  onUndoSave?: () => void | Promise<void>;
  undone?: boolean;
}

export interface FormQuestionCardProps {
  form: FormQuestion;
  /** The saved personal details, for the bound fields. */
  details?: readonly PersonalDetailView[];
  /** A chat question offers Skip; a runner question has one button only (decision 3). */
  mode: 'chat' | 'runner';
  receipt?: FormReceipt | null;
  busy?: boolean;
  /** Field errors from the server, by field id. */
  errors?: Record<string, string> | null;
  onSubmit: (answer: FormAnswer) => void;
  onSkip?: () => void;
  className?: string;
}

const inputClass = 'h-8 text-[12.5px]';

export function FormQuestionCard(props: FormQuestionCardProps) {
  if (props.receipt)
    return <FormReceiptCard form={props.form} receipt={props.receipt} className={props.className} />;
  return <FormQuestionForm {...props} />;
}

function FormQuestionForm({
  form,
  details = [],
  mode,
  busy,
  errors: serverErrors,
  onSubmit,
  onSkip,
  className,
}: FormQuestionCardProps) {
  const initial = useMemo(() => prefillForm(form, details), [form, details]);
  const [values, setValues] = useState<Record<string, FormFieldValue>>(initial.values);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [save, setSave] = useState(true);
  const baseId = useId();
  const errors = { ...localErrors, ...(serverErrors ?? {}) };
  const toSave = fieldsToSave(form, values, initial.prefilled);
  const setValue = (field: FormField, value: FormFieldValue | undefined) => {
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[field.id];
      else next[field.id] = value;
      return next;
    });
    setLocalErrors((current) => {
      if (!current[field.id]) return current;
      const next = { ...current };
      delete next[field.id];
      return next;
    });
  };

  const submit = () => {
    const checked = checkFormAnswer(form, values);
    if (!checked.ok) {
      setLocalErrors(checked.errors);
      const first = form.fields.find((field) => checked.errors[field.id]);
      if (first) document.getElementById(`${baseId}-${first.id}`)?.focus();
      return;
    }
    onSubmit({ values: checked.values, save: toSave.length > 0 && save });
  };

  return (
    <section
      data-slot="form-question"
      data-form-mode={mode}
      aria-busy={busy || undefined}
      className={cn(
        'surface-card rounded-card flex w-full min-w-0 flex-col gap-3.5 px-4 py-3.5 text-[var(--color-text)]',
        className,
      )}
    >
      <header>
        <h3 className="text-[13.5px] font-semibold leading-snug">{form.title}</h3>
        {form.detail ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{form.detail}</p>
        ) : null}
      </header>
      <div className="flex flex-col gap-3">
        {form.fields.map((field) => {
          const prefilled = initial.prefilled[field.id];
          const compact = prefilled?.saved && !open[field.id] && !errors[field.id];
          return (
            <FieldBlock
              key={field.id}
              id={`${baseId}-${field.id}`}
              field={field}
              value={values[field.id]}
              prefilled={prefilled}
              compact={Boolean(compact)}
              error={errors[field.id]}
              disabled={busy}
              onChange={(value) => setValue(field, value)}
              onOpen={() => setOpen((current) => ({ ...current, [field.id]: true }))}
            />
          );
        })}
      </div>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--color-list-divider)] pt-3">
        {toSave.length ? (
          <span className="mr-auto flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
            <Checkbox
              id={`${baseId}-save`}
              checked={save}
              onCheckedChange={(next) => setSave(next === true)}
              disabled={busy}
            />
            <label htmlFor={`${baseId}-save`}>{saveBoxLabel(toSave)}</label>
          </span>
        ) : (
          <span className="mr-auto" />
        )}
        {mode === 'chat' && onSkip ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onSkip}>
            {FORM_COPY.skip}
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={busy} onClick={submit}>
          {busy ? 'Saving…' : form.submitLabel?.trim() || FORM_COPY.submit}
        </Button>
      </footer>
    </section>
  );
}

function FieldBlock({
  id,
  field,
  value,
  prefilled,
  compact,
  error,
  disabled,
  onChange,
  onOpen,
}: {
  id: string;
  field: FormField;
  value: FormFieldValue | undefined;
  prefilled?: PrefilledField;
  compact: boolean;
  error?: string;
  disabled?: boolean;
  onChange: (value: FormFieldValue | undefined) => void;
  onOpen: () => void;
}) {
  if (field.kind === 'choice') {
    return (
      <fieldset className="min-w-0" aria-describedby={error ? `${id}-error` : undefined}>
        <legend className="mb-1.5 text-[12px] text-[var(--color-text-muted)]">{field.label}</legend>
        <ChoiceOptions id={id} field={field} value={value} disabled={disabled} onChange={onChange} />
        {field.help ? (
          <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">{field.help}</p>
        ) : null}
        <FieldError id={id} error={error} />
      </fieldset>
    );
  }
  if (compact && prefilled) {
    return (
      <div className="grid grid-cols-[108px_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-[var(--color-list-divider)] pb-2">
        <span className="text-[12px] text-[var(--color-text-muted)]">{field.label}</span>
        <span className="min-w-0">
          <span className="block truncate text-[13px]">{displayValue(field, value)}</span>
          <span className="block text-[11.5px] text-[var(--color-text-faint)]">{prefilled.source}</span>
        </span>
        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
          className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          {FORM_COPY.change}
        </button>
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-x-3 gap-y-1 sm:grid-cols-[108px_minmax(0,1fr)]">
      <label htmlFor={id} className="pt-1.5 text-[12px] text-[var(--color-text-muted)]">
        {field.label}
      </label>
      <div className="min-w-0">
        <FormFieldInput
          id={id}
          field={field}
          value={value}
          disabled={disabled}
          error={error}
          onChange={onChange}
        />
        {prefilled && !prefilled.saved ? (
          <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">{prefilled.source}</p>
        ) : field.help ? (
          <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">{field.help}</p>
        ) : null}
        <FieldError id={id} error={error} />
      </div>
    </div>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={`${id}-error`} role="alert" className="mt-1 text-[11.5px] text-[var(--color-danger)]">
      {error}
    </p>
  );
}

function displayValue(field: FormField, value: FormFieldValue | undefined): string {
  return (
    formReceiptRows({ title: '', fields: [field] }, value === undefined ? {} : { [field.id]: value })[0]
      ?.value ?? '—'
  );
}

function ChoiceOptions({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: FormField;
  value: FormFieldValue | undefined;
  disabled?: boolean;
  onChange: (value: FormFieldValue | undefined) => void;
}) {
  const choice = (value as { choices?: string[]; other?: string } | undefined) ?? {};
  const chosen = new Set(choice.choices ?? []);
  const other = choice.other ?? '';
  const emit = (choices: string[], nextOther: string) =>
    onChange(
      choices.length || nextOther ? { choices, ...(nextOther ? { other: nextOther } : {}) } : undefined,
    );
  const toggle = (optionId: string) => {
    if (field.multiple) {
      const next = new Set(chosen);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      emit([...next], other);
    } else emit([optionId], other);
  };
  return (
    <div
      role={field.multiple ? 'group' : 'radiogroup'}
      className="flex flex-col overflow-hidden rounded-ui border border-[var(--color-border)]"
    >
      {(field.options ?? []).map((option, index) => {
        const selected = chosen.has(option.id);
        const shared = {
          type: 'button' as const,
          id: index === 0 ? id : undefined,
          disabled,
          'data-option-state': selected ? 'selected' : 'idle',
          onClick: () => toggle(option.id),
          className: cn(
            'grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-[var(--color-list-divider)] px-3 py-2 text-left transition-colors first:border-t-0',
            selected ? 'bg-[var(--color-hover-soft)]' : 'hover:bg-[var(--color-hover-soft)]/60',
          ),
        };
        const body = (
          <>
            <span
              aria-hidden
              className={cn(
                'mt-[3px] size-4 shrink-0 rounded-full border bg-[var(--color-bg-elevated)]',
                selected
                  ? 'border-[5px] border-[var(--color-accent)]'
                  : 'border-[1.5px] border-[var(--color-control-border)]',
                field.multiple && 'rounded-[4px]',
              )}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium leading-snug">{option.label}</span>
              {option.detail ? (
                <span className="block text-[12px] text-[var(--color-text-muted)]">{option.detail}</span>
              ) : null}
              {option.calendar ? (
                <span
                  data-calendar-fit={option.calendar.fit}
                  className={cn(
                    'block text-[12px]',
                    option.calendar.fit === 'free'
                      ? 'text-[var(--color-success)]'
                      : 'text-[var(--color-warning)]',
                  )}
                >
                  {option.calendar.note}
                </span>
              ) : null}
            </span>
            {option.recommended ? (
              <span className="mt-[1px] inline-flex h-[18px] items-center whitespace-nowrap rounded-ui bg-[var(--color-accent-3-soft)] px-1.5 text-[11px] font-medium text-[var(--color-accent-3)]">
                {option.recommended}
              </span>
            ) : (
              <span />
            )}
          </>
        );
        return field.multiple ? (
          <button key={option.id} {...shared} role="checkbox" aria-checked={selected}>
            {body}
          </button>
        ) : (
          <button key={option.id} {...shared} role="radio" aria-checked={selected}>
            {body}
          </button>
        );
      })}
      {field.allowOther ? (
        <div className="flex items-center gap-2 border-t border-[var(--color-list-divider)] px-3 py-2">
          <span className="text-[12px] text-[var(--color-text-muted)]">{FORM_COPY.other}</span>
          <Input
            aria-label={`${field.label}: other`}
            value={other}
            disabled={disabled}
            placeholder={field.placeholder}
            onChange={(event) => emit(field.multiple ? [...chosen] : [], event.target.value)}
            className={cn(inputClass, 'flex-1')}
          />
        </div>
      ) : null}
    </div>
  );
}

export function FormFieldInput({
  id,
  field,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string;
  field: FormField;
  value: FormFieldValue | undefined;
  disabled?: boolean;
  error?: string;
  onChange: (value: FormFieldValue | undefined) => void;
}) {
  const invalid = error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
  const text = typeof value === 'string' ? value : '';
  const setText = (next: string) => onChange(next === '' ? undefined : next);
  switch (field.kind) {
    case 'name': {
      const name = (value as Partial<NameValue> | undefined) ?? {};
      const set = (patch: Partial<NameValue>) =>
        onChange(cleanObject({ ...name, ...patch }) as FormFieldValue | undefined);
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input
            id={id}
            aria-label="First name"
            placeholder="First name"
            value={name.first ?? ''}
            disabled={disabled}
            onChange={(e) => set({ first: e.target.value })}
            className={inputClass}
            {...invalid}
          />
          <Input
            aria-label="Last name"
            placeholder="Last name"
            value={name.last ?? ''}
            disabled={disabled}
            onChange={(e) => set({ last: e.target.value })}
            className={inputClass}
          />
        </div>
      );
    }
    case 'address': {
      const address = (value as Partial<AddressValue> | undefined) ?? {};
      const set = (patch: Partial<AddressValue>) =>
        onChange(cleanObject({ country: 'US', ...address, ...patch }) as FormFieldValue | undefined);
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input
            id={id}
            aria-label="Street"
            placeholder="Street"
            value={address.line1 ?? ''}
            disabled={disabled}
            onChange={(e) => set({ line1: e.target.value })}
            className={cn(inputClass, 'col-span-2')}
            {...invalid}
          />
          <Input
            aria-label="Apartment or unit"
            placeholder="Apartment or unit"
            value={address.line2 ?? ''}
            disabled={disabled}
            onChange={(e) => set({ line2: e.target.value })}
            className={cn(inputClass, 'col-span-2')}
          />
          <Input
            aria-label="City"
            placeholder="City"
            value={address.city ?? ''}
            disabled={disabled}
            onChange={(e) => set({ city: e.target.value })}
            className={inputClass}
          />
          <Input
            aria-label="State or region"
            placeholder="State"
            value={address.region ?? ''}
            disabled={disabled}
            onChange={(e) => set({ region: e.target.value })}
            className={inputClass}
          />
          <Input
            aria-label="Postal code"
            placeholder="Postal code"
            value={address.postalCode ?? ''}
            disabled={disabled}
            onChange={(e) => set({ postalCode: e.target.value })}
            className={inputClass}
          />
          <Input
            aria-label="Country"
            placeholder="Country (US)"
            value={address.country ?? 'US'}
            disabled={disabled}
            maxLength={2}
            onChange={(e) => set({ country: e.target.value.toUpperCase() })}
            className={inputClass}
          />
        </div>
      );
    }
    case 'contact': {
      const contact = (value as Partial<ContactValue> | undefined) ?? {};
      const set = (patch: Partial<ContactValue>) =>
        onChange(cleanObject({ ...contact, ...patch }) as FormFieldValue | undefined);
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input
            id={id}
            aria-label="Name"
            placeholder="Name"
            value={contact.name ?? ''}
            disabled={disabled}
            onChange={(e) => set({ name: e.target.value })}
            className={inputClass}
            {...invalid}
          />
          <Input
            aria-label="Phone"
            placeholder="Phone"
            type="tel"
            value={contact.phone ?? ''}
            disabled={disabled}
            onChange={(e) => set({ phone: e.target.value })}
            className={inputClass}
          />
          <Input
            aria-label="Relationship"
            placeholder="Relationship"
            value={contact.relationship ?? ''}
            disabled={disabled}
            onChange={(e) => set({ relationship: e.target.value })}
            className={cn(inputClass, 'col-span-2')}
          />
        </div>
      );
    }
    case 'date':
      return (
        <Input
          id={id}
          type="date"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className={cn(inputClass, 'max-w-[200px]')}
          {...invalid}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          placeholder={field.placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className={cn(inputClass, 'max-w-[200px]')}
          {...invalid}
        />
      );
    case 'phone':
      return (
        <Input
          id={id}
          type="tel"
          autoComplete="tel"
          placeholder={field.placeholder ?? '(555) 555-0100'}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className={cn(inputClass, 'max-w-[260px]')}
          {...invalid}
        />
      );
    case 'email':
      return (
        <Input
          id={id}
          type="email"
          autoComplete="email"
          placeholder={field.placeholder ?? 'name@example.com'}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className={inputClass}
          {...invalid}
        />
      );
    default:
      return (
        <Input
          id={id}
          type="text"
          placeholder={field.placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className={inputClass}
          {...invalid}
        />
      );
  }
}

/** Drop empty strings; undefined when nothing is left. */
function cleanObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' ? entry.trim() : entry !== undefined && entry !== null) out[key] = entry;
  }
  return Object.keys(out).filter((key) => key !== 'country').length ? out : undefined;
}

// ---------------------------------------------------------------------------
// The receipt.
// ---------------------------------------------------------------------------

export function FormReceiptCard({
  form,
  receipt,
  className,
  children,
}: {
  form: FormQuestion;
  receipt: FormReceipt;
  className?: string;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(Boolean(receipt.undone));
  const rows = receipt.values ? formReceiptRows(form, receipt.values) : (receipt.rows ?? []);
  return (
    <section
      data-slot="form-receipt"
      className={cn(
        'surface-card rounded-card flex w-full min-w-0 flex-col gap-1.5 px-4 py-3 text-[var(--color-text)]',
        className,
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2.5">
        <h3 className="text-[13px] font-semibold">{form.title}</h3>
        <span data-slot="form-receipt-state" className="text-[12px] text-[var(--color-text-muted)]">
          {receipt.stateLine}
        </span>
      </header>
      {rows.length ? (
        <dl className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-[108px_minmax(0,1fr)] gap-x-3 text-[12.5px]">
              <dt className="text-[var(--color-text-muted)]">{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {receipt.savedLabels?.length ? (
        <div
          data-slot="details-saved"
          className="mt-1 flex flex-wrap items-baseline gap-x-2.5 border-t border-[var(--color-list-divider)] pt-2 text-[12px] text-[var(--color-text-muted)]"
        >
          <span className={cn(undone && 'line-through')}>
            {FORM_COPY.saved} {receipt.savedLabels.join(', ')}
          </span>
          {receipt.onUndoSave && !undone ? (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await receipt.onUndoSave?.();
                  setUndone(true);
                } finally {
                  setBusy(false);
                }
              }}
              className="text-[12px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50"
            >
              {busy ? 'Undoing…' : FORM_COPY.undo}
            </button>
          ) : undone ? (
            <span className="text-[var(--color-accent-3)]">Undone</span>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Undo the newest chat save of these personal details. */
export async function undoPersonalDetails(keys: readonly string[]): Promise<void> {
  for (const key of keys.slice(0, 12)) {
    const response = await fetch('/api/personal-details', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'undo', key }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw new Error(body?.error || 'The save was not undone.');
  }
}
