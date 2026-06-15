'use client';

import { useQuery_experimental as useConvexQuery } from 'convex/react';
import { CalendarPlus, Check, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/convex/_generated/api';

// The proactive agent's review tray: detected events (and later, task and
// automation proposals) wait here. Accepting runs the real creation through
// the server (undoable); nothing is applied silently.
export function SuggestionsTray() {
  const live = useConvexQuery({ query: (api as any).suggestions.livePending, args: {} });
  const pending: any[] = live.status === 'success' ? live.data?.suggestions || [] : [];
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (suggestionId: string, action: 'accept' | 'dismiss') => {
    setBusyId(suggestionId);
    try {
      const response = await fetch('/api/suggestions/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suggestionId, action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Action failed');
      if (action === 'accept') toast.success(`Added “${data.title || 'event'}” to your calendar`);
    } catch (err: any) {
      toast.error(err?.message || 'Could not apply the suggestion');
    } finally {
      setBusyId(null);
    }
  };

  if (!pending.length) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative grid size-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
          title={`${pending.length} suggestion${pending.length === 1 ? '' : 's'} from your mail`}
        >
          <ProvenancePulseIcon />
          <span className="absolute -right-0.5 -top-0.5 grid size-3.5 place-items-center rounded-full bg-[var(--color-accent)] text-[8px] font-semibold leading-none text-[var(--color-accent-foreground)]">
            {pending.length > 9 ? '9+' : pending.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-80 p-2">
        <p className="px-1 pb-1.5 text-[11px] uppercase tracking-[0.09em] text-[var(--color-text-faint)]">
          Found in your mail
        </p>
        <ul className="space-y-1.5">
          {pending.slice(0, 8).map((suggestion) => (
            <li
              key={suggestion._id}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2"
            >
              <div className="flex items-start gap-2">
                <CalendarPlus className="mt-0.5 size-3.5 shrink-0 text-[var(--color-accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                    {suggestion.title}
                  </p>
                  <p className="truncate text-[11px] text-[var(--color-text-faint)]">
                    {suggestion.payload?.from || 'from your email'} · want it on your calendar?
                  </p>
                </div>
              </div>
              <div className="mt-1.5 flex justify-end gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyId === suggestion._id}
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => act(suggestion._id, 'dismiss')}
                >
                  <X className="size-3" /> Dismiss
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busyId === suggestion._id}
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => act(suggestion._id, 'accept')}
                >
                  <Check className="size-3" /> Add to calendar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ProvenancePulseIcon() {
  return (
    <span className="relative grid size-4 place-items-center" aria-hidden>
      <span className="absolute size-3 rounded-full border border-current opacity-40 [animation:provenance-pulse_1.9s_ease-out_infinite]" />
      <span className="absolute size-2 rounded-full border border-current opacity-60 [animation:provenance-pulse_1.9s_ease-out_infinite_0.28s]" />
      <span className="size-1.5 rounded-full bg-current shadow-[0_0_10px_currentColor]" />
    </span>
  );
}
