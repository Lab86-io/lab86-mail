'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ContentSettings } from '@/components/settings/ContentSettings';
import { JevDemo } from '@/components/settings/JevDemo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { type JevCorrection, type JevPreferences } from '@/lib/jev/contract';

export interface JevSettingsState {
  preferences: JevPreferences;
  corrections: JevCorrection[];
  configured: boolean;
  configurationMessage: string | null;
  model: string;
  classifier: ClassifierSettings;
  revision: number;
  counts: { accepted: number; uncertain: number; pending: number; unavailable: number };
  sampledThreads: number;
  sampleLimit: number;
  lastEvaluatedAt: number | null;
}
export interface ClassifierSettings {
  selectedId: string;
  revision: number;
  canChange: boolean;
  options: Array<{
    id: string;
    label: string;
    vendor: string;
    description: string;
    status: 'evaluated' | 'experimental';
    configured: boolean;
  }>;
}
export async function settingsRequest(body?: unknown) {
  const response = await fetch(
    '/api/jev/settings',
    body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || 'Classification settings could not load.');
  return result;
}
const controls: Array<{
  key: Exclude<keyof JevPreferences, 'followUpDays'>;
  label: string;
  description: string;
}> = [
  {
    key: 'enabled',
    label: 'Classify incoming mail',
    description: 'Keep conversation, reply, action, and waiting states up to date as mail arrives.',
  },
  {
    key: 'briefAccountChanges',
    label: 'Important account and booking changes',
    description: 'Include payment failures, cancellations, and other meaningful changes in your Brief.',
  },
  {
    key: 'briefNewsletters',
    label: 'Newsletters in the Brief',
    description: 'Allow informational digests to compete for a Brief highlight.',
  },
  {
    key: 'briefPromotions',
    label: 'Promotions in the Brief',
    description: 'Allow optional offers and event invitations to compete for a highlight.',
  },
  {
    key: 'searchRelevance',
    label: 'Rank search by relevance',
    description: 'Find the conversation or document you asked for, using recency after relevance.',
  },
  {
    key: 'showExplanations',
    label: 'Show why mail needs attention',
    description: 'Show the classification and its supporting message in the reader.',
  },
];

export function JevSettingsPanel({
  state,
  busy,
  error,
  onSave,
  onReprocess,
  onSelectClassifier,
}: {
  state: JevSettingsState;
  busy: boolean;
  error?: string;
  onSave: (preferences: JevPreferences, corrections: JevCorrection[], onSuccess?: () => void) => void;
  onReprocess: () => void;
  onSelectClassifier: (classifierId: string) => void;
}) {
  const [scope, setScope] = useState<JevCorrection['scope']>('sender');
  const [match, setMatch] = useState('');
  const [brief, setBrief] = useState<JevCorrection['brief']>('exclude');
  const normalizedMatch = scope === 'thread' ? match.trim() : match.trim().toLowerCase();
  const matchingCorrection = state.corrections.find(
    (rule) => rule.scope === scope && rule.match === normalizedMatch && !rule.accountId,
  );
  const selectClass =
    'rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-2 text-sm';
  return (
    <section aria-labelledby="jev-heading" className="space-y-6">
      <header>
        <div className="flex items-center justify-between gap-3">
          <h2 id="jev-heading" className="text-[17px] font-semibold">
            Classification
          </h2>
          <span className="text-xs text-[var(--color-text-muted)]">
            {!state.preferences.enabled ? 'Paused' : state.configured ? 'Connected' : 'Setup needed'}
          </span>
        </div>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          How Albatross organizes your mail, finds open requests, and chooses what belongs in your Brief.
        </p>
      </header>
      <ClassifierPicker
        classifier={state.classifier}
        busy={busy}
        selectClass={selectClass}
        onSelect={onSelectClassifier}
      />
      {!state.configured && (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm"
        >
          {state.configurationMessage}{' '}
          <Link href="/settings?tab=ai" className="underline">
            Open Intelligence settings
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        {controls.map((control) => (
          <div key={control.key} className="flex items-center justify-between gap-5 px-4 py-4">
            <label htmlFor={`jev-${control.key}`} className="min-w-0">
              <span className="block text-sm font-medium">{control.label}</span>
              <span
                id={`jev-${control.key}-help`}
                className="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]"
              >
                {control.description}
              </span>
            </label>
            <Switch
              id={`jev-${control.key}`}
              aria-label={control.label}
              aria-describedby={`jev-${control.key}-help`}
              checked={state.preferences[control.key]}
              disabled={busy}
              onCheckedChange={(checked) =>
                onSave({ ...state.preferences, [control.key]: checked }, state.corrections)
              }
            />
          </div>
        ))}
        <div className="flex items-center justify-between gap-5 px-4 py-4">
          <label htmlFor="jev-follow-up" className="text-sm">
            Surface waiting conversations after
          </label>
          <select
            id="jev-follow-up"
            className={selectClass}
            value={state.preferences.followUpDays}
            disabled={busy}
            onChange={(event) =>
              onSave(
                {
                  ...state.preferences,
                  followUpDays: Number(event.target.value) as JevPreferences['followUpDays'],
                },
                state.corrections,
              )
            }
          >
            {[1, 3, 7, 14].map((days) => (
              <option key={days} value={days}>
                {days} {days === 1 ? 'day' : 'days'}
              </option>
            ))}
          </select>
        </div>
      </div>
      <section aria-labelledby="jev-activity" className="space-y-3">
        <h3 id="jev-activity" className="text-sm font-medium">
          Classification activity
        </h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ['accepted', 'Classified'],
              ['uncertain', 'Needs context'],
              ['pending', 'Pending'],
              ['unavailable', 'Unavailable'],
            ] as const
          ).map(([key, label]) => (
            <div
              key={key}
              className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-3"
            >
              <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
              <dd className="mt-1 text-xl tabular-nums">{state.counts[key]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-[var(--color-text-muted)]">
          Recent {state.sampledThreads} threads, up to {state.sampleLimit}.{' '}
          {state.lastEvaluatedAt
            ? `Last classified ${new Date(state.lastEvaluatedAt).toLocaleString()}.`
            : 'No completed classifications yet.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !state.configured || !state.preferences.enabled}
          onClick={onReprocess}
        >
          Recheck existing mail
        </Button>
      </section>
      <JevDemo configured={state.configured} />
      <ContentSettings />
      <section aria-labelledby="jev-corrections" className="space-y-3">
        <h3 id="jev-corrections" className="text-sm font-medium">
          Your Brief corrections
        </h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Choose exactly what to include or exclude. Messages remain in your mailbox and searchable. A sender
          rule affects that address, not its whole domain.
        </p>
        {state.corrections.length ? (
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-control)] border border-[var(--color-border)]">
            {state.corrections.map((rule) => (
              <li key={rule.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <span className="block truncate">{rule.match}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {rule.scope} ·{' '}
                    {rule.brief === 'exclude' ? 'Keep out of Brief' : 'Include in Brief candidates'}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove correction for ${rule.match}`}
                  onClick={() =>
                    onSave(
                      state.preferences,
                      state.corrections.filter((item) => item.id !== rule.id),
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">No corrections yet.</p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!match.trim()) return;
            onSave(
              state.preferences,
              [
                ...state.corrections.filter((rule) => rule.id !== matchingCorrection?.id),
                {
                  id: matchingCorrection?.id || crypto.randomUUID(),
                  scope,
                  match: normalizedMatch,
                  brief,
                },
              ],
              () => {
                setMatch('');
                setScope('sender');
                setBrief('exclude');
              },
            );
          }}
        >
          <label className="space-y-1 text-xs">
            Match
            <select
              aria-label="Correction scope"
              className={`${selectClass} block`}
              value={scope}
              disabled={busy}
              onChange={(event) => setScope(event.target.value as JevCorrection['scope'])}
            >
              <option value="sender">Sender address</option>
              <option value="list">Mailing list ID</option>
              <option value="thread">Thread ID</option>
            </select>
          </label>
          <label htmlFor="jev-correction-value" className="min-w-40 flex-1 space-y-1 text-xs">
            Exact value
            <Input
              id="jev-correction-value"
              aria-label="Correction value"
              required
              value={match}
              disabled={busy}
              maxLength={500}
              placeholder={
                scope === 'sender'
                  ? 'athletics@example.edu'
                  : scope === 'list'
                    ? 'newsletter.example.edu'
                    : 'Thread identifier'
              }
              onChange={(event) => setMatch(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs">
            Brief
            <select
              aria-label="Correction behavior"
              className={`${selectClass} block`}
              value={brief}
              disabled={busy}
              onChange={(event) => setBrief(event.target.value as JevCorrection['brief'])}
            >
              <option value="exclude">Keep out</option>
              <option value="include">Include</option>
            </select>
          </label>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !match.trim() || (state.corrections.length >= 100 && !matchingCorrection)}
          >
            Add correction
          </Button>
        </form>
      </section>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        The classifier labels messages and keeps evidence for its results. It does not send replies, archive
        messages, or complete work. Your corrections take precedence. Mail needing more context remains
        available for review.
      </p>
    </section>
  );
}

function ClassifierPicker({
  classifier,
  busy,
  selectClass,
  onSelect,
}: {
  classifier: ClassifierSettings;
  busy: boolean;
  selectClass: string;
  onSelect: (classifierId: string) => void;
}) {
  const selected = classifier.options.find((option) => option.id === classifier.selectedId);
  return (
    <div className="space-y-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4">
      <div className="flex items-center justify-between gap-5">
        <label htmlFor="classifier-model" className="min-w-0">
          <span className="block text-sm font-medium">Classifier model</span>
          <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
            {classifier.canChange
              ? 'Applies to every account on this deployment.'
              : 'Chosen by the deployment operator.'}
          </span>
        </label>
        {classifier.canChange ? (
          <select
            id="classifier-model"
            className={selectClass}
            value={classifier.selectedId}
            disabled={busy}
            onChange={(event) => onSelect(event.target.value)}
          >
            {classifier.options.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.configured}>
                {option.label}
                {option.configured ? '' : ' (not configured)'}
              </option>
            ))}
          </select>
        ) : (
          <span id="classifier-model" className="text-sm">
            {selected?.label || classifier.selectedId}
          </span>
        )}
      </div>
      {selected && (
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
          {selected.vendor}. {selected.description}
          {selected.status === 'experimental' ? ' Not yet validated against the mail evaluation set.' : ''}
        </p>
      )}
      {classifier.canChange && (
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
          Switching rechecks the last 30 days and open requests. Current results stay visible until the new
          model replaces them.
        </p>
      )}
    </div>
  );
}

export function JevSection() {
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const query = useQuery<JevSettingsState>({
    queryKey: ['jev-settings'],
    queryFn: () => settingsRequest(),
    refetchInterval: 15_000,
  });
  const save = useMutation({
    mutationFn: settingsRequest,
    onSuccess: async (_data, variables: any) => {
      setNotice(
        variables.action === 'reprocess'
          ? 'Existing mail is queued for a background recheck.'
          : variables.action === 'selectClassifier'
            ? 'Classifier changed. Recent mail is queued for a recheck.'
            : 'Settings saved.',
      );
      await client.invalidateQueries({ queryKey: ['jev-settings'] });
      await Promise.all(
        ['threads', 'thread', 'daily-report', 'search', 'global-search'].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-[var(--color-text-muted)]">
        Loading classification settings…
      </p>
    );
  if (query.isError || !query.data)
    return (
      <div role="alert">
        <p>Classification settings could not load.</p>
        <Button variant="outline" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  return (
    <>
      <JevSettingsPanel
        state={query.data}
        busy={save.isPending}
        error={save.error?.message}
        onSave={(preferences, corrections, onSuccess) =>
          save.mutate(
            { action: 'save', preferences, corrections, revision: query.data.revision },
            { onSuccess },
          )
        }
        onReprocess={() => save.mutate({ action: 'reprocess' })}
        onSelectClassifier={(classifierId) =>
          save.mutate({
            action: 'selectClassifier',
            classifierId,
            revision: query.data.classifier.revision,
          })
        }
      />
      <p role="status" aria-live="polite" className="mt-3 text-xs text-[var(--color-text-muted)]">
        {notice}
      </p>
    </>
  );
}
