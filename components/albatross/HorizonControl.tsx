'use client';

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  HORIZON_KINDS,
  type HorizonKind,
  horizonLine,
  parseHorizonHint,
  type WorkHorizon,
} from '@/lib/albatross/horizon';
import { cn } from '@/lib/utils';

const SEGMENT_LABEL: Record<HorizonKind, string> = {
  now: 'Now',
  later: 'Later',
  someday: 'Someday',
};

export const HORIZON_PLACEHOLDER = 'in two weeks, after the wedding, not before November';
export const HORIZON_SAVE_ERROR = 'Could not save the horizon. Try again.';

export interface HorizonDraft {
  horizon: WorkHorizon | null;
  /** The character range of the parsed phrase inside the text, for the underline. */
  phrase: [number, number] | null;
}

/** Parse the field text and find the phrase the parser used. */
export function horizonDraftFromText(text: string, nowMs: number): HorizonDraft {
  const horizon = parseHorizonHint(text, nowMs);
  if (!horizon?.label) return { horizon, phrase: null };
  const start = text.toLowerCase().indexOf(horizon.label.toLowerCase());
  if (start < 0) return { horizon, phrase: null };
  return { horizon, phrase: [start, start + horizon.label.length] };
}

/** Local midnight of a `yyyy-mm-dd` date input value. Null for a blank or bad value. */
export function horizonFromDateInput(value: string, label?: string): WorkHorizon | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime();
  if (Number.isNaN(at)) return null;
  const clean = label?.trim();
  return { kind: 'later', notBefore: at, ...(clean ? { label: clean.slice(0, 120) } : {}) };
}

/**
 * The horizon to save on Enter. A parsed phrase wins. Plain words become a
 * label so the Work sleeps with the user's own reason. Empty text saves nothing.
 */
export function horizonToCommit(text: string, draft: WorkHorizon | null): WorkHorizon | null {
  if (draft) return draft;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return { kind: 'later', label: clean.slice(0, 120) };
}

/** The line right of the field. Null means "Pick a date". */
export function resolvedHorizonLine(horizon: WorkHorizon | null, nowMs: number): string | null {
  if (!horizon) return null;
  if (horizon.kind === 'someday') return horizonLine(horizon, nowMs);
  if (typeof horizon.notBefore !== 'number' && typeof horizon.by !== 'number') return null;
  return horizonLine(horizon, nowMs);
}

function dateInputValue(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * One control for the horizon of a Work. A segmented track (Now, Later,
 * Someday). "Later" opens one field that accepts plain words. The parsed
 * phrase is underlined and the resolved date shows beside it. Enter saves.
 * Escape returns to the saved value.
 */
export function HorizonControl({
  value,
  nowMs,
  onChange,
  saving = false,
  error = null,
  autoFocus = false,
  onCancel,
  className,
}: {
  value: WorkHorizon | null | undefined;
  nowMs: number;
  onChange: (next: WorkHorizon | null) => void;
  saving?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  onCancel?: () => void;
  className?: string;
}) {
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const savedKind: HorizonKind = value?.kind ?? 'now';
  const [kind, setKind] = useState<HorizonKind>(savedKind);
  const [text, setText] = useState(value?.label ?? '');
  const [touched, setTouched] = useState(false);
  const [dateMode, setDateMode] = useState(false);

  // The saved value moved under the control (a wake, another device). Follow
  // it unless the user is in the middle of typing.
  useEffect(() => {
    if (touched) return;
    setKind(value?.kind ?? 'now');
    setText(value?.label ?? '');
  }, [value?.kind, value?.label, touched]);

  useEffect(() => {
    if (kind === 'later' && !dateMode && (autoFocus || touched)) inputRef.current?.focus();
  }, [kind, dateMode, autoFocus, touched]);

  const typed = touched ? horizonDraftFromText(text, nowMs) : { horizon: value ?? null, phrase: null };
  const draft = typed.horizon;
  const line = resolvedHorizonLine(draft, nowMs);
  const activeIndex = HORIZON_KINDS.indexOf(kind);

  const pick = (next: HorizonKind) => {
    setKind(next);
    setDateMode(false);
    if (next === 'now') {
      setTouched(false);
      onChange(null);
    } else if (next === 'someday') {
      setTouched(false);
      onChange({ kind: 'someday' });
    } else {
      setTouched(true);
    }
  };

  const revert = () => {
    setTouched(false);
    setDateMode(false);
    setKind(savedKind);
    setText(value?.label ?? '');
    onCancel?.();
  };

  const commit = () => {
    const next = horizonToCommit(text, draft);
    if (!next) return;
    setTouched(false);
    onChange(next);
  };

  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      revert();
    }
  };

  const phraseStart = typed.phrase?.[0] ?? 0;
  const phraseEnd = typed.phrase?.[1] ?? 0;
  const inputClass = 'px-3 py-1.5 text-[13px] leading-5';

  return (
    <div className={cn('flex flex-col items-end gap-2', className)}>
      <fieldset
        aria-label="Horizon"
        className="relative m-0 inline-grid min-w-0 grid-cols-3 rounded-full border-0 bg-[var(--color-bg-muted)] p-0.5"
      >
        <span
          aria-hidden
          data-horizon-indicator={kind}
          className="pointer-events-none absolute inset-y-0.5 rounded-full bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)] transition-[left] duration-[var(--duration-normal)] ease-[var(--ease-enter)] motion-reduce:transition-none"
          style={{
            left: `calc(2px + ${activeIndex} * (100% - 4px) / 3)`,
            width: 'calc((100% - 4px) / 3)',
          }}
        />
        {HORIZON_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            disabled={saving}
            onClick={() => pick(option)}
            className={cn(
              'relative z-10 h-7 rounded-full px-3 text-[11.5px] font-medium transition-colors',
              kind === option ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]',
            )}
          >
            {SEGMENT_LABEL[option]}
          </button>
        ))}
      </fieldset>

      {kind === 'later' ? (
        <div className="flex w-full max-w-md flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {dateMode ? (
            <input
              type="date"
              aria-label="Wake date"
              min={dateInputValue(nowMs)}
              defaultValue={
                typeof draft?.notBefore === 'number' && draft.notBefore > nowMs
                  ? dateInputValue(draft.notBefore)
                  : ''
              }
              disabled={saving}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  revert();
                }
              }}
              onChange={(event) => {
                const next = horizonFromDateInput(event.target.value, text);
                if (!next) return;
                setTouched(false);
                setDateMode(false);
                onChange(next);
              }}
              className={cn(
                inputClass,
                'min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-accent)]',
              )}
            />
          ) : (
            <div className="relative min-w-0 flex-1">
              <div
                aria-hidden
                className={cn(
                  inputClass,
                  'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-[var(--color-text)]',
                )}
              >
                {typed.phrase ? (
                  <>
                    {text.slice(0, phraseStart)}
                    <span className="underline decoration-[var(--color-accent-3)] decoration-2 underline-offset-[3px]">
                      {text.slice(phraseStart, phraseEnd)}
                    </span>
                    {text.slice(phraseEnd)}
                  </>
                ) : (
                  text
                )}
              </div>
              <input
                ref={inputRef}
                id={fieldId}
                type="text"
                aria-label="When does this come back?"
                value={text}
                placeholder={HORIZON_PLACEHOLDER}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setTouched(true);
                  setText(event.target.value);
                }}
                onKeyDown={onFieldKey}
                className={cn(
                  inputClass,
                  'relative w-full rounded-lg border border-[var(--color-border)] bg-transparent text-transparent caret-[var(--color-text)] outline-none',
                  'placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]',
                )}
              />
            </div>
          )}

          {line ? (
            <span
              className={cn(
                'shrink-0 text-[12px] text-[var(--color-accent-3)] transition-opacity duration-[var(--duration-fast)]',
                saving && 'opacity-55',
              )}
            >
              {line}
            </span>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={() => setDateMode((mode) => !mode)}
              className="shrink-0 text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              {dateMode ? 'Type it instead' : 'Pick a date'}
            </button>
          )}
          {error ? (
            <p className="basis-full text-right text-[11.5px] text-[var(--color-danger)]">{error}</p>
          ) : null}
        </div>
      ) : error ? (
        <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
