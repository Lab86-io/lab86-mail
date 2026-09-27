'use client';

// Daily Brief delivery (FEATURES items 3, 6, 9). Research: Mobbin/Klaviyo
// notification schedule (mobbin.com/screens/9c81deb8-8d8d-4954-9a35-060e2e2304c1)
// and Mobbin/Canny digest cadence (mobbin.com/screens/5cb5cf25-7261-4ec6-a2be-dcf1bfa80652):
// one row per choice, the time as a select next to the zone it follows, and a
// disabled email switch that says why. The rows keep the Settings card rhythm.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { callTool } from '@/lib/api-client';
import type { BriefPreferences, BriefPreferencesInput } from '@/lib/brief/preferences';
import { BRIEF_DELIVERY_HOURS, type BriefWeekendMode, briefHourLabel } from '@/lib/brief/schedule';
import { cn } from '@/lib/utils';

export const BRIEF_WEEKEND_COPY: Record<BriefWeekendMode, { label: string; detail: string }> = {
  full: { label: 'Full edition', detail: 'Saturday and Sunday get the same edition as a weekday.' },
  light: {
    label: 'Light edition',
    detail: 'Replies owed, today, and your calendar. Waiting and FYI sections stay out.',
  },
  off: { label: 'No edition', detail: 'Nothing arrives on Saturday or Sunday.' },
};

const QUERY_KEY = ['brief-preferences'] as const;

/** One sentence that says when the next editions arrive. Exported for tests. */
export function briefScheduleSummary(
  preferences: Pick<BriefPreferences, 'deliveryHour' | 'weekendMode' | 'weeklyReview' | 'timezone'>,
) {
  const at = briefHourLabel(preferences.deliveryHour);
  const zone = preferences.timezone ? ` ${preferences.timezone.replaceAll('_', ' ')} time` : '';
  const weekend =
    preferences.weekendMode === 'off'
      ? 'No edition on Saturday'
      : preferences.weekendMode === 'light'
        ? 'A light edition on Saturday'
        : 'The full edition on Saturday';
  const sunday = preferences.weeklyReview
    ? 'the weekly review on Sunday'
    : preferences.weekendMode === 'off'
      ? 'none on Sunday'
      : 'the same on Sunday';
  return `Weekdays at ${at}${zone}. ${weekend}, and ${sunday}.`;
}

export function BriefSection() {
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () =>
      (await callTool<{ preferences: BriefPreferences }>('get_brief_preferences', {})).preferences,
  });
  const save = useMutation({
    mutationFn: async (input: BriefPreferencesInput) =>
      (await callTool<{ preferences: BriefPreferences }>('save_brief_preferences', input)).preferences,
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
      toast.success('Brief delivery saved');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not save the brief delivery settings.'),
  });

  if (preferences.isPending)
    return <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading brief delivery…</p>;
  if (preferences.isError || !preferences.data)
    return (
      <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
        The brief delivery settings could not load.{' '}
        <button type="button" className="underline" onClick={() => void preferences.refetch()}>
          Try again
        </button>
      </p>
    );

  const prefs = preferences.data;
  const busy = save.isPending;
  return (
    <section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-[var(--color-border)] pb-4">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold tracking-tight">Daily Brief</h2>
          <p className="mt-0.5 max-w-xl text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            {briefScheduleSummary(prefs)}
          </p>
        </div>
        <span className="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">
          {busy ? 'Saving…' : 'Saved'}
        </span>
      </div>

      <h3 className="mb-2 text-[12px] font-semibold text-[var(--color-text-muted)]">Delivery</h3>
      <BriefCard>
        <BriefRow
          id="brief-hour"
          label="Delivery time"
          description={
            prefs.timezone
              ? `In ${prefs.timezone.replaceAll('_', ' ')}. The zone comes from Notifications.`
              : 'In your calendar zone once it syncs. You can set the zone in Notifications.'
          }
          control={
            <Select
              value={String(prefs.deliveryHour)}
              disabled={busy}
              onValueChange={(value) => save.mutate({ deliveryHour: Number(value) })}
            >
              <SelectTrigger id="brief-hour" size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {BRIEF_DELIVERY_HOURS.map((hour) => (
                  <SelectItem key={hour} value={String(hour)}>
                    {briefHourLabel(hour)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <BriefRow
          id="brief-weekend"
          label="Weekends"
          description={BRIEF_WEEKEND_COPY[prefs.weekendMode].detail}
          control={
            <Select
              value={prefs.weekendMode}
              disabled={busy}
              onValueChange={(value) => save.mutate({ weekendMode: value as BriefWeekendMode })}
            >
              <SelectTrigger id="brief-weekend" size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(Object.keys(BRIEF_WEEKEND_COPY) as BriefWeekendMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {BRIEF_WEEKEND_COPY[mode].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <BriefRow
          id="brief-weekly"
          label="Weekly review on Sunday"
          description="What you finished, what is still open, who you wait on, and next week, with Defer and Drop on each item. It replaces the Sunday edition."
          control={
            <Switch
              id="brief-weekly"
              checked={prefs.weeklyReview}
              disabled={busy}
              onCheckedChange={(value) => save.mutate({ weeklyReview: value })}
            />
          }
        />
      </BriefCard>

      <h3 className="mb-2 mt-6 text-[12px] font-semibold text-[var(--color-text-muted)]">Email</h3>
      <BriefCard>
        <BriefRow
          id="brief-email"
          label="Send each edition by email"
          description="The edition goes to your sign-in address, with links back to each item."
          hint={prefs.email.available ? null : prefs.email.reason}
          disabled={!prefs.email.available}
          control={
            <Switch
              id="brief-email"
              checked={prefs.emailEnabled}
              disabled={busy || !prefs.email.available}
              onCheckedChange={(value) => save.mutate({ emailEnabled: value })}
            />
          }
        />
      </BriefCard>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
        A missed delivery tries again each hour for four hours. Write a new edition from Today at any time.
      </p>
    </section>
  );
}

function BriefCard({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]">
      {children}
    </div>
  );
}

function BriefRow({
  id,
  label,
  description,
  hint,
  control,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  hint?: ReactNode;
  control: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3',
        disabled && 'opacity-70',
      )}
    >
      <div className="min-w-0 flex-1 basis-60">
        <Label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </Label>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
        {hint ? (
          <p data-brief-setting-hint className="mt-1 text-[11px] text-[var(--color-text-faint)]">
            {hint}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}
