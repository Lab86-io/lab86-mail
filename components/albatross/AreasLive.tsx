'use client';

// Research (Albatross contract - research before code):
// - Mobbin/Mindvalley onboarding (05c98b08-418d-4892-afe4-bdefdafb627e) and Amazon Alexa
//   interests (f2bd3064-672b-4818-b4c1-e869ce3b16b3): first-run personalization leads with
//   one warm invitation, not an empty table.
// - Mobbin/Apple Maps place card (2fad7799-5b40-4ad4-a9ed-6c35a77b8e4b) + Snapchat place card
//   (307310a1-ccf1-49c4-90ab-8bffa7b89903): found details read as compact rows with outbound
//   links, never as raw records.
// - NN/g wizard guidelines (nngroup.com/articles/wizards): setup must be re-enterable; the
//   surface stays usable without it.

import { useQuery as useHTTPQuery } from '@tanstack/react-query';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { Check, Link2, ShieldCheck, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import {
  type AreaFactLike,
  AreaOnboardingWizard,
  factSourceLinks,
  groupAreaFacts,
} from '@/components/albatross/AreaOnboarding';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

interface AreaLike {
  _id: Id<'areas'>;
  name: string;
  kind: string;
  status: string;
  description?: string;
  priority?: number;
}

export function AreasLive({ openSetup }: { openSetup?: boolean }) {
  // Skip until the Clerk token has reached the Convex client — first-paint
  // queries otherwise run unauthenticated and throw server-side.
  const { isAuthenticated } = useConvexAuth();
  const liveAreas = useQuery(api.albatross.listAreas, isAuthenticated ? { status: 'active' } : 'skip') as
    | AreaLike[]
    | undefined;
  const fallbackAreas = useHTTPQuery({
    queryKey: ['areas', 'active', 'http-fallback'],
    queryFn: () => callTool<{ areas: AreaLike[] }>('area_list', { status: 'active' }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  // Live Convex remains authoritative. The authenticated tool path supplies a
  // last-good HTTP/cache result when Convex auth or subscriptions are delayed.
  const areas = liveAreas ?? fallbackAreas.data?.areas;
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const [selectedId, setSelectedId] = useState<Id<'areas'> | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  // Deep link (/?setup=areas): open the wizard as soon as the surface mounts.
  useEffect(() => {
    if (openSetup) setWizardOpen(true);
  }, [openSetup]);

  useEffect(() => {
    if (areas) {
      setLoadTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setLoadTimedOut(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [areas]);

  const selected = areas?.find((area) => area._id === selectedId) ?? areas?.[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Areas</h2>
          {areas ? (
            <span className="text-[11.5px] text-[var(--color-text-faint)]">{areas.length} active</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPrimaryView('unassigned')}>
            Review queue
          </Button>
          <Button type="button" size="sm" onClick={() => setWizardOpen(true)}>
            Set up areas
          </Button>
        </div>
      </div>

      {areas === undefined && loadTimedOut ? (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-sm">
            <h3 className="text-[14px] font-semibold">Areas could not refresh</h3>
            <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
              Convex authentication did not finish and no saved HTTP result is available.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                setLoadTimedOut(false);
                void fallbackAreas.refetch();
              }}
            >
              Try Again
            </Button>
          </div>
        </div>
      ) : areas === undefined ? (
        <div className="px-4 py-8 text-[12.5px] text-[var(--color-text-muted)]">Loading areas…</div>
      ) : areas.length === 0 ? (
        <EmptyHero onStart={() => setWizardOpen(true)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[260px_1fr]">
          <div className="min-h-0 overflow-y-auto border-b border-[var(--color-border)] md:border-r md:border-b-0">
            {areas.map((area) => (
              <button
                key={area._id}
                type="button"
                onClick={() => setSelectedId(area._id)}
                className={cn(
                  'block w-full border-b border-[var(--color-border)] px-4 py-3 text-left transition-colors last:border-b-0',
                  selected?._id === area._id
                    ? 'bg-[var(--color-accent-soft)]'
                    : 'hover:bg-[var(--color-bg-muted)]',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{area.name}</span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
                    {area.kind}
                  </Badge>
                </div>
                {area.description ? (
                  <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-text-muted)]">
                    {area.description}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
          {selected ? <AreaDetail key={selected._id} area={selected} /> : null}
        </div>
      )}

      <AreaOnboardingWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </div>
  );
}

function EmptyHero({ onStart }: { onStart: () => void }) {
  return (
    <div className="grid flex-1 place-items-center px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="max-w-md text-center"
      >
        <h3 className="text-[17px] font-semibold tracking-tight">
          Albatross doesn&apos;t know your life yet. Teach it.
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Name the parts of your life you are responsible for — work, money, home, whatever counts — and
          Albatross starts sorting everything against them. A couple of minutes, skippable anytime.
        </p>
        <Button type="button" size="lg" className="mt-5" onClick={onStart}>
          Teach me your life
        </Button>
      </motion.div>
    </div>
  );
}

function AreaDetail({ area }: { area: AreaLike }) {
  const { isAuthenticated } = useConvexAuth();
  const facts = useQuery(api.albatross.listAreaFacts, isAuthenticated ? { areaId: area._id } : 'skip') as
    | AreaFactLike[]
    | undefined;
  const verifyFact = useMutation(api.albatross.verifyAreaFact);
  const rejectFact = useMutation(api.albatross.rejectAreaFact);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const { candidates, verified } = groupAreaFacts(facts);

  const verify = async (fact: AreaFactLike) => {
    setBusyFactId(fact._id);
    try {
      // The click is the explicit user confirmation the trust model requires.
      await verifyFact({
        factId: fact._id as Id<'areaFacts'>,
        confirmationRefs: [
          { kind: 'userConfirmation', id: `areas-live:${fact._id}:${Date.now()}`, confirmedAt: Date.now() },
        ],
      });
    } finally {
      setBusyFactId(null);
    }
  };

  const reject = async (fact: AreaFactLike) => {
    setBusyFactId(fact._id);
    try {
      await rejectFact({ factId: fact._id as Id<'areaFacts'>, reason: 'Rejected from Areas' });
    } finally {
      setBusyFactId(null);
    }
  };

  return (
    <div className="min-h-0 overflow-y-auto px-5 py-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">{area.name}</h3>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
          {area.kind}
        </Badge>
      </div>
      {area.description ? (
        <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">{area.description}</p>
      ) : null}

      {facts === undefined ? (
        <p className="mt-5 text-[12.5px] text-[var(--color-text-muted)]">Loading facts…</p>
      ) : (
        <>
          {candidates.length > 0 ? (
            <section className="mt-5">
              <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Found — keep it?</h4>
              <div className="mt-2 space-y-2">
                {candidates.map((fact) => (
                  <FactRow key={fact._id} fact={fact} busy={busyFactId === fact._id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => verify(fact)}
                      disabled={busyFactId === fact._id}
                    >
                      <Check className="size-3 text-emerald-500" />
                      Looks right
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => reject(fact)}
                      disabled={busyFactId === fact._id}
                    >
                      <X className="size-3" />
                      No
                    </Button>
                  </FactRow>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mt-5">
            <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Verified</h4>
            {verified.length > 0 ? (
              <div className="mt-2 space-y-2">
                {verified.map((fact) => (
                  <FactRow key={fact._id} fact={fact} verified />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[12.5px] text-[var(--color-text-muted)]">
                Nothing verified yet — run &ldquo;Set up areas&rdquo; to add what you know.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function FactRow({
  fact,
  verified,
  busy,
  children,
}: {
  fact: AreaFactLike;
  verified?: boolean;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const links = factSourceLinks(fact);
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5',
        busy && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        {verified ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
              {fact.kind}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{fact.value}</span>
          </div>
          {links.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-2">
              {links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:underline"
                >
                  <Link2 className="size-3" />
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
        {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
      </div>
    </div>
  );
}
