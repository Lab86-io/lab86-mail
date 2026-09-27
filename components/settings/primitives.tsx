'use client';

// The shared shape of a settings pane, for sections that live in their own
// files. It matches the helpers inside app/settings/page.tsx: one heading, one
// card per group, one row per choice with the label and its consequence on the
// left and the control on the right.

import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export function SectionHeading({
  title,
  blurb,
  aside,
}: {
  title: string;
  blurb: string;
  /** A short state read-out on the right: counts, saved, on or off. */
  aside?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-[var(--color-border)] pb-4">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 max-w-xl text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          {blurb}
        </p>
      </div>
      {aside ? (
        <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--color-text-faint)]">{aside}</span>
      ) : null}
    </div>
  );
}

export function SettingsCard({
  children,
  tone = 'default',
  className,
}: {
  children: ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'divide-y divide-[var(--color-border)] rounded-xl border bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
        tone === 'danger' ? 'border-[var(--color-danger)]/30' : 'border-[var(--color-border)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  id,
  label,
  description,
  hint,
  control,
  disabled,
  children,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  /** A live read-out under the description: a status, a warning, a result. */
  hint?: ReactNode;
  control?: ReactNode;
  disabled?: boolean;
  /** Extra content below the row, full width. */
  children?: ReactNode;
}) {
  return (
    <div className={cn('px-4 py-3', disabled && 'opacity-55')}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          {id ? (
            <Label htmlFor={id} className="text-[13px] font-medium">
              {label}
            </Label>
          ) : (
            <p className="text-[13px] font-medium">{label}</p>
          )}
          {description ? (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
              {description}
            </p>
          ) : null}
          {hint ? <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">{hint}</div> : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsGroupTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 mt-6 text-[12px] font-semibold text-[var(--color-text-muted)] first:mt-0">
      {children}
    </h3>
  );
}

export function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{children}</p>;
}
