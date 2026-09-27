'use client';

import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// The settings page's card and row shapes, for the mail sections that live in
// their own files (signatures, saved replies, voice, mail alerts). Same
// classes as app/settings/page.tsx so the sections read as one page.

export function MailSettingsGroupTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 mt-7 flex items-end justify-between gap-3">
      <h3 className="text-[12px] font-semibold text-[var(--color-text-muted)]">{children}</h3>
      {aside ? (
        <span className="text-[11.5px] tabular-nums text-[var(--color-text-faint)]">{aside}</span>
      ) : null}
    </div>
  );
}

export function MailSettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MailSettingsRow({
  id,
  label,
  description,
  hint,
  control,
  children,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
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
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

export function MailSettingsNote({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{children}</p>;
}
