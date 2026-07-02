'use client';

// Research (Albatross contract - research before code):
// - Mobbin/Mindvalley onboarding (05c98b08-418d-4892-afe4-bdefdafb627e): "choose the areas of
//   life you want to improve" -> tappable area chips, progress strip, quiet Skip top-right.
// - Mobbin/Amazon Alexa interests (f2bd3064-672b-4818-b4c1-e869ce3b16b3): grouped chips with
//   a "Later" escape hatch always visible next to Continue.
// - Mobbin/X topic setup (9d02732c-a9fd-4c41-b7f1-52b5ddb3f1df) and Yahoo News topics
//   (75d8f931-4bf4-4714-a132-62bbbd7ecea9): chip toggling stays cheap; selection is reversible.
// - Mobbin/Apple Maps place card (2fad7799-5b40-4ad4-a9ed-6c35a77b8e4b), foodpanda hours
//   (2c0099c7-9479-4661-a945-dd1ec9c41da2), Snapchat place card (307310a1-ccf1-49c4-90ab-
//   8bffa7b89903), Grab place details (0347bd43-9b8f-42a7-932f-305b45e40c50): name first,
//   then hours line, address with map affordance, and pill links out (website/directions).
// - NN/g wizard guidelines (nngroup.com/articles/wizards): show where you are in the steps,
//   label buttons with what they do (not "Next"), keep every step skippable and self-sufficient.

import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock,
  ExternalLink,
  Globe,
  Link2,
  MapPin,
  Plus,
  ShoppingBag,
  Sparkles,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { Ring } from '@/components/loading-ui/ring';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

// The pure model (chips, classifiers, wizard state machine) lives in
// area-onboarding-model.ts and is re-exported here so tests and callers
// keep a single import surface.
export * from './area-onboarding-model';

import {
  AREA_KIND_OPTIONS,
  areaKeyFor,
  type DraftArea,
  factKindForEntry,
  hostnameForUrl,
  initialWizardState,
  SUGGESTED_AREAS,
  savedAreas,
  type WizardEvent,
  type WizardState,
  type WizardStep,
  wizardCounts,
  wizardReducer,
} from './area-onboarding-model';

// ---------------------------------------------------------------------------
// Fetch seam (no Convex provider required - usable from /welcome and Settings)
// ---------------------------------------------------------------------------

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

interface PlaceLookupResult {
  profile: {
    resolvedName: string;
    address?: string | null;
    website?: string | null;
    phone?: string | null;
    hoursText?: string | null;
    onlineOrdering?: { available?: boolean | null; url?: string | null; notes?: string | null };
    confidence: 'high' | 'medium' | 'low';
    notes?: string | null;
    mapsUrl: string;
  };
  sourceUrls: string[];
  factIds: string[];
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

const ENTRY_TYPES = [
  { id: 'person', label: 'Person', placeholder: 'Andrew: boss' },
  { id: 'site', label: 'Domain or site', placeholder: 'cardhunt.com' },
  { id: 'place', label: 'Place', placeholder: "Joe's Coffee, Albany" },
  { id: 'note', label: 'Note', placeholder: 'Rent is due on the 1st' },
] as const;

type EntryTypeId = (typeof ENTRY_TYPES)[number]['id'];

export function AreaOnboardingWizard({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [state, dispatch] = useReducer(wizardReducer, undefined, initialWizardState);
  const [hydrating, setHydrating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHydrating(true);
    (async () => {
      try {
        const res = await fetch('/api/albatross/areas', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        const areas = Array.isArray(data?.areas) ? data.areas : [];
        if (cancelled) return;
        dispatch({
          type: 'hydrate',
          existing: areas.map((area: any) => ({
            areaId: String(area._id),
            name: String(area.name || ''),
            kind: area.kind,
            description: area.description,
          })),
        });
      } catch {
        if (!cancelled) dispatch({ type: 'hydrate', existing: [] });
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const saveOne = useCallback(async (draft: DraftArea) => {
    dispatch({ type: 'area_saving', key: draft.key });
    try {
      const data = await postJson('/api/albatross/areas', {
        action: 'create_area',
        name: draft.name,
        kind: draft.kind,
        description: draft.description.trim() || undefined,
      });
      dispatch({ type: 'area_saved', key: draft.key, areaId: String(data.areaId) });
    } catch (err: any) {
      dispatch({ type: 'area_failed', key: draft.key, error: err?.message || 'Could not create area' });
    }
  }, []);

  const createAndContinue = useCallback(async () => {
    setBusy(true);
    try {
      const pending = state.drafts.filter((draft) => draft.save === 'draft' || draft.save === 'failed');
      await Promise.all(pending.map(saveOne));
    } finally {
      setBusy(false);
    }
    dispatch({ type: 'begin_facts' });
  }, [state.drafts, saveOne]);

  const finish = useCallback(async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      await postJson('/api/albatross/areas', { action: 'complete_onboarding' });
      onComplete?.();
      onOpenChange(false);
    } catch (err: any) {
      setFinishError(err?.message || 'Could not save your progress');
    } finally {
      setFinishing(false);
    }
  }, [onComplete, onOpenChange]);

  const saved = savedAreas(state);
  const currentArea = state.step === 'facts' ? saved[state.factIndex] : undefined;
  const motionProps = {
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 },
    animate: { opacity: 1, x: 0 },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, x: -24 },
    transition: { duration: 0.18 },
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
          <DialogTitle className="text-[16px] font-semibold tracking-tight">
            {state.rerun ? 'Teach Albatross more' : 'Teach Albatross your life'}
          </DialogTitle>
          <StepDots step={state.step} />
        </div>
        {hydrating ? (
          <div className="flex items-center gap-2 px-6 py-10 text-[13px] text-[var(--color-text-muted)]">
            <Ring className="size-4" /> Checking what Albatross already knows…
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={state.step === 'facts' ? `facts-${state.factIndex}` : state.step}
              className="px-6 py-5"
              {...motionProps}
            >
              {state.step === 'areas' ? (
                <AreasStep
                  state={state}
                  dispatch={dispatch}
                  busy={busy}
                  onRetry={saveOne}
                  onContinue={createAndContinue}
                  onSkip={() => onOpenChange(false)}
                />
              ) : null}
              {state.step === 'facts' && currentArea ? (
                <FactsStep
                  key={currentArea.key}
                  area={currentArea}
                  position={state.factIndex + 1}
                  total={saved.length}
                  dispatch={dispatch}
                />
              ) : null}
              {state.step === 'done' ? (
                <DoneStep state={state} finishing={finishing} error={finishError} onFinish={finish} />
              ) : null}
            </motion.div>
          </AnimatePresence>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepDots({ step }: { step: WizardStep }) {
  const steps: { id: WizardStep; label: string }[] = [
    { id: 'areas', label: 'Areas' },
    { id: 'facts', label: 'Details' },
    { id: 'done', label: 'Done' },
  ];
  return (
    <div className="mr-7 flex items-center gap-2">
      {steps.map((item) => (
        <span
          key={item.id}
          className={cn(
            'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
            item.id === step
              ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
              : 'bg-[var(--color-bg-muted)] text-[var(--color-text-faint)]',
          )}
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}

function AreasStep({
  state,
  dispatch,
  busy,
  onRetry,
  onContinue,
  onSkip,
}: {
  state: WizardState;
  dispatch: (event: WizardEvent) => void;
  busy: boolean;
  onRetry: (draft: DraftArea) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [custom, setCustom] = useState('');
  const usedKeys = new Set(state.drafts.map((draft) => draft.key));
  const suggestions = SUGGESTED_AREAS.filter((item) => !usedKeys.has(areaKeyFor(item.name)));
  const addCustom = () => {
    dispatch({ type: 'add_area', name: custom });
    setCustom('');
  };
  const hasNew = state.drafts.some((draft) => draft.save !== 'saved');

  return (
    <div>
      <h3 className="text-[15px] font-semibold tracking-tight">
        What parts of your life should Albatross track?
      </h3>
      {/* Epic rule: ask about responsibilities, not roles or demographics. */}
      <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
        Think in responsibilities — the things you are on the hook for — not job titles.
      </p>

      {suggestions.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {suggestions.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() => dispatch({ type: 'add_area', name: item.name, kind: item.kind })}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1 text-[12px] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Plus className="mr-1 inline size-3 text-[var(--color-text-faint)]" />
              {item.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addCustom();
          }}
          placeholder="Something else — CardHunt, Habits, AI news…"
          className="h-8 text-[13px]"
        />
        <Button type="button" variant="outline" size="sm" onClick={addCustom} disabled={!custom.trim()}>
          Add
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {state.drafts.map((draft) => (
          <AreaRow key={draft.key} draft={draft} dispatch={dispatch} onRetry={onRetry} />
        ))}
        {state.drafts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-5 text-center text-[12.5px] text-[var(--color-text-muted)]">
            Tap a suggestion or type your own — each becomes an area Albatross watches.
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
          Skip for now
        </Button>
        <Button type="button" size="sm" onClick={onContinue} disabled={busy || state.drafts.length === 0}>
          {busy ? <Ring className="size-3" /> : null}
          {hasNew ? 'Create areas' : 'Continue to details'}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function AreaRow({
  draft,
  dispatch,
  onRetry,
}: {
  draft: DraftArea;
  dispatch: (event: WizardEvent) => void;
  onRetry: (draft: DraftArea) => void;
}) {
  const locked = draft.save === 'saved' || draft.save === 'saving';
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{draft.name}</span>
        <Select
          value={draft.kind}
          onValueChange={(kind) => dispatch({ type: 'edit_area', key: draft.key, patch: { kind } })}
          disabled={locked}
        >
          <SelectTrigger size="sm" className="h-7 w-[110px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AREA_KIND_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft.save === 'saving' ? <Ring className="size-3.5" /> : null}
        {draft.save === 'saved' ? <Check className="size-4 text-emerald-500" aria-label="Created" /> : null}
        {draft.save === 'draft' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${draft.name}`}
            onClick={() => dispatch({ type: 'remove_area', key: draft.key })}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {!locked ? (
        <Input
          value={draft.description}
          onChange={(event) =>
            dispatch({ type: 'edit_area', key: draft.key, patch: { description: event.target.value } })
          }
          placeholder="One line on what this covers (optional)"
          className="mt-2 h-7 border-none bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
        />
      ) : draft.description ? (
        <p className="mt-1 truncate text-[12px] text-[var(--color-text-muted)]">{draft.description}</p>
      ) : null}
      {draft.save === 'failed' ? (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-danger)]">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{draft.error}</span>
          <Button type="button" variant="outline" size="xs" onClick={() => onRetry(draft)}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FactsStep({
  area,
  position,
  total,
  dispatch,
}: {
  area: DraftArea;
  position: number;
  total: number;
  dispatch: (event: WizardEvent) => void;
}) {
  const [entryType, setEntryType] = useState<EntryTypeId>('person');
  const [entry, setEntry] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ id: string; kind: string; value: string }[]>([]);
  const [place, setPlace] = useState<PlaceLookupResult | null>(null);
  const [placeBusy, setPlaceBusy] = useState(false);

  const addTypedFact = async (value: string, forcedKind?: string) => {
    if (!value.trim() || !area.areaId) return;
    const kind =
      forcedKind ||
      (entryType === 'person' ? 'person' : entryType === 'note' ? 'note' : factKindForEntry(value));
    setSaving(true);
    setError(null);
    try {
      // User-stated facts arrive verified: the API attaches the user-confirmation ref.
      await postJson('/api/albatross/areas', {
        action: 'add_fact',
        areaId: area.areaId,
        kind,
        value: value.trim(),
        verified: true,
      });
      dispatch({ type: 'fact_added' });
      setAdded((rows) => [...rows, { id: `${Date.now()}-${rows.length}`, kind, value: value.trim() }]);
      setEntry('');
    } catch (err: any) {
      setError(err?.message || 'Could not save that');
    } finally {
      setSaving(false);
    }
  };

  const lookupPlace = async () => {
    if (!entry.trim() || !area.areaId) return;
    setPlaceBusy(true);
    setError(null);
    setPlace(null);
    try {
      const data = (await postJson('/api/albatross/place', {
        name: entry.trim(),
        areaId: area.areaId,
      })) as PlaceLookupResult;
      setPlace(data);
      // The place route already saved these as candidate facts - count, don't re-save.
      dispatch({ type: 'fact_added', count: data.factIds?.length ?? 0 });
      setEntry('');
    } catch (err: any) {
      setError(err?.message || 'Could not look that up');
    } finally {
      setPlaceBusy(false);
    }
  };

  const meta = ENTRY_TYPES.find((item) => item.id === entryType) ?? ENTRY_TYPES[0];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold tracking-tight">
          Anything Albatross should know about {area.name}?
        </h3>
        <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
          {position} of {total}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
        People, sites, places, notes — whatever helps it triage. Skip freely.
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {ENTRY_TYPES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setEntryType(item.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-[12px] transition-colors',
              entryType === item.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-text-faint)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <Input
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            if (entryType === 'place') lookupPlace();
            else addTypedFact(entry);
          }}
          placeholder={meta.placeholder}
          disabled={placeBusy}
          className="h-8 text-[13px]"
        />
        {entryType === 'place' ? (
          <Button type="button" size="sm" onClick={lookupPlace} disabled={placeBusy || !entry.trim()}>
            {placeBusy ? <Ring className="size-3" /> : <Globe className="size-3.5" />}
            Look it up
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => addTypedFact(entry)}
            disabled={saving || !entry.trim()}
          >
            {saving ? <Ring className="size-3" /> : <Plus className="size-3.5" />}
            Add
          </Button>
        )}
      </div>

      {placeBusy ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">
          <Ring className="size-3.5" /> Looking it up on the web — 20 seconds or so…
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-[12.5px]">
          <AlertTriangle className="size-3.5 shrink-0 text-[var(--color-danger)]" />
          <span className="min-w-0 flex-1">{error}</span>
          {entryType === 'place' && entry.trim() ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => addTypedFact(entry, 'note')}
              disabled={saving}
            >
              Keep as a note
            </Button>
          ) : null}
        </div>
      ) : null}

      {place ? <PlaceResultCard result={place} areaName={area.name} /> : null}

      {added.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {added.map((fact) => (
            <li
              key={fact.id}
              className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]"
            >
              <Check className="size-3.5 shrink-0 text-emerald-500" />
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {fact.kind}
              </Badge>
              <span className="min-w-0 truncate">{fact.value}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: 'skip_facts' })}>
          Skip the rest
        </Button>
        <Button type="button" size="sm" onClick={() => dispatch({ type: 'next_area' })} disabled={placeBusy}>
          {position === total ? 'Finish up' : 'Next area'}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function PlaceResultCard({ result, areaName }: { result: PlaceLookupResult; areaName: string }) {
  const { profile } = result;
  const ordering = profile.onlineOrdering;
  return (
    <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold">{profile.resolvedName}</span>
        <Badge
          variant="outline"
          className={cn(
            'px-1.5 py-0 text-[10px] capitalize',
            profile.confidence === 'high' && 'border-emerald-500/40 text-emerald-600',
            profile.confidence === 'low' && 'border-amber-500/40 text-amber-600',
          )}
        >
          {profile.confidence} confidence
        </Badge>
      </div>
      <div className="mt-2 space-y-1.5 text-[12.5px]">
        {profile.address ? (
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)]" />
            <span className="min-w-0">{profile.address}</span>
          </div>
        ) : null}
        {profile.hoursText ? (
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)]" />
            <span className="min-w-0 whitespace-pre-line">{profile.hoursText}</span>
          </div>
        ) : null}
        <div className="flex items-start gap-2">
          <ShoppingBag className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)]" />
          {ordering?.available ? (
            <span>
              Online ordering available
              {ordering.url ? (
                <>
                  {' — '}
                  <a
                    href={ordering.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--color-accent)] underline-offset-2 hover:underline"
                  >
                    order here
                  </a>
                </>
              ) : null}
            </span>
          ) : ordering?.available === false ? (
            <span>No online ordering found</span>
          ) : (
            <span className="text-[var(--color-text-muted)]">Online ordering: unknown</span>
          )}
        </div>
        {profile.notes ? <p className="text-[var(--color-text-muted)]">{profile.notes}</p> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="xs">
          <a href={profile.mapsUrl} target="_blank" rel="noreferrer">
            <MapPin className="size-3" /> Map
          </a>
        </Button>
        {profile.website ? (
          <Button asChild variant="outline" size="xs">
            <a href={profile.website} target="_blank" rel="noreferrer">
              <Globe className="size-3" /> Website
            </a>
          </Button>
        ) : null}
        {result.sourceUrls.slice(0, 3).map((url) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:underline"
          >
            <Link2 className="size-3" />
            {hostnameForUrl(url)}
            <ExternalLink className="size-2.5" />
          </a>
        ))}
      </div>
      {/* Honest trust copy: machine findings stay unconfirmed until the user says so. */}
      <p className="mt-3 text-[11.5px] text-[var(--color-text-muted)]">
        Saved to {areaName} as unconfirmed findings — you can confirm or reject each one in Areas.
      </p>
    </div>
  );
}

function DoneStep({
  state,
  finishing,
  error,
  onFinish,
}: {
  state: WizardState;
  finishing: boolean;
  error: string | null;
  onFinish: () => void;
}) {
  const counts = wizardCounts(state);
  return (
    <div className="py-2 text-center">
      <div className="mx-auto grid size-11 place-items-center rounded-full bg-[var(--color-accent-soft)]">
        <Sparkles className="size-5 text-[var(--color-accent)]" />
      </div>
      <h3 className="mt-3 text-[15px] font-semibold tracking-tight">Albatross is listening now</h3>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-[var(--color-text-muted)]">
        {counts.areasCreated > 0
          ? `${counts.areasCreated} new ${counts.areasCreated === 1 ? 'area' : 'areas'} and ${counts.factsAdded} ${counts.factsAdded === 1 ? 'fact' : 'facts'} saved.`
          : `${counts.factsAdded} ${counts.factsAdded === 1 ? 'fact' : 'facts'} added to your areas.`}{' '}
        You can re-run this anytime from Settings.
      </p>
      {error ? <p className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</p> : null}
      <Button type="button" size="sm" className="mt-4" onClick={onFinish} disabled={finishing}>
        {finishing ? <Ring className="size-3" /> : <Check className="size-3.5" />}
        Done
      </Button>
    </div>
  );
}
