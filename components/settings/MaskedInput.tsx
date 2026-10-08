'use client';

// A field for a password, an ID number, or a key as the user types it
// (docs/albatross-secure-store.md, lead decision 6). It is a text input with
// the characters hidden by CSS, not a password input, so no browser or
// password manager offers to save the value for this site. "Show" reveals the
// fresh input while the user checks it; it is off at every open. Where the CSS
// is not available, a password input with autocomplete="new-password" stands
// in. The value never comes back after the save, so the user must be able to
// read what they typed here.

import { type CSSProperties, useEffect, useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export const MASKED_INPUT_COPY = {
  show: 'Show',
  hide: 'Hide',
  help: 'Hidden as you type. After you save, you can replace it but not see it.',
} as const;

/** The attributes that keep password managers away from a field. */
export const MANAGER_IGNORE_ATTRIBUTES = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-protonpass-ignore': '',
} as const;

export function MaskedInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  invalid,
  describedBy,
  inputMode,
  autoFocus,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  inputMode?: 'text' | 'numeric';
  autoFocus?: boolean;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  // Null until the browser answers; the server render masks with CSS.
  const [cssMask, setCssMask] = useState<boolean | null>(null);
  const helpId = useId();
  useEffect(() => {
    setCssMask(
      typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        CSS.supports('-webkit-text-security', 'disc'),
    );
  }, []);
  const fallback = cssMask === false;
  const masked = !show;
  const style = masked && !fallback ? ({ WebkitTextSecurity: 'disc' } as CSSProperties) : undefined;
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        type={masked && fallback ? 'password' : 'text'}
        style={style}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        autoComplete={fallback ? 'new-password' : 'off'}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={[describedBy, helpId].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 pr-14 text-[12.5px]"
        {...MANAGER_IGNORE_ATTRIBUTES}
      />
      <button
        type="button"
        aria-pressed={show}
        disabled={disabled}
        onClick={() => setShow((current) => !current)}
        className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[11.5px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
      >
        {show ? MASKED_INPUT_COPY.hide : MASKED_INPUT_COPY.show}
      </button>
      <span id={helpId} className="sr-only">
        {MASKED_INPUT_COPY.help}
      </span>
    </div>
  );
}
