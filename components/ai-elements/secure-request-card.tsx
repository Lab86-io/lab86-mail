'use client';

// The chat's ask_secure_detail question (docs/albatross-secure-store.md, V12;
// lead decision 12): a card that names what to add and why, opens the add
// sheet, and waits. It holds no value. "Already saved" comes from the
// client's own list, and the answer then names that item. Answered, it
// collapses to one line in the accent-3 voice, like every other outcome.

import { ShapeShell } from '@/components/ai-elements/shapes/shape-shell';
import { REQUEST_COPY, secureRequestExistsTitle, secureRequestTitle } from '@/lib/albatross/secure-view';
import type { SecureItemView, SecureRequestInput } from '@/lib/secure/contract';
import { cn } from '@/lib/utils';

export type SecureRequestState = 'pending' | 'opening' | 'saved' | 'skipped';

export interface SecureRequestCardProps {
  input: SecureRequestInput;
  state: SecureRequestState;
  /** The item of the client's own list that already answers the request. */
  existing?: SecureItemView | null;
  onAdd: () => void;
  onSkip: () => void;
  onUseExisting?: (item: SecureItemView) => void;
  onOpenSettings?: () => void;
  className?: string;
}

const textButton =
  'shrink-0 text-[11.5px] font-medium leading-tight text-[var(--color-accent)] transition-colors duration-[var(--duration-fast)] hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline';

export function SecureRequestCard({
  input,
  state,
  existing = null,
  onAdd,
  onSkip,
  onUseExisting,
  onOpenSettings,
  className,
}: SecureRequestCardProps) {
  const answered = state === 'saved' || state === 'skipped';
  const exists = !answered && existing;
  const title = exists ? secureRequestExistsTitle(input) : secureRequestTitle(input);
  const summary = exists ? REQUEST_COPY.existsLine : input.reason;
  return (
    <ShapeShell title={title} summary={summary} className={cn('max-w-[460px]', className)}>
      <div
        data-slot="secure-request"
        data-request-state={exists ? 'exists' : state}
        className="flex items-baseline justify-end gap-2.5 px-3 pt-0.5 pb-2.5"
      >
        {state === 'saved' ? (
          <span data-slot="shape-outcome" className="text-[11.5px] font-medium text-[var(--color-accent-3)]">
            {REQUEST_COPY.saved(input.site)}
          </span>
        ) : state === 'skipped' ? (
          <span
            data-slot="shape-outcome"
            className="text-[11.5px] font-medium text-[var(--color-text-faint)]"
          >
            {REQUEST_COPY.skipped}
          </span>
        ) : exists ? (
          <>
            {onOpenSettings ? (
              <button
                type="button"
                className={cn(textButton, 'text-[var(--color-text-muted)]')}
                onClick={onOpenSettings}
              >
                {REQUEST_COPY.openSettings}
              </button>
            ) : null}
            <button type="button" className={textButton} onClick={() => onUseExisting?.(existing)}>
              {REQUEST_COPY.useIt}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={cn(textButton, 'text-[var(--color-text-muted)]')}
              disabled={state === 'opening'}
              onClick={onSkip}
            >
              {REQUEST_COPY.skip}
            </button>
            <button type="button" className={textButton} disabled={state === 'opening'} onClick={onAdd}>
              {REQUEST_COPY.add}
            </button>
          </>
        )}
      </div>
    </ShapeShell>
  );
}
