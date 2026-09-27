'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  MailSettingsCard,
  MailSettingsGroupTitle,
  MailSettingsNote,
  MailSettingsRow,
} from '@/components/settings/mail-settings-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { MailPushSettings } from '@/lib/notifications/mail-push';
import { timeZoneLabel } from '@/lib/notifications/preferences';

export const MAIL_PUSH_QUERY_KEY = ['mail-push-settings'] as const;

export type MailPushUpdate = {
  mode?: MailPushSettings['mode'];
  quietHours?: Partial<MailPushSettings['quietHours']>;
  vipSenders?: string[];
  addVipSenders?: string[];
  removeVipSenders?: string[];
};

/**
 * Saves mail alerts. `zone` is the notification zone that quiet hours use; it
 * is written only when the user has no preference row yet. Without it, the
 * device zone goes.
 */
export async function saveMailPushSettings(update: MailPushUpdate, zone?: string): Promise<MailPushSettings> {
  let timezone: string | undefined = zone;
  if (!timezone) {
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = undefined;
    }
  }
  const response = await fetch('/api/mail/push-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...update, ...(timezone ? { timezone } : {}) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not save mail alerts.');
  return data.settings as MailPushSettings;
}

/** "10 PM" for 22. */
export function hourLabel(hour: number) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * Priority-only push, quiet hours, and VIP senders (FEATURES item 12).
 * `timezone` is the saved notification zone: quiet hours are labeled with it
 * and saves send it, so the page shows one zone.
 */
export function MailAlertsSettings({ timezone }: { timezone?: string } = {}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: MAIL_PUSH_QUERY_KEY,
    queryFn: async () => {
      const response = await fetch('/api/mail/push-settings', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'Mail alerts could not load.');
      return data.settings as MailPushSettings;
    },
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (update: MailPushUpdate) => saveMailPushSettings(update, timezone),
    onSuccess: (next) => {
      queryClient.setQueryData(MAIL_PUSH_QUERY_KEY, next);
      toast.success('Mail alerts saved');
    },
    onError: (error: Error) => toast.error(error.message || 'Could not save mail alerts.'),
  });
  const [vipInput, setVipInput] = useState('');

  if (settings.isLoading) {
    return (
      <section>
        <MailSettingsGroupTitle>Mail alerts</MailSettingsGroupTitle>
        <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading mail alerts…</p>
      </section>
    );
  }
  if (settings.error || !settings.data) {
    return (
      <section>
        <MailSettingsGroupTitle>Mail alerts</MailSettingsGroupTitle>
        <p className="text-[12.5px] text-[var(--color-danger)]">
          Mail alerts could not load. Reload to try again.
        </p>
      </section>
    );
  }
  const current = settings.data;
  const quiet = current.quietHours;
  const addVip = () => {
    const value = vipInput.trim();
    if (!value) return;
    save.mutate({ addVipSenders: [value] }, { onSuccess: () => setVipInput('') });
  };

  return (
    <section>
      <MailSettingsGroupTitle aside={current.mode === 'priority' ? 'Priority only' : 'Every new email'}>
        Mail alerts
      </MailSettingsGroupTitle>
      <MailSettingsCard>
        <MailSettingsRow
          label="Push for"
          description={
            current.mode === 'priority'
              ? 'VIP senders, urgent mail, and mail that needs your reply or an action push at once. Everything else arrives in one summary push, at most once an hour.'
              : 'Every new email pushes to your iPhone and Mac.'
          }
          control={
            <Select
              value={current.mode}
              disabled={save.isPending}
              onValueChange={(mode) => save.mutate({ mode: mode as MailPushSettings['mode'] })}
            >
              <SelectTrigger size="sm" className="w-40" aria-label="Which mail pushes">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">Every new email</SelectItem>
                <SelectItem value="priority">Priority only</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <MailSettingsRow
          id="mail-quiet-hours"
          label="Quiet hours"
          description="No mail pushes in these hours, except from VIP senders. What arrives waits for one summary when quiet hours end."
          hint={`Hours use your notification time zone (${timeZoneLabel(timezone ?? current.timezone)}).`}
          control={
            <Switch
              id="mail-quiet-hours"
              checked={quiet.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) => save.mutate({ quietHours: { enabled } })}
            />
          }
        >
          {quiet.enabled ? (
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
              <span>From</span>
              <HourSelect
                label="Quiet hours start"
                value={quiet.start}
                disabled={save.isPending}
                onChange={(start) => save.mutate({ quietHours: { start } })}
              />
              <span>to</span>
              <HourSelect
                label="Quiet hours end"
                value={quiet.end}
                disabled={save.isPending}
                onChange={(end) => save.mutate({ quietHours: { end } })}
              />
              {quiet.start === quiet.end ? (
                <span className="text-[var(--color-danger)]">Choose two different hours.</span>
              ) : null}
            </div>
          ) : null}
        </MailSettingsRow>
        <MailSettingsRow
          label="VIP senders"
          description="Mail from these addresses or domains always pushes, in quiet hours too."
        >
          {current.vipSenders.length ? (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {current.vipSenders.map((entry) => (
                <li
                  key={entry}
                  className="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-subtle)] py-0.5 pl-2.5 pr-1 text-[12px]"
                >
                  {entry}
                  <button
                    type="button"
                    aria-label={`Remove ${entry}`}
                    disabled={save.isPending}
                    onClick={() => save.mutate({ removeVipSenders: [entry] })}
                    className="grid size-5 place-items-center rounded-full text-[var(--color-text-faint)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addVip();
            }}
          >
            <Input
              value={vipInput}
              onChange={(event) => setVipInput(event.target.value)}
              placeholder="ann@example.com or @example.com"
              aria-label="Add a VIP sender"
              className="h-8 max-w-72 text-[12.5px]"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!vipInput.trim() || save.isPending}>
              Add
            </Button>
          </form>
        </MailSettingsRow>
      </MailSettingsCard>
      <MailSettingsNote>
        These settings apply to mail pushes on iPhone and Mac. You can also mark a sender as VIP from the More
        menu of a thread.
      </MailSettingsNote>
    </section>
  );
}

function HourSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (hour: number) => void;
}) {
  return (
    <Select value={String(value)} disabled={disabled} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger size="sm" className="w-24" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {HOURS.map((hour) => (
          <SelectItem key={hour} value={String(hour)}>
            {hourLabel(hour)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
