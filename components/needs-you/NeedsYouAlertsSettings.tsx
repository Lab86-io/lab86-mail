'use client';

import { useMutation } from 'convex/react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MailAlertsSettings } from '@/components/settings/MailAlertsSettings';
import { MailSettingsRow } from '@/components/settings/mail-settings-ui';
import { Switch } from '@/components/ui/switch';
import type { NotificationPreferences } from '@/lib/notifications/preferences';
import {
  type BrowserPushState,
  disableBrowserPush,
  enableBrowserPush,
  readBrowserPush,
} from '@/lib/notifications/web-push-client';
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

/** The description of the browser row. `null` is the moment before the browser answers. */
export function browserAlertsDescription(state: BrowserPushState | null): string {
  switch (state) {
    case 'on':
      return 'This browser shows each push, also when Albatross is closed.';
    case 'blocked':
      return 'This browser blocks alerts from Albatross. Allow them in the site settings of the browser, then reload this page.';
    case 'unsupported':
      return 'This browser cannot show alerts. Use a different browser, or use the iPhone or Mac app.';
    default:
      return 'Show each push in this browser, also when Albatross is closed. Each browser has its own setting.';
  }
}

/**
 * The switch of this browser. On means that this browser has an active
 * subscription: the same push goes to it, by the rules of the rows around it.
 */
export function BrowserAlertsRow({
  initialState = null,
  onEnabled,
}: {
  initialState?: BrowserPushState | null;
  /** Records the change in the settings form, as the Web Push row does. */
  onEnabled?: () => Promise<void>;
}) {
  const [state, setState] = useState<BrowserPushState | null>(initialState);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void readBrowserPush().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const onChange = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (enabled) {
        await enableBrowserPush();
        await onEnabled?.().catch(() => undefined);
      } else await disableBrowserPush();
      setState(enabled ? 'on' : 'off');
      toast.success(enabled ? 'Alerts are on in this browser' : 'Alerts are off in this browser');
    } catch (error) {
      setState(await readBrowserPush());
      toast.error(error instanceof Error ? error.message : 'Could not save this setting.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <MailSettingsRow
      id="needs-you-browser"
      label="Alerts in this browser"
      description={browserAlertsDescription(state)}
      control={
        <Switch
          id="needs-you-browser"
          checked={state === 'on'}
          disabled={busy || state === null || state === 'blocked' || state === 'unsupported'}
          onCheckedChange={(enabled) => void onChange(enabled)}
        />
      }
    />
  );
}

interface AlertsProps {
  timezone?: string;
  /** The saved preference row, with the flags of phase 1 when the server has them. */
  remote: NotificationPreferences | undefined;
  /** The browser row subscribed this browser. The settings form records it. */
  onBrowserPushEnabled?: () => Promise<void>;
}

function NeedsYouAlerts({ timezone, remote, onBrowserPushEnabled }: AlertsProps) {
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
        browserRow: <BrowserAlertsRow onEnabled={onBrowserPushEnabled} />,
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
