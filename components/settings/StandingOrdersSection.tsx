'use client';

// Settings, Standing orders: everything Albatross does on its own, in one
// list, each with a pause switch. The server contract is /api/standing-orders
// (lib/hosted/standing-orders.ts); iOS and macOS read the same list.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import { Ring } from '@/components/loading-ui/ring';
import { Switch } from '@/components/ui/switch';
import type { StandingOrder, StandingOrderGroup, StandingOrderMode } from '@/lib/hosted/standing-orders';
import { SectionHeading, SettingsCard, SettingsGroupTitle, SettingsNote, SettingsRow } from './primitives';

const QUERY_KEY = ['standing-orders'];

const GROUPS: Array<{ id: StandingOrderGroup; title: string }> = [
  { id: 'schedule', title: 'On a schedule' },
  { id: 'mail', title: 'In your mail' },
  { id: 'assistant', title: 'What the assistant may do in chat' },
];

const MODE_TEXT: Record<StandingOrderMode, string> = {
  runs_alone: 'Runs on its own',
  draft: 'Drafts, then waits for you',
  asks_first: 'Asks you first',
};

const ITEM_LIMIT = 5;

async function readJson(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function standingOrderHint(order: StandingOrder): string {
  if (order.locked) return 'Always on';
  if (order.paused) return 'Paused';
  return MODE_TEXT[order.mode];
}

export function StandingOrdersSection() {
  const qc = useQueryClient();
  const query = useQuery<StandingOrder[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => (await readJson(await fetch('/api/standing-orders', { cache: 'no-store' }))).orders,
  });
  const toggle = useMutation({
    mutationFn: async (input: { id: string; paused: boolean }) =>
      (
        await readJson(
          await fetch('/api/standing-orders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }),
        )
      ).order as StandingOrder,
    // The switch moves only when the server confirms the change.
    onSuccess: (order) => {
      qc.setQueryData<StandingOrder[]>(QUERY_KEY, (current) =>
        (current ?? []).map((entry) => (entry.id === order.id ? order : entry)),
      );
      toast.success(order.paused ? `${order.title} is paused` : `${order.title} is on`);
    },
    onError: (err: any) => toast.error(err?.message || 'Could not change the standing order'),
  });

  const orders = query.data ?? [];
  const pausedCount = orders.filter((order) => order.paused).length;

  return (
    <section>
      <SectionHeading
        title="Standing orders"
        blurb="Everything Albatross does without a new request from you. Pause any of them here; nothing is deleted."
        aside={query.isSuccess ? (pausedCount ? `${pausedCount} paused` : 'All on') : undefined}
      />
      {query.isError ? (
        <div role="alert" className="text-[13px] text-[var(--color-danger)]">
          Could not load your standing orders.{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </div>
      ) : query.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-6 text-[13px] text-[var(--color-text-muted)]">
          <Ring className="size-3.5" /> Loading your standing orders…
        </div>
      ) : (
        <>
          {GROUPS.map((group) => {
            const rows = orders.filter((order) => order.group === group.id);
            if (!rows.length) return null;
            return (
              <div key={group.id}>
                <SettingsGroupTitle>{group.title}</SettingsGroupTitle>
                <SettingsCard>
                  {rows.map((order) => {
                    const switchId = `standing-order-${order.id.replace(/[^a-z0-9_-]/gi, '-')}`;
                    const busy = toggle.isPending && toggle.variables?.id === order.id;
                    return (
                      <SettingsRow
                        key={order.id}
                        id={order.locked ? undefined : switchId}
                        label={order.title}
                        description={order.detail}
                        hint={
                          <span data-slot="standing-order-state">
                            {busy ? 'Saving…' : standingOrderHint(order)}
                            {order.href ? (
                              <>
                                {' · '}
                                <Link href={order.href} className="underline">
                                  Details
                                </Link>
                              </>
                            ) : null}
                          </span>
                        }
                        control={
                          order.locked ? null : (
                            <Switch
                              id={switchId}
                              checked={!order.paused}
                              disabled={busy}
                              aria-label={order.paused ? `Resume ${order.title}` : `Pause ${order.title}`}
                              onCheckedChange={(on) => toggle.mutate({ id: order.id, paused: !on })}
                            />
                          )
                        }
                      >
                        {order.items.length ? (
                          <ul className="mt-2 space-y-1 border-l border-[var(--color-border)] pl-3">
                            {order.items.slice(0, ITEM_LIMIT).map((item) => (
                              <li key={item.id} className="text-[11.5px] leading-snug">
                                <span className="text-[var(--color-text)]">{item.label}</span>
                                {item.detail ? (
                                  <span className="text-[var(--color-text-faint)]"> · {item.detail}</span>
                                ) : null}
                              </li>
                            ))}
                            {order.items.length > ITEM_LIMIT ? (
                              <li className="text-[11.5px] text-[var(--color-text-faint)]">
                                and {order.items.length - ITEM_LIMIT} more
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </SettingsRow>
                    );
                  })}
                </SettingsCard>
              </div>
            );
          })}
          <SettingsNote>
            Albatross always asks before it reaches another person or makes a change that cannot be undone.
            Every other change shows in{' '}
            <Link href="/?view=activity" className="underline">
              Activity
            </Link>
            , where you can undo it. A paused order stays paused on every device.
          </SettingsNote>
        </>
      )}
    </section>
  );
}
