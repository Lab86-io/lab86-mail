'use client';

// Two-column settings: a left rail of section tabs, one section in the pane.
// Research (Albatross contract): Mobbin/Perplexity settings
// (mobbin.com/screens/01930a76-50aa-48a9-bc02-b5eceefa17d0) and Mobbin/Melio
// settings (mobbin.com/screens/ac45719a-952f-44c6-9bcc-ce8ce1580b36) — text-only
// tab rails on the left, a single focused content pane on the right.

import { UserButton, useClerk, useUser } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useConvexAuth, useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TeachAreas } from '@/components/albatross/TeachAreas';
import { ConnectionLogo, ProviderLogo, providerDisplayName } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { NarrativeSettings } from '@/components/narrative/Narrative';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { AiSection } from '@/components/settings/AiSection';
import { SHORTCUTS } from '@/components/shell/ShortcutsSheet';
import { ThemePanel, useApplyThemeExtras } from '@/components/shell/ThemePanel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/convex/_generated/api';
import { settingsNavGroups } from '@/lib/albatross/settings-nav';
import { type SettingsTabId, settingsTabFromSearch } from '@/lib/albatross/teach-ui';
import { useClientStore } from '@/lib/client-state';
import { type NotificationPreferences, notificationPreferenceInput } from '@/lib/notifications/preferences';
import { DEFAULT_UNDO_SEND_SECONDS, UNDO_SEND_CHOICES } from '@/lib/shared/sending';
import { cn } from '@/lib/utils';

// useSearchParams needs a Suspense boundary for static generation.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageBody />
    </Suspense>
  );
}

const TAB_SECTIONS: Record<SettingsTabId, () => ReactNode> = {
  appearance: () => (
    <section>
      <SectionHeading
        title="Appearance"
        blurb="Make Albatross yours. Changes apply immediately; your existing palette and preferences stay intact."
      />
      <ThemePanel inline />
    </section>
  ),
  mailboxes: () => <MailboxesSection />,
  connections: () => <ConnectionsSection />,
  areas: () => <TeachAreas />,
  sending: () => <SendingSection />,
  notifications: () => <NotificationsSection />,
  ai: () => (
    <AiSection
      heading={
        <SectionHeading
          title="AI"
          blurb="Summaries, triage, drafts, and the daily brief. Use Lab86's hosted models or bring your own key."
        />
      }
    />
  ),
  narrative: () => <NarrativeSettings />,
  shortcuts: () => <ShortcutsSection />,
  advanced: () => <AdvancedSection />,
  account: () => <AccountSection />,
};

// Surfaces that are not part of the product's spine. The board is one: a place
// the user has to maintain, which is the opposite of what Albatross is for.
// It stays available for the people who want it, and off by default.
function AdvancedSection() {
  const boardEnabled = useClientStore((s) => s.boardSurfaceEnabled);
  const setBoardEnabled = useClientStore((s) => s.setBoardSurfaceEnabled);
  return (
    <section>
      <SectionHeading
        title="Advanced"
        blurb="Optional surfaces. Albatross does not need any of these to work."
        aside={boardEnabled ? 'Board on' : 'Nothing extra on'}
      />
      <SettingsCard>
        <SettingsRow
          id="board-surface"
          label="Show the board"
          description="A column board for the tasks behind your Albatrosses. Albatross keeps the plan either way; the board is a view, not a place you have to keep tidy."
          control={<Switch id="board-surface" checked={boardEnabled} onCheckedChange={setBoardEnabled} />}
        />
      </SettingsCard>
      <SettingsNote>Turning a surface off hides it from the rail. Nothing is deleted.</SettingsNote>
    </section>
  );
}

function SettingsPageBody() {
  useApplyThemeExtras();
  const searchParams = useSearchParams();
  // Local state owns the active tab; the URL mirrors it (replaceState, no
  // navigation) so /settings?tab=areas deep-links and refresh keeps its place.
  const [tab, setTab] = useState<SettingsTabId>(() => settingsTabFromSearch(searchParams.get('tab')));
  useEffect(() => {
    const connected = searchParams.get('mcp_connected');
    const error = searchParams.get('mcp_error');
    if (connected) toast.success(`${connected} connected`);
    if (error) toast.error(error);
    if (connected || error) {
      setTab('connections');
      window.history.replaceState(null, '', '/settings?tab=connections');
    }
  }, [searchParams]);
  const selectTab = (next: SettingsTabId) => {
    setTab(next);
    window.history.replaceState(null, '', `/settings?tab=${next}`);
  };

  return (
    <main className="app-paper relative min-h-dvh text-[var(--color-text)]">
      <DotGridGlow />
      <CommandPalette />
      <div className="relative z-10 mx-auto max-w-5xl px-5 py-8 sm:py-12">
        <header className="relative mb-8">
          <button
            type="button"
            onClick={() => useClientStore.getState().setPaletteOpen(true)}
            aria-label="Search everything"
            title="Search everything (⌘/Ctrl F or /)"
            className="absolute right-0 top-0 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <Search className="size-4" />
            Search
          </button>
          <Link
            href="/"
            className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <ArrowLeft className="size-3.5" />
            Back to Albatross
          </Link>
          <h1 className="text-[26px] font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-text-muted)]">
            Your mailboxes, your areas, and how Albatross behaves.
          </p>
        </header>
        <div className="flex flex-col gap-6 md:grid md:grid-cols-[210px_minmax(0,1fr)] md:gap-10">
          {/* Mobile: a horizontal scroller above the pane; md+: a sticky left
              rail in three groups, each tab with its one-line purpose. Text
              only, per the Albatross rail contract. */}
          <nav
            aria-label="Settings sections"
            className="-mx-5 flex gap-1 overflow-x-auto px-5 md:sticky md:top-8 md:mx-0 md:flex-col md:gap-5 md:self-start md:overflow-visible md:px-0"
          >
            {settingsNavGroups().map((group) => (
              <div key={group.id} className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
                <span className="hidden px-3 pb-1 text-[11px] font-medium text-[var(--color-text-faint)] md:block">
                  {group.label}
                </span>
                {group.items.map((item) => {
                  const active = tab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectTab(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'shrink-0 rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors md:w-full md:py-2',
                        active
                          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]',
                      )}
                    >
                      <span className="block leading-tight">{item.label}</span>
                      <span
                        className={cn(
                          'mt-0.5 hidden text-[11px] font-normal leading-snug md:block',
                          active ? 'text-[var(--color-accent)]/75' : 'text-[var(--color-text-faint)]',
                        )}
                      >
                        {item.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="min-w-0">{TAB_SECTIONS[tab]()}</div>
        </div>
      </div>
    </main>
  );
}

function SectionHeading({
  title,
  blurb,
  badge,
  aside,
}: {
  title: string;
  blurb: string;
  badge?: ReactNode;
  /** A short state read-out on the right: counts, saved, on or off. */
  aside?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-[var(--color-border)] pb-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
          {badge}
        </div>
        <p className="mt-0.5 max-w-xl text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          {blurb}
        </p>
      </div>
      {aside ? (
        <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--color-text-faint)]">{aside}</span>
      ) : null}
    </div>
  );
}

// The shared shape of a settings group: one card, one row per choice, the
// label and its consequence on the left, the control on the right.
function SettingsCard({
  children,
  tone = 'default',
  className,
}: {
  children: ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'divide-y divide-[var(--color-border)] rounded-xl border bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
        tone === 'danger' ? 'border-[var(--color-danger)]/30' : 'border-[var(--color-border)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

function SettingsRow({
  id,
  label,
  description,
  hint,
  control,
  disabled,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  /** A live read-out under the description: a status, a warning, a result. */
  hint?: ReactNode;
  control?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3',
        disabled && 'opacity-55',
      )}
    >
      <div className="min-w-0 flex-1 basis-60">
        {id ? (
          <Label htmlFor={id} className="text-[13px] font-medium">
            {label}
          </Label>
        ) : (
          <p className="text-[13px] font-medium">{label}</p>
        )}
        {description ? (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
        ) : null}
        {hint ? <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">{hint}</div> : null}
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  );
}

function SettingsGroupTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 mt-6 text-[12px] font-semibold text-[var(--color-text-muted)] first:mt-0">
      {children}
    </h3>
  );
}

function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{children}</p>;
}

// A small "Beta" pill for features that ship but aren't proven against real
// external services yet (the connectors haven't been verified end-to-end).
function BetaBadge() {
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
    >
      Beta
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (moved here from the rail's footer sheet)
// ---------------------------------------------------------------------------

function ShortcutsSection() {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? SHORTCUTS.filter(
        ([keys, label]) =>
          label.toLowerCase().includes(needle) || keys.some((key) => key.toLowerCase().includes(needle)),
      )
    : SHORTCUTS;
  return (
    <section>
      <SectionHeading
        title="Keyboard shortcuts"
        blurb="Everything is reachable without the mouse. Press ? anywhere to see this list."
        aside={`${SHORTCUTS.length} shortcuts`}
      />
      <div className="relative mb-3 max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-faint)]" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a shortcut"
          aria-label="Find a shortcut"
          className="h-8 pl-8 text-[12.5px]"
        />
      </div>
      <SettingsCard>
        {rows.length ? (
          <div className="grid grid-cols-1 gap-x-10 gap-y-1.5 p-4 text-[13px] sm:grid-cols-2">
            {rows.map(([keys, label]) => (
              <div key={label} className="flex items-center justify-between gap-3 py-0.5">
                <span className="text-[var(--color-text-muted)]">{label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-text)]"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
            No shortcut matches “{query.trim()}”.
          </p>
        )}
      </SettingsCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function SendingSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['prefs'],
    queryFn: async () => (await fetchJson('/api/prefs')).prefs as { undoSendSeconds: number },
  });
  const undoSendSeconds = data?.undoSendSeconds ?? DEFAULT_UNDO_SEND_SECONDS;

  const save = useMutation({
    mutationFn: async (seconds: number) => postJson('/api/prefs', { undoSendSeconds: seconds }),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['prefs'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save'),
  });

  const choice = UNDO_SEND_CHOICES.find((option) => option.value === undoSendSeconds);

  return (
    <section>
      <SectionHeading
        title="Sending"
        blurb="How long a sent email is held so you can change your mind."
        aside={save.isPending ? 'Saving…' : choice ? `Undo for ${choice.label.toLowerCase()}` : undefined}
      />
      <SettingsCard>
        <SettingsRow
          label="Undo send window"
          description="Albatross holds each send on the server for this long. An Undo toast stays on screen until the window closes."
          hint={
            undoSendSeconds
              ? `A message leaves ${choice ? choice.label.toLowerCase() : `${undoSendSeconds} seconds`} after you press Send.`
              : 'Messages leave the moment you press Send.'
          }
          control={
            <Select value={String(undoSendSeconds)} onValueChange={(value) => save.mutate(Number(value))}>
              <SelectTrigger size="sm" className="w-36" aria-label="Undo send window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {UNDO_SEND_CHOICES.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsCard>
      <SettingsNote>
        The window applies to every mailbox. Scheduled sends and replies from the brief use the same hold.
      </SettingsNote>
    </section>
  );
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

function clockLabel(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value;
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(2000, 0, 1, hours, minutes),
  );
}

function NotificationsSection() {
  const { isAuthenticated } = useConvexAuth();
  const remote = useConvexQuery(api.albatrossNotifications.getPreferences, isAuthenticated ? {} : 'skip') as
    | NotificationPreferences
    | undefined;
  const savePreferences = useConvexMutation(api.albatrossNotifications.savePreferences);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  // The last saved shape. Dirty means the form differs from it.
  const [baseline, setBaseline] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const deviceTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const timezones = useMemo(() => {
    try {
      const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
      return intl.supportedValuesOf?.('timeZone') ?? [];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (remote && !prefs) {
      const loaded = { ...remote, timezone: remote._id ? remote.timezone : deviceTimezone };
      setPrefs(loaded);
      setBaseline(loaded);
    }
  }, [deviceTimezone, prefs, remote]);

  const update = <K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) => {
    setPrefs((current) => (current ? { ...current, [key]: value } : current));
  };
  const dirty = Boolean(
    prefs &&
      baseline &&
      JSON.stringify(notificationPreferenceInput(prefs)) !==
        JSON.stringify(notificationPreferenceInput(baseline)),
  );

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      await savePreferences(notificationPreferenceInput(prefs));
      setBaseline(prefs);
      toast.success('Notification preferences saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save notification preferences');
    } finally {
      setSaving(false);
    }
  };

  const enablePush = async () => {
    if (!prefs || pushBusy) return;
    setPushBusy(true);
    setPushMessage(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('This browser does not support Web Push.');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notification permission was not granted.');
      const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!publicKey) throw new Error('Web Push is not configured on this deployment.');
      const registration = await navigator.serviceWorker.register('/albatross-sw.js');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const response = await fetch('/api/notifications/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not enable Web Push.');
      const next = { ...prefs, webPushEnabled: true };
      setPrefs(next);
      await savePreferences(notificationPreferenceInput(next));
      setBaseline((current) => (current ? { ...current, webPushEnabled: true } : current));
      setPushMessage('Web Push is enabled on this browser.');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : 'Could not enable Web Push.');
    } finally {
      setPushBusy(false);
    }
  };

  if (!prefs) return <p className="text-[12.5px] text-[var(--color-text-muted)]">Loading preferences…</p>;

  const zoneOptions = timezones.includes(prefs.timezone) ? timezones : [prefs.timezone, ...timezones];

  return (
    <section>
      <SectionHeading
        title="Notifications"
        blurb="Albatross asks instead of silently deciding what you finished. It reaches you in the app first, and by email only when a check-in goes unanswered."
        aside={dirty ? 'Unsaved changes' : 'Saved'}
      />
      <SettingsGroupTitle>Evening check-in</SettingsGroupTitle>
      <SettingsCard>
        <SettingsRow
          id="checkin-enabled"
          label="Evening check-in"
          description="Ask what actually moved today and carry an unanswered check-in into tomorrow’s brief."
          control={
            <Switch
              id="checkin-enabled"
              checked={prefs.eveningCheckinEnabled}
              onCheckedChange={(value) => update('eveningCheckinEnabled', value)}
            />
          }
        />
        <SettingsRow
          id="checkin-time"
          label="Check-in time"
          description={`Arrives at ${clockLabel(prefs.eveningCheckinLocalTime)} in ${prefs.timezone.replaceAll('_', ' ')}.`}
          disabled={!prefs.eveningCheckinEnabled}
          control={
            <Input
              id="checkin-time"
              className="w-32"
              type="time"
              value={prefs.eveningCheckinLocalTime}
              onChange={(event) => update('eveningCheckinLocalTime', event.target.value)}
            />
          }
        />
        <SettingsRow
          id="checkin-timezone"
          label="Timezone"
          description="The check-in and the morning brief follow this zone."
          hint={
            prefs.timezone === deviceTimezone ? (
              'Matches this device.'
            ) : (
              <button
                type="button"
                className="underline underline-offset-2 hover:text-[var(--color-text)]"
                onClick={() => update('timezone', deviceTimezone)}
              >
                Use this device’s zone ({deviceTimezone.replaceAll('_', ' ')})
              </button>
            )
          }
          control={
            zoneOptions.length > 1 ? (
              <Select value={prefs.timezone} onValueChange={(value) => update('timezone', value)}>
                <SelectTrigger id="checkin-timezone" size="sm" className="w-60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" className="max-h-72">
                  {zoneOptions.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone.replaceAll('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="checkin-timezone"
                className="w-60"
                value={prefs.timezone}
                onChange={(event) => update('timezone', event.target.value)}
              />
            )
          }
        />
      </SettingsCard>

      <SettingsGroupTitle>Where you hear about it</SettingsGroupTitle>
      <SettingsCard>
        <SettingsRow
          id="inapp-enabled"
          label="In-app notification center"
          description="Questions, check-ins, approvals, and updates together, behind the bell."
          control={
            <Switch
              id="inapp-enabled"
              checked={prefs.inAppEnabled}
              onCheckedChange={(value) => update('inAppEnabled', value)}
            />
          }
        />
        <SettingsRow
          label="Web Push"
          description="Permission is requested only when you enable it here. Each browser is enabled on its own."
          hint={pushMessage ?? (prefs.webPushEnabled ? 'Enabled on at least one browser.' : null)}
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pushBusy}
              onClick={() => void enablePush()}
            >
              {pushBusy ? 'Enabling…' : prefs.webPushEnabled ? 'Enable on this browser' : 'Enable'}
            </Button>
          }
        />
        <SettingsRow
          id="fallback-enabled"
          label="Fallback email"
          description="Email only when the check-in is still unanswered."
          control={
            <Switch
              id="fallback-enabled"
              checked={prefs.emailFallbackEnabled}
              onCheckedChange={(value) => update('emailFallbackEnabled', value)}
            />
          }
        />
        <SettingsRow
          id="fallback-delay"
          label="Fallback delay"
          description="How long Albatross waits after the check-in before the email goes out."
          disabled={!prefs.emailFallbackEnabled}
          control={
            <>
              <Input
                id="fallback-delay"
                className="w-24"
                type="number"
                min={15}
                max={1440}
                step={15}
                disabled={!prefs.emailFallbackEnabled}
                value={prefs.emailFallbackDelayMinutes}
                onChange={(event) => update('emailFallbackDelayMinutes', Number(event.target.value) || 90)}
              />
              <span className="text-[11.5px] text-[var(--color-text-muted)]">minutes</span>
            </>
          }
        />
      </SettingsCard>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {dirty ? (
          <Button variant="ghost" disabled={saving} onClick={() => baseline && setPrefs(baseline)}>
            Discard
          </Button>
        ) : null}
        <span className="text-[11.5px] text-[var(--color-text-faint)]">
          {dirty ? 'Changes apply after you save.' : 'Everything here is saved.'}
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

interface SyncState {
  accountId: string;
  status: string;
  corpusReady: boolean;
  messagesSynced?: number;
  error?: string;
}

function MailboxesSection() {
  const qc = useQueryClient();
  const { data: nylas } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () => fetchJson('/api/nylas/status'),
    refetchInterval: (query) =>
      (query.state.data?.syncStates || []).some(
        (s: SyncState) => !s.corpusReady && s.status !== 'error' && s.status !== 'idle',
      )
        ? 15_000
        : false,
  });

  const disconnect = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/nylas/disconnect', { accountId }),
    onSuccess: () => {
      toast.success('Account disconnected');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not disconnect account'),
  });
  const saveAlias = useMutation({
    mutationFn: async ({ accountId, displayName }: { accountId: string; displayName: string }) =>
      patchJson('/api/nylas/account', { accountId, displayName }),
    onSuccess: () => {
      toast.success('Alias saved');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not save alias'),
  });
  const resyncMail = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/mail/resync', { accountId }),
    onSuccess: () => {
      toast.success('Re-indexing started — the mailbox stays usable while it rebuilds');
      qc.invalidateQueries({ queryKey: ['nylas-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not start resync'),
  });
  const resyncCalendar = useMutation({
    mutationFn: async (accountId: string) => postJson('/api/calendar/resync', { accountId }),
    onSuccess: () => toast.success('Calendar resync started'),
    onError: (err: any) => toast.error(err?.message || 'Could not start calendar resync'),
  });

  const accounts: any[] = nylas?.accounts || [];
  const syncByAccount = new Map<string, SyncState>(
    ((nylas?.syncStates || []) as SyncState[]).map((s) => [s.accountId, s]),
  );
  const capabilities = (nylas?.capabilities || []).filter((c: any) => c.visible);
  const icloud = capabilities.find((c: any) => c.provider === 'icloud');

  return (
    <section>
      <SectionHeading
        title="Mailboxes"
        blurb="Every connected account is downloaded into your private search index. That is what makes search instant."
        aside={
          accounts.length
            ? `${accounts.length} ${accounts.length === 1 ? 'mailbox' : 'mailboxes'} · ${
                accounts.filter((account) => syncByAccount.get(account.accountId)?.corpusReady).length
              } indexed`
            : 'No mailboxes yet'
        }
      />
      <div className="space-y-2.5">
        {accounts.map((account) => (
          <MailboxCard
            key={account.accountId}
            account={account}
            sync={syncByAccount.get(account.accountId)}
            onSaveAlias={(displayName) => saveAlias.mutate({ accountId: account.accountId, displayName })}
            onResyncMail={() => resyncMail.mutate(account.accountId)}
            onResyncCalendar={() => resyncCalendar.mutate(account.accountId)}
            onDisconnect={() => {
              if (
                window.confirm(
                  `Disconnect ${account.email}? Its indexed mail is removed from Lab86 as part of disconnect.`,
                )
              ) {
                disconnect.mutate(account.accountId);
              }
            }}
            busy={disconnect.isPending || saveAlias.isPending}
          />
        ))}
        {!accounts.length ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
            No mailboxes yet — connect one below and watch the index fill up.
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {capabilities.map((capability: any) => (
          <Button
            key={capability.provider}
            variant="outline"
            size="sm"
            asChild={capability.connectable}
            disabled={!capability.connectable}
            className="gap-2"
          >
            {capability.connectable ? (
              <a href={`/api/nylas/connect?provider=${capability.provider}`}>
                <ProviderLogo provider={capability.provider} className="size-3.5" />
                Connect {capability.label}
                <Plus className="size-3 text-[var(--color-text-faint)]" />
              </a>
            ) : (
              <span>
                <ProviderLogo provider={capability.provider} className="size-3.5 opacity-50" />
                {capability.label}
              </span>
            )}
          </Button>
        ))}
      </div>
      {icloud ? (
        <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">
          {icloud.connectable
            ? 'iCloud needs an app-specific password — create one at appleid.apple.com, then connect.'
            : icloud.reason}
        </p>
      ) : null}
    </section>
  );
}

function MailboxCard({
  account,
  sync,
  onSaveAlias,
  onResyncMail,
  onResyncCalendar,
  onDisconnect,
  busy,
}: {
  account: any;
  sync?: SyncState;
  onSaveAlias: (displayName: string) => void;
  onResyncMail: () => void;
  onResyncCalendar: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState(account.displayName || '');
  const connected = account.status === 'connected';
  // Re-running OAuth on the same address upserts the existing grant with the
  // connector's current scope list — this is how an account picks up newly
  // added scopes (e.g. calendar) without being removed first.
  const reconnectHref = `/api/nylas/connect?provider=${account.provider}&redirectTo=/settings`;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] shadow-[var(--shadow-control)]">
        <ProviderLogo provider={account.provider} className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveAlias(alias);
              setEditing(false);
            }}
          >
            <Input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="Alias (e.g. Work)"
              className="h-7 w-44 text-[13px]"
              autoFocus
            />
            <Button type="submit" size="sm" variant="outline" className="h-7 px-2">
              <Check className="size-3" />
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium">{account.displayName || account.email}</span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="grid size-5 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
              title="Rename mailbox"
            >
              <Pencil className="size-3" />
            </button>
          </div>
        )}
        <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">
          {account.email} · {providerDisplayName(account.provider)}
        </div>
        <SyncStatusLine sync={sync} connected={connected} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            disabled={busy}
            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            title="Account actions"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => onResyncMail()} className="gap-2 text-[12.5px]">
            <RefreshCw className="size-3.5" />
            Re-index mail
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onResyncCalendar()} className="gap-2 text-[12.5px]">
            <CalendarDays className="size-3.5" />
            Resync calendar
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="gap-2 text-[12.5px]">
            <a href={reconnectHref}>
              <KeyRound className="size-3.5" />
              Reconnect / update permissions
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onDisconnect()}
            className="gap-2 text-[12.5px] text-[var(--color-danger)] focus:text-[var(--color-danger)]"
          >
            <Trash2 className="size-3.5" />
            Remove account & data
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SyncStatusLine({ sync, connected }: { sync?: SyncState; connected: boolean }) {
  if (!connected) {
    return <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">Disconnected</div>;
  }
  if (!sync || sync.status === 'idle') {
    return <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">Waiting for first sync</div>;
  }
  if (sync.status === 'error') {
    return (
      <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">
        Sync error — {sync.error || 'will retry automatically'}
      </div>
    );
  }
  const indexed = sync.messagesSynced ? `${sync.messagesSynced.toLocaleString()} messages` : null;
  if (sync.corpusReady) {
    return (
      <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="size-3" />
        Indexed{indexed ? ` · ${indexed}` : ''} — instant search ready
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--color-accent)]">
      <Loader2 className="size-3 animate-spin" />
      Downloading &amp; indexing{indexed ? ` · ${indexed} so far` : '…'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections (connected tools)
// ---------------------------------------------------------------------------

type McpServer = 'github' | 'bitbucket' | 'jira' | 'slack' | 'granola';

interface McpConnectionRow {
  connectionId: string;
  server: McpServer;
  serverUrl: string;
  status: 'connected' | 'disconnected' | 'error';
  displayName?: string;
  scopes: string[];
  includeInBrief: boolean;
  includeInSearch: boolean;
  lastSyncedAt?: number;
  error?: string;
  syncStatus?: 'idle' | 'syncing' | 'ready' | 'error';
  itemCount?: number;
  accountEmail?: string;
  workspaceName?: string;
  syncError?: string;
}

interface McpServerInfo {
  id: McpServer;
  label: string;
  tokenLabel: string;
  tokenHelp: string;
  connectMode: 'token' | 'oauth';
}

function relativeTime(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function ConnectionsSection() {
  const qc = useQueryClient();
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [nameInputs, setNameInputs] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ['mcp-status'],
    queryFn: async () => fetchJson('/api/mcp/status'),
  });

  const connect = useMutation({
    mutationFn: async ({
      server,
      token,
      displayName,
    }: {
      server: McpServer;
      token: string;
      displayName?: string;
    }) => postJson('/api/mcp/connect', { server, token, displayName }),
    onSuccess: (result, variables) => {
      if (result?.validation?.ok === false) {
        toast.error(`Saved, but validation failed: ${result.validation.error || 'check the token'}`);
      } else {
        toast.success('Connected');
      }
      setTokenInputs((prev) => ({ ...prev, [variables.server]: '' }));
      setNameInputs((prev) => ({ ...prev, [variables.server]: '' }));
      qc.invalidateQueries({ queryKey: ['mcp-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not connect'),
  });

  const resync = useMutation({
    mutationFn: async (connectionId: string) => postJson('/api/mcp/resync', { connectionId }),
    onSuccess: (result) => {
      if (result?.result?.ok === false) {
        toast.error(result.result.error || 'Resync failed');
      } else {
        toast.success('Resynced');
      }
      qc.invalidateQueries({ queryKey: ['mcp-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not start resync'),
  });

  const disconnect = useMutation({
    mutationFn: async (connectionId: string) => postJson('/api/mcp/disconnect', { connectionId }),
    onSuccess: () => {
      toast.success('Disconnected');
      qc.invalidateQueries({ queryKey: ['mcp-status'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not disconnect'),
  });

  const toggle = useMutation({
    mutationFn: async (body: { connectionId: string; includeInBrief?: boolean; includeInSearch?: boolean }) =>
      postJson('/api/mcp/toggle', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-status'] }),
    onError: (err: any) => toast.error(err?.message || 'Could not update'),
  });

  const connections: McpConnectionRow[] = data?.connections || [];
  const servers: McpServerInfo[] = data?.servers || [];
  const connectedServers = new Set(connections.map((c) => c.server));
  const availableServers = servers.filter((s) => !connectedServers.has(s.id));

  return (
    <section>
      <SectionHeading
        title="Connections"
        badge={<BetaBadge />}
        blurb="Bring GitHub, Granola, Bitbucket, Atlassian/Jira, and Slack into your brief, Areas, and search."
        aside={
          connections.length
            ? `${connections.length} connected · ${availableServers.length} available`
            : `${availableServers.length} available`
        }
      />
      <div className="space-y-2.5">
        {connections.map((connection) => (
          <div
            key={connection.connectionId}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]"
          >
            <div className="flex items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] shadow-[var(--shadow-control)]">
                <ConnectionLogo server={connection.server} className="size-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium capitalize">{connection.server}</span>
                  {connection.displayName ? (
                    <span className="truncate text-[12px] text-[var(--color-text-muted)]">
                      · {connection.displayName}
                    </span>
                  ) : null}
                </div>
                {connection.status === 'error' ? (
                  <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">
                    Connection error — {connection.error || 'will retry automatically'}
                  </div>
                ) : connection.status === 'connected' ? (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="size-3" />
                    Connected
                    {connection.lastSyncedAt ? ` · synced ${relativeTime(connection.lastSyncedAt)}` : ''}
                    {connection.itemCount !== undefined
                      ? ` · ${connection.itemCount.toLocaleString()} item${connection.itemCount === 1 ? '' : 's'}`
                      : ''}
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] font-medium text-[var(--color-danger)]">Disconnected</div>
                )}
                {connection.server === 'granola' && (connection.workspaceName || connection.accountEmail) ? (
                  <div className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">
                    {[connection.workspaceName, connection.accountEmail].filter(Boolean).join(' · ')}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => resync.mutate(connection.connectionId)}
                  disabled={resync.isPending}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  <RefreshCw className="size-3.5" />
                  Resync
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (window.confirm(`Disconnect ${connection.displayName || connection.server}?`)) {
                      disconnect.mutate(connection.connectionId);
                    }
                  }}
                  disabled={disconnect.isPending}
                  className="border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/60 text-[var(--color-danger)] hover:border-[var(--color-danger)]/45 hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                >
                  <Trash2 className="size-3.5" />
                  Disconnect
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--color-border)] pt-3">
              <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                <Switch
                  id={`brief-${connection.connectionId}`}
                  checked={connection.includeInBrief}
                  onCheckedChange={(checked) =>
                    toggle.mutate({ connectionId: connection.connectionId, includeInBrief: checked })
                  }
                />
                <Label
                  htmlFor={`brief-${connection.connectionId}`}
                  className="text-[12.5px] font-normal text-[var(--color-text-muted)]"
                >
                  In daily brief
                </Label>
              </div>
              <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                <Switch
                  id={`search-${connection.connectionId}`}
                  checked={connection.includeInSearch}
                  onCheckedChange={(checked) =>
                    toggle.mutate({ connectionId: connection.connectionId, includeInSearch: checked })
                  }
                />
                <Label
                  htmlFor={`search-${connection.connectionId}`}
                  className="text-[12.5px] font-normal text-[var(--color-text-muted)]"
                >
                  In search
                </Label>
              </div>
            </div>
          </div>
        ))}
      </div>

      {availableServers.length ? (
        <div className="mt-4 space-y-2.5">
          {availableServers.map((server) => {
            const token = tokenInputs[server.id] || '';
            if (server.connectMode === 'oauth') {
              return (
                <div
                  key={server.id}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]"
                >
                  <div className="flex items-center gap-3">
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] shadow-[var(--shadow-control)]">
                      <ConnectionLogo server={server.id} className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-medium">{server.label}</span>
                        <BetaBadge />
                      </div>
                      <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
                        {server.tokenHelp}
                      </p>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/mcp/oauth/start?server=${encodeURIComponent(server.id)}`}>
                        <Plus className="size-3.5" />
                        Connect
                      </a>
                    </Button>
                  </div>
                </div>
              );
            }
            return (
              <form
                key={server.id}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!token.trim()) return;
                  connect.mutate({
                    server: server.id,
                    token: token.trim(),
                    displayName: nameInputs[server.id]?.trim() || undefined,
                  });
                }}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]"
              >
                <div className="flex items-center gap-2">
                  <div className="grid size-7 shrink-0 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] shadow-[var(--shadow-control)]">
                    <ConnectionLogo server={server.id} className="size-3.5" />
                  </div>
                  <span className="text-[13.5px] font-medium">{server.label}</span>
                  <BetaBadge />
                </div>
                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-[12px]">{server.tokenLabel}</Label>
                    <Input
                      value={token}
                      onChange={(event) =>
                        setTokenInputs((prev) => ({ ...prev, [server.id]: event.target.value }))
                      }
                      placeholder={server.tokenLabel}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[12px]">Display name (optional)</Label>
                    <Input
                      value={nameInputs[server.id] || ''}
                      onChange={(event) =>
                        setNameInputs((prev) => ({ ...prev, [server.id]: event.target.value }))
                      }
                      placeholder="e.g. Work"
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">{server.tokenHelp}</p>
                <div className="mt-2.5">
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={!token.trim() || connect.isPending}
                  >
                    {connect.isPending ? <Ring className="size-3" /> : <Plus className="size-3.5" />}
                    Connect
                  </Button>
                </div>
              </form>
            );
          })}
        </div>
      ) : null}

      {!connections.length && !availableServers.length ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
          No connected tools available yet.
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountSection() {
  const qc = useQueryClient();
  const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const { user } = useUser();
  const clerk = useClerk();
  const [confirmText, setConfirmText] = useState('');

  const deleteAccount = useMutation({
    mutationFn: async () => check(await fetch('/api/account', { method: 'DELETE' })),
    onSuccess: () => {
      toast.success('Account deletion started');
      qc.clear();
      window.location.href = '/';
    },
    onError: (err: any) => toast.error(err?.message || 'Could not delete account'),
  });

  if (!clerkEnabled) return null;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const name = user?.fullName || user?.firstName || null;
  const since = user?.createdAt
    ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(user.createdAt)
    : null;
  const confirmed = confirmText.trim().toLowerCase() === 'delete';

  return (
    <section>
      <SectionHeading
        title="Account"
        blurb="Who is signed in, where the session lives, and the one action that cannot be undone."
        aside={since ? `Member since ${since}` : undefined}
      />
      <SettingsGroupTitle>Signed in</SettingsGroupTitle>
      <SettingsCard>
        <SettingsRow
          label={name || email || 'Your account'}
          description={name && email ? email : 'Signed in with Clerk.'}
          control={<UserButton appearance={{ elements: { avatarBox: 'size-8' } }} />}
        />
        <SettingsRow
          label="Profile and security"
          description="Name, email addresses, passkeys, and the devices signed in right now."
          control={
            <Button type="button" size="sm" variant="outline" onClick={() => clerk.openUserProfile()}>
              Open profile
            </Button>
          }
        />
        <SettingsRow
          label="Sign out"
          description="Ends the session on this browser only. Your data stays where it is."
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void clerk.signOut({ redirectUrl: '/sign-in' })}
            >
              Sign out
            </Button>
          }
        />
      </SettingsCard>

      <SettingsGroupTitle>Delete</SettingsGroupTitle>
      <SettingsCard tone="danger">
        <SettingsRow
          label="Delete everything"
          description="Mail grants, the search index, AI settings, usage records, and your Lab86 account. Gone for good, with no export first."
          control={
            <AlertDialog
              onOpenChange={(open) => {
                if (!open) setConfirmText('');
              }}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={deleteAccount.isPending}
                  className="shrink-0 border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/60 text-[var(--color-danger)] hover:border-[var(--color-danger)]/45 hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                >
                  {deleteAccount.isPending ? <Ring className="size-3" /> : null}
                  Delete account
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete your Albatross account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes every mailbox grant, the search index, your settings, and usage records from
                    Lab86. It cannot be undone. Type{' '}
                    <span className="font-mono font-medium text-[var(--color-text)]">delete</span> to confirm.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder="delete"
                  aria-label="Type delete to confirm"
                  autoComplete="off"
                  spellCheck={false}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep my account</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={!confirmed || deleteAccount.isPending}
                    onClick={() => deleteAccount.mutate()}
                    className="bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger)]/90"
                  >
                    Delete everything
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          }
        />
      </SettingsCard>
    </section>
  );
}

// ---------------------------------------------------------------------------

async function fetchJson(url: string) {
  return check(await fetch(url, { cache: 'no-store' }));
}

async function postJson(url: string, body: any) {
  return check(
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function patchJson(url: string, body: any) {
  return check(
    await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function check(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
