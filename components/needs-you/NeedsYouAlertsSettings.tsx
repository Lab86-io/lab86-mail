'use client';

import { useMutation } from 'convex/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MailAlertsSettings } from '@/components/settings/MailAlertsSettings';
import type { NotificationPreferences } from '@/lib/notifications/preferences';
import { setObligationPush, useNeedsYouSnapshot } from './data';
import { NeedsYouGate } from './NeedsYouGate';

/** The two Needs you flags as the saved preference row carries them. */
export function needsYouFlagsOf(remote: unknown): { pushEnabled: boolean; codesEnabled: boolean } {
  const row = (remote ?? {}) as { obligationPushEnabled?: boolean; oneTimeCodeAutofillEnabled?: boolean };
  return {
    pushEnabled: row.obligationPushEnabled !== false,
    codesEnabled: row.oneTimeCodeAutofillEnabled !== false,
  };
}

/**
 * Saves the codes switch through the mobile preferences route, the path the
 * iPhone app uses: read the row, change one flag, write it back.
 */
export async function saveCodesEnabled(enabled: boolean, fetcher: typeof fetch = fetch): Promise<void> {
  const read = await fetcher('/api/mobile/preferences', { method: 'POST' });
  const current = await read.json().catch(() => null);
  if (!read.ok || !current?.ok) throw new Error('Could not read the current settings.');
  const write = await fetcher('/api/mobile/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...current.preferences, oneTimeCodeAutofillEnabled: enabled }),
  });
  const result = await write.json().catch(() => null);
  if (!write.ok || !result?.ok) throw new Error(result?.error || 'Could not save this setting.');
}

interface AlertsProps {
  timezone?: string;
  /** The saved preference row, with the flags of phase 1 when the server has them. */
  remote: NotificationPreferences | undefined;
}

function NeedsYouAlerts({ timezone, remote }: AlertsProps) {
  const snapshot = useNeedsYouSnapshot();
  const save = useMutation(setObligationPush);
  const [local, setLocal] = useState<{ pushEnabled?: boolean; codesEnabled?: boolean }>({});
  const [saving, setSaving] = useState(false);
  if (!snapshot?.enabled) return <MailAlertsSettings timezone={timezone} />;
  const flags = needsYouFlagsOf(remote);
  const pushEnabled = local.pushEnabled ?? flags.pushEnabled;
  const codesEnabled = local.codesEnabled ?? flags.codesEnabled;

  const onPushEnabledChange = async (enabled: boolean) => {
    setLocal((current) => ({ ...current, pushEnabled: enabled }));
    setSaving(true);
    try {
      // Only this field: a settings save that is not done yet keeps its own values.
      await save({ enabled });
      toast.success(enabled ? 'Pushes are on' : 'Pushes are off');
    } catch (error) {
      setLocal((current) => ({ ...current, pushEnabled: undefined }));
      toast.error(error instanceof Error ? error.message : 'Could not save this setting.');
    } finally {
      setSaving(false);
    }
  };
  const onCodesEnabledChange = async (enabled: boolean) => {
    setLocal((current) => ({ ...current, codesEnabled: enabled }));
    setSaving(true);
    try {
      await saveCodesEnabled(enabled);
      toast.success(enabled ? 'Codes push at once' : 'Codes do not push');
    } catch (error) {
      setLocal((current) => ({ ...current, codesEnabled: undefined }));
      toast.error(error instanceof Error ? error.message : 'Could not save this setting.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MailAlertsSettings
      timezone={timezone}
      needsYou={{
        pushEnabled,
        onPushEnabledChange: (enabled) => void onPushEnabledChange(enabled),
        codesEnabled,
        onCodesEnabledChange: (enabled) => void onCodesEnabledChange(enabled),
        saving,
      }}
    />
  );
}

/** Settings, Notifications: the Needs you rows for a flag user, the mail alerts for everyone else. */
export function NeedsYouAlertsSettings(props: AlertsProps) {
  return (
    <NeedsYouGate fallback={<MailAlertsSettings timezone={props.timezone} />}>
      <NeedsYouAlerts {...props} />
    </NeedsYouGate>
  );
}
