'use client';

// The composer notice for a value that looks like a secret in the draft
// (docs/albatross-secure-store.md, V9; lead decision 14). It appears on paste
// and on send, above the text. Return while it shows means "Send without it".
// "Save in Passwords and IDs" opens the add sheet with the value and takes it
// out of the draft. A card number has no save action.

import { NOTICE_COPY, secretNoticeLine } from '@/lib/albatross/secure-view';
import type { SecretShapeKind } from '@/lib/secure/redact';
import { cn } from '@/lib/utils';

export interface SecretNoticeProps {
  kind: SecretShapeKind;
  canSave: boolean;
  onSave: () => void;
  onSendWithout: () => void;
  disabled?: boolean;
  className?: string;
}

const textButton =
  'shrink-0 text-[11.5px] font-medium leading-tight transition-colors duration-[var(--duration-fast)] hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline';

export function SecretNotice({
  kind,
  canSave,
  onSave,
  onSendWithout,
  disabled,
  className,
}: SecretNoticeProps) {
  return (
    <div
      role="status"
      data-slot="secret-notice"
      data-secret-kind={kind}
      className={cn(
        'mx-1 mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-ui border border-[var(--color-accent-2)]/35 bg-[var(--color-accent-2-soft)] px-2.5 py-1.5 text-[12px] leading-snug text-[var(--color-text)]',
        className,
      )}
    >
      <span className="min-w-0 flex-1">{secretNoticeLine(kind)}</span>
      {canSave ? (
        <button
          type="button"
          className={cn(textButton, 'text-[var(--color-accent)]')}
          disabled={disabled}
          onClick={onSave}
        >
          {NOTICE_COPY.save}
        </button>
      ) : null}
      <button
        type="button"
        className={cn(textButton, 'text-[var(--color-text-muted)]')}
        disabled={disabled}
        onClick={onSendWithout}
      >
        {NOTICE_COPY.sendWithout}
      </button>
    </div>
  );
}
