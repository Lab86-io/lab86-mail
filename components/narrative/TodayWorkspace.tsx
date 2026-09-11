'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckSquare,
  Droplets,
  FileText,
  GitPullRequest,
  Mail,
  MessageSquare,
  Play,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { shapeFinishes } from '@/components/albatross/shapes/ShapeFrame';
import { BriefResponse } from '@/components/report/BriefResponse';
import { WeatherWidget } from '@/components/tool-ui/weather-widget/runtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { resolveShape } from '@/lib/albatross/shape-policy';
import { useClientStore } from '@/lib/client-state';
import type { NarrativeWorkspace, WorkspaceSource, WorkspaceThread } from '@/lib/narrative/workspace';
import { workspaceResponseSchema } from '@/lib/narrative/workspace';
import { safeExternalUrl } from '@/lib/shared/url';

const control =
  'rounded-md px-2.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50';
export async function workspaceRequest(body: Record<string, unknown>) {
  const response = await fetch('/api/narrative/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result !== 'object' || Array.isArray(result))
    throw new Error(
      (!response.ok && typeof result?.error === 'string' && result.error) ||
        'Could not update Today. Please try again.',
    );
  if (body.action === 'generate') {
    const parsed = workspaceResponseSchema.safeParse(result);
    if (parsed.success) return parsed.data;
  } else if (result.ok === true) return result;
  throw new Error('Could not update Today. Please try again.');
}
export function openWorkspaceWork(workId: string, guided: boolean) {
  const state = useClientStore.getState();
  state.setGuidedWorkId(guided ? workId : null);
  state.setSelectedWorkId(workId);
  state.setPrimaryView('albatrosses');
}

export function TodayWorkspace({ at, revision }: { at: number; revision: number }) {
  const client = useQueryClient();
  const key = ['narrative', 'workspace', at, revision];
  const attempted = useRef<string | null>(null);
  const query = useQuery<NarrativeWorkspace>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/narrative/workspace?at=${at}`, { signal });
      if (!response.ok) throw new Error('Workspace unavailable');
      const parsed = workspaceResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error('Workspace unavailable');
      return parsed.data;
    },
    staleTime: 30_000,
    retry: false,
  });
  const generation = useMutation({
    mutationFn: () => workspaceRequest({ action: 'generate', at }),
    onSuccess: (data) => client.setQueryData(key, data),
  });
  useEffect(() => {
    if (
      !query.data?.enabled ||
      query.data.mode !== 'evidence' ||
      !query.data.threads.length ||
      attempted.current === query.data.stamp
    )
      return;
    attempted.current = query.data.stamp;
    generation.mutate();
  }, [query.data, generation.mutate]);
  if (query.isError)
    return (
      <p role="status" className="mt-5 text-xs text-[var(--color-text-muted)]">
        Your brief is ready; its working surface couldn’t load.{' '}
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className={control}
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </p>
    );
  if (!query.data?.enabled) return null;
  return (
    <section aria-label="Your working surface" className="mt-3.5 space-y-1.5" data-today-workspace>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold text-[var(--color-accent-2)]">From the story to the work</h2>
        <span role="status" className="text-[11px] text-[var(--color-text-faint)]">
          {generation.isPending
            ? 'Arranging your context…'
            : query.data.mode === 'generated'
              ? 'Composed for you'
              : 'Source-backed view'}
        </span>
      </div>
      {generation.isError || generation.data?.mode === 'evidence' ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          The layout writer is unavailable. Your source cards are still usable.{' '}
          <Button
            variant="ghost"
            size="sm"
            className={control}
            type="button"
            onClick={() => generation.mutate()}
          >
            Retry layout
          </Button>
        </p>
      ) : null}
      {query.data.threads.length ? (
        query.data.threads.map((thread) => (
          <WorkspaceThreadCard
            key={`${query.data.stamp}:${thread.id}`}
            thread={thread}
            at={at}
            stamp={query.data.stamp}
          />
        ))
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">
          No extra threads to surface. Your sources and existing brief remain available below.
        </p>
      )}
    </section>
  );
}

const sourceIcons = {
  meeting: CalendarDays,
  development: GitPullRequest,
  mail: Mail,
  work: CheckSquare,
  intention: MessageSquare,
  file: FileText,
  context: FileText,
};
const sourceLabels = {
  meeting: 'Meeting',
  development: 'Development',
  mail: 'Email',
  work: 'Work',
  intention: 'Your intention',
  file: 'File',
  context: 'Context',
};
export function workspaceSourceDate(at: number, timeZone?: string) {
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(at));
}
function SourceCard({ source }: { source: WorkspaceSource }) {
  const Icon = sourceIcons[source.kind];
  const date = workspaceSourceDate(source.occurredAt);
  const original = safeExternalUrl(source.originalUrl || '');
  return (
    <Card className="min-w-0 gap-0 bg-[var(--color-content)] p-1.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
        <Icon aria-hidden size={13} />
        <span>{sourceLabels[source.kind]}</span>
        {date ? (
          <time dateTime={date} className="ml-auto">
            {date}
          </time>
        ) : null}
      </div>
      <Link
        href={source.href}
        className="block text-[12px] font-medium leading-snug underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2"
      >
        {source.title}
      </Link>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        {source.excerpt}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-faint)]">
        <Badge variant="secondary" className="text-[10px] font-normal">
          {source.trust === 'reported'
            ? 'User-reported'
            : source.trust === 'inferred'
              ? 'Interpretation'
              : 'Source record'}
        </Badge>
        {original ? (
          <a
            href={original}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2"
          >
            Original
            <ArrowUpRight aria-hidden size={11} />
          </a>
        ) : null}
      </div>
    </Card>
  );
}
export function WorkspaceThreadCard({
  thread,
  at,
  stamp,
}: {
  thread: WorkspaceThread;
  at: number;
  stamp: string;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const correctionInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (correcting) correctionInput.current?.focus();
  }, [correcting]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const open =
    thread.work && !completed && !['done', 'archived', 'released', 'paused'].includes(thread.work.state);
  async function save(action: 'defer' | 'correct' | 'done') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'done' && thread.work) {
        const response = await fetch(`/api/albatross/work/${encodeURIComponent(thread.work.id)}/state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: 'done' }),
        });
        if (!response.ok) throw new Error('Could not mark this work done. Please try again.');
        setCompleted(true);
        setFeedback('Marked done. Your work record has been updated.');
      } else {
        await workspaceRequest({
          at,
          stamp,
          sourceIds: thread.sources.map((s) => s.id),
          action,
          ...(action === 'correct' ? { note } : {}),
        });
        setFeedback(
          action === 'defer'
            ? 'Not today. Your choice is saved in narrative memory; the work itself is unchanged.'
            : 'Correction saved in narrative memory.',
        );
      }
      setCorrecting(false);
      // Do not erase the acknowledgement by immediately replacing this card.
      await client.invalidateQueries({ queryKey: ['narrative', 'brief'], refetchType: 'none' });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save feedback.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="gap-0 overflow-hidden bg-[var(--color-content)] py-0" data-today-thread>
      <CardContent className="p-2 sm:p-2.5">
        <h3 className="font-display text-[19px] leading-snug">{thread.title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">{thread.summary}</p>
        <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {thread.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
        <div className="mt-2 flex items-start gap-1.5">
          {thread.work ? (
            <CheckSquare aria-hidden size={16} className="mt-0.5 shrink-0 text-[var(--color-accent-2)]" />
          ) : (
            <ArrowRight aria-hidden size={16} className="mt-0.5 shrink-0 text-[var(--color-accent-2)]" />
          )}
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-[var(--color-text-faint)]">
              {thread.work
                ? `${thread.work.shape || 'Existing work'} · ${completed ? 'done' : thread.work.state}`
                : 'Suggested next step · not a task yet'}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed">
              {(!completed && thread.work?.nextStep) || thread.work?.title || thread.nextStep}
            </p>
          </div>
        </div>
        {thread.work ? (
          <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">Suggestion: {thread.nextStep}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {thread.work ? (
            <Button
              size="sm"
              type="button"
              className="text-xs"
              onClick={() => openWorkspaceWork(thread.work!.id, !!open && thread.work!.guided)}
            >
              <Play aria-hidden size={12} />
              {open && thread.work.guided ? 'Open guided work' : 'Open work'}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className={control}
              onClick={() =>
                useClientStore
                  .getState()
                  .openCaptureWith(
                    `${thread.nextStep}\n\nContext: ${thread.title}\n${thread.sources.map((s) => `${s.title}: ${s.href}`).join('\n')}`,
                  )
              }
            >
              Review & create work
            </Button>
          )}
          {!feedback ? (
            <>
              {open && shapeFinishes(resolveShape(thread.work?.shape)) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  className={control}
                  onClick={() => void save('done')}
                >
                  Mark work done
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy}
                className={control}
                onClick={() => void save('defer')}
              >
                Not today
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy}
                aria-expanded={correcting}
                className={control}
                onClick={() => setCorrecting(!correcting)}
              >
                That’s wrong
              </Button>
            </>
          ) : null}
        </div>
        <BriefResponse
          reference={{ at, stamp, threadId: thread.id, recommendation: thread.nextStep }}
          title={thread.title}
        />
        {correcting ? (
          <form
            className="mt-1.5 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save('correct');
            }}
          >
            <label className="block text-xs" htmlFor={`correction-${thread.id}`}>
              What should the narrative know instead?
            </label>
            <Textarea
              id={`correction-${thread.id}`}
              ref={correctionInput}
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="min-h-20 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-base sm:text-sm"
            />
            <Button
              variant="ghost"
              size="sm"
              type="submit"
              disabled={busy || !note.trim()}
              className={control}
            >
              {busy ? 'Saving…' : 'Save correction'}
            </Button>
          </form>
        ) : null}
        {feedback ? (
          <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-[var(--color-text-muted)]">
            <Check aria-hidden size={14} />
            {feedback}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1.5 text-xs text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const weatherConditionSchema = z.enum([
  'clear',
  'partly-cloudy',
  'cloudy',
  'overcast',
  'fog',
  'drizzle',
  'rain',
  'heavy-rain',
  'thunderstorm',
  'snow',
  'sleet',
  'hail',
  'windy',
]);
const weatherResponseSchema = z.object({
  asOf: z.number().finite(),
  weather: z
    .object({
      location: z.string(),
      timezone: z.string().optional(),
      unit: z.enum(['°F', '°C']),
      current: z.object({
        temp: z.number().finite(),
        condition: z.string(),
        conditionCode: weatherConditionSchema.optional(),
        windSpeed: z.number().finite().optional(),
        high: z.number().finite(),
        low: z.number().finite(),
      }),
      daily: z.array(
        z.object({
          day: z.string().optional(),
          condition: weatherConditionSchema.optional(),
          high: z.number().finite().optional(),
          low: z.number().finite().optional(),
          precipChance: z.number().finite().nullable().optional(),
        }),
      ),
      source: z.string().optional(),
      attributionURL: z.string().optional(),
    })
    .nullable(),
});
export async function weatherRequest(signal?: AbortSignal) {
  const response = await fetch('/api/brief/weather', { signal });
  if (!response.ok) throw new Error('Weather unavailable');
  const parsed = weatherResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Weather unavailable');
  return parsed.data;
}
export function weatherLocalTime(asOf: number, timezone?: string): number | undefined {
  if (!timezone) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(asOf);
    return (
      (Number(parts.find((part) => part.type === 'hour')?.value) * 60 +
        Number(parts.find((part) => part.type === 'minute')?.value)) /
      1440
    );
  } catch {
    return undefined;
  }
}
export function TodayWeather({ variant = 'card' }: { variant?: 'card' | 'masthead' }) {
  const query = useQuery({
    queryKey: ['brief', 'weather'],
    queryFn: ({ signal }) => weatherRequest(signal),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const weather = query.data?.weather;
  if (variant === 'masthead') {
    const attribution = safeExternalUrl(weather?.attributionURL || '');
    const precipitation = weather?.daily[0]?.precipChance;
    const hasPrecipitation = typeof precipitation === 'number' && precipitation >= 0 && precipitation <= 100;
    return (
      <section
        data-brief-header-weather
        aria-label="Current weather"
        className="max-w-full font-sans text-[11px] leading-relaxed text-white/90 [text-shadow:0_1px_8px_rgba(0,0,0,0.75)]"
      >
        {weather ? (
          <div className="flex max-w-full flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-center">
            {attribution ? (
              <a
                href={attribution}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-white/35 underline-offset-2 hover:decoration-white"
                title={weather.source || 'Forecast source'}
              >
                {weather.location}
              </a>
            ) : (
              <span>{weather.location}</span>
            )}
            <span className="text-[16px] tabular-nums">
              {weather.current.temp}
              {weather.unit}
            </span>
            <span>{weather.current.condition}</span>
            <span className="whitespace-nowrap tabular-nums">
              High {weather.current.high}° · Low {weather.current.low}°
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
              <Droplets aria-hidden className="size-3" />
              <span aria-hidden>
                {hasPrecipitation ? `Precip. ${Math.round(precipitation)}%` : 'Precip. unavailable'}
              </span>
              <span className="sr-only">
                {hasPrecipitation
                  ? `Chance of precipitation today: ${Math.round(precipitation)} percent`
                  : 'Precipitation forecast unavailable'}
              </span>
            </span>
          </div>
        ) : (
          <span role="status">
            {query.isPending ? 'Checking the weather…' : 'Weather unavailable'}
            {!query.isPending ? (
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="ml-2 underline underline-offset-2"
              >
                Retry
              </button>
            ) : null}
          </span>
        )}
      </section>
    );
  }
  if (!weather)
    return (
      <div className="mb-5 flex items-center gap-2 text-xs text-[var(--color-text-faint)]">
        <span>{query.isPending ? 'Checking the weather…' : 'Weather unavailable'}</span>
        {!query.isPending ? (
          <Button
            variant="ghost"
            size="sm"
            className={control}
            type="button"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  const attribution = safeExternalUrl(weather.attributionURL || '');
  return (
    <aside aria-label="Current weather" className="mb-6 space-y-2" data-today-weather>
      {weather.current.conditionCode ? (
        <WeatherWidget
          version="3.1"
          id="today-weather"
          location={{ name: weather.location }}
          units={{ temperature: weather.unit === '°F' ? 'fahrenheit' : 'celsius' }}
          current={{
            conditionCode: weather.current.conditionCode,
            temperature: weather.current.temp,
            tempMin: weather.current.low,
            tempMax: weather.current.high,
            windSpeed: weather.current.windSpeed,
          }}
          forecast={weather.daily.flatMap((day) =>
            day.day && day.condition && day.low !== undefined && day.high !== undefined
              ? [{ label: day.day, conditionCode: day.condition, tempMin: day.low, tempMax: day.high }]
              : [],
          )}
          time={{ localTimeOfDay: weatherLocalTime(query.data!.asOf, weather.timezone) }}
          updatedAt={new Date(query.data!.asOf).toISOString()}
          effects={{ quality: 'auto' }}
          className="w-full max-w-none [&>[data-slot=card]]:aspect-auto [&>[data-slot=card]]:h-[280px]"
        />
      ) : (
        <Card className="gap-1 p-3 text-sm">
          <p>
            {weather.location} · {weather.current.temp}
            {weather.unit} · {weather.current.condition}
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            H {weather.current.high}° · L {weather.current.low}°
          </p>
        </Card>
      )}
      {weather.daily[0]?.precipChance != null ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">Rain {weather.daily[0].precipChance}%</p>
      ) : null}
      {attribution ? (
        <a
          className="inline-block text-[10px] text-[var(--color-text-faint)] underline underline-offset-2"
          href={attribution}
          target="_blank"
          rel="noopener noreferrer"
        >
          {weather.source || 'Forecast source'}
        </a>
      ) : null}
    </aside>
  );
}
