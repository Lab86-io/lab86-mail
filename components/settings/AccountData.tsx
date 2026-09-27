'use client';

// Settings, Account: export the user's data before anything else. The same
// export is offered inside the account-deletion dialog, before the
// confirmation. Server contract: GET /api/account/export (a streamed ZIP).

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function fileNameFrom(header: string | null) {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] || 'albatross-export.zip';
}

/** Download the export; report success only when the whole file arrived. */
export function useDataExport() {
  const [pending, setPending] = useState(false);
  const start = async () => {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/account/export', { cache: 'no-store' });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('application/zip')) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileNameFrom(res.headers.get('content-disposition'));
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success('Your export is downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Could not export your data');
    } finally {
      setPending(false);
    }
  };
  return { start, pending };
}

export function ExportDataButton({
  className,
  label = 'Export my data',
}: {
  className?: string;
  label?: string;
}) {
  const { start, pending } = useDataExport();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={cn('shrink-0', className)}
      disabled={pending}
      onClick={() => void start()}
    >
      {pending ? 'Preparing export…' : label}
    </Button>
  );
}

export const EXPORT_DESCRIPTION =
  'A ZIP with one JSON file for each kind of data Albatross keeps: Albatrosses, editions, memory, tasks, settings, and mail records. Sign-in secrets are left out.';

/** Inside the deletion dialog, before the confirmation. */
export function ExportBeforeDelete() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-3 py-2.5">
      <p className="min-w-0 flex-1 basis-48 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        Keep a copy first. The export has your Albatrosses, editions, memory, tasks, and settings.
      </p>
      <ExportDataButton label="Export first" />
    </div>
  );
}
