'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { SecureRequestCard, type SecureRequestState } from '@/components/ai-elements/secure-request-card';
import { AllowSecureBlock } from '@/components/albatross/thread/AllowSecureBlock';
import { RunBlock } from '@/components/albatross/thread/RunBlock';
import { SavedSignInsRow } from '@/components/settings/SavedSignIns';
import { SecureDetailsList, type SecureUsesState } from '@/components/settings/SecureDetailsList';
import { SecureItemForm, type SecureSheetRequest } from '@/components/settings/SecureItemSheet';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { SecretNotice } from '@/components/shell/SecretNotice';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import {
  allowRunFixture,
  SECURE_FIXTURE_IDS,
  secureItemsFixture,
  secureRequestFixture,
  secureUsesFixture,
  signInOfferRunFixture,
} from '@/lib/albatross/secure-fixtures';
import { secretNoticeCanSave } from '@/lib/albatross/secure-view';
import { threadDetailsFixture } from '@/lib/albatross/thread-fixtures';
import type { SecureItemCreate, SecureItemView } from '@/lib/secure/contract';
import type { SecretShapeKind } from '@/lib/secure/redact';

/* Dev-only harness: Passwords and IDs in every state, from fixtures, so each
 * one can be seen and screenshotted without a backend. Query switches:
 *   ?screen=settings | allow | card | notice | sheet
 *   &dark=1
 * Not linked from anywhere; 404s outside development. */
export default function SecurePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <QueryProvider clerkEnabled={false}>
      <SecurePreview />
    </QueryProvider>
  );
}

// A fixed clock keeps the times the same in every screenshot.
const NOW = Date.UTC(2026, 9, 8, 13, 46, 0);
const TIME_ZONE = 'UTC';
const noop = () => undefined;
const ok = async () => true;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fakeSave(body: SecureItemCreate): Promise<SecureItemView> {
  await wait(400);
  return {
    id: `item_${Date.now()}`,
    kind: body.kind,
    label: body.label ?? 'New item',
    sites: body.sites ?? [],
    hints: {},
    facts: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: null,
  };
}

function SecurePreview() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const screen = params.get('screen') ?? 'settings';
  const dark = params.get('dark') === '1';
  // next-themes owns the html class; set the theme through it so hydration keeps it.
  const { setTheme } = useTheme();
  useEffect(() => {
    setTheme(dark ? 'dark' : 'light');
  }, [dark, setTheme]);
  return (
    <main className="app-paper min-h-dvh text-[var(--color-text)]">
      <div className="mx-auto max-w-5xl px-5 py-8">
        {screen === 'settings' ? <SettingsScreen /> : null}
        {screen === 'allow' ? <AllowScreen /> : null}
        {screen === 'card' ? <CardScreen /> : null}
        {screen === 'notice' ? <NoticeScreen /> : null}
        {screen === 'sheet' ? <SheetScreen /> : null}
      </div>
    </main>
  );
}

function SettingsScreen() {
  const items = secureItemsFixture(NOW);
  const [openId, setOpenId] = useState<string | null>(SECURE_FIXTURE_IDS.license);
  const uses: Record<string, SecureUsesState> = {
    [SECURE_FIXTURE_IDS.license]: { status: 'ready', uses: secureUsesFixture(NOW) },
    [SECURE_FIXTURE_IDS.chase]: { status: 'ready', uses: [] },
  };
  return (
    <div className="mx-auto max-w-3xl">
      <SecureDetailsList
        items={items}
        now={NOW}
        timeZone={TIME_ZONE}
        openId={openId}
        onToggle={setOpenId}
        uses={uses}
        busy={null}
        onReplace={ok}
        onRename={ok}
        onRemoveSite={noop}
        onAddSite={ok}
        onDelete={noop}
        onAdd={noop}
        browser={
          <SavedSignInsRow state={{ saved: true, lastUsedAt: NOW - 3 * 60 * 60_000 }} onForget={noop} />
        }
      />
    </div>
  );
}

function AllowScreen() {
  const details = threadDetailsFixture(NOW).details;
  const items = secureItemsFixture(NOW);
  const pending = allowRunFixture(NOW);
  const common = {
    timeZone: TIME_ZONE,
    details,
    stepNumber: 2,
    onStop: noop,
    onResume: noop,
    onDismiss: noop,
    onStart: noop,
    onMarkDone: noop,
    onNext: noop,
    onAnswer: noop,
    onAllow: noop,
    onSaveSignIn: noop,
    onOpenSecureSettings: noop,
  };
  return (
    <div className="mx-auto flex max-w-[660px] flex-col gap-5">
      <Caption>Pending</Caption>
      <RunBlock run={pending} {...common} />
      <Caption>While the check runs</Caption>
      <RunBlock run={pending} {...common} busy="allow" allowBusy="once" />
      <Caption>After a closed check</Caption>
      <RunBlock
        run={pending}
        {...common}
        allowNote={{ text: 'The check did not finish. Nothing was allowed.', tone: 'quiet' }}
      />
      <Caption>Allowed once</Caption>
      <RunBlock run={allowRunFixture(NOW, 'once')} {...common} />
      <Caption>Always allowed</Caption>
      <RunBlock run={allowRunFixture(NOW, 'always')} {...common} />
      <Caption>Not allowed</Caption>
      <RunBlock run={allowRunFixture(NOW, 'deny')} {...common} />
      <Caption>Sign-in handoff with the save offer (V13)</Caption>
      <RunBlock run={signInOfferRunFixture(NOW)} {...common} secureItems={items} />
      <Caption>After the save</Caption>
      <RunBlock run={signInOfferRunFixture(NOW)} {...common} secureItems={items} signInSaved />
      <Caption>The block alone, closed</Caption>
      <div className="rounded-ui border border-[var(--color-border)] px-4 py-3">
        <AllowSecureBlock
          allow={pending.next?.allow as NonNullable<NonNullable<typeof pending.next>['allow']>}
          headline="Closed"
          answer={null}
          closed
          onAnswer={noop}
        />
      </div>
    </div>
  );
}

function CardScreen() {
  const items = secureItemsFixture(NOW);
  const states: SecureRequestState[] = ['pending', 'opening', 'saved', 'skipped'];
  return (
    <div className="mx-auto flex max-w-[520px] flex-col gap-5">
      {states.map((state) => (
        <div key={state} className="flex flex-col gap-2">
          <Caption>{state}</Caption>
          <SecureRequestCard
            input={secureRequestFixture}
            state={state}
            onAdd={noop}
            onSkip={noop}
            onOpenSettings={noop}
          />
        </div>
      ))}
      <Caption>Already saved</Caption>
      <SecureRequestCard
        input={{
          kind: 'sign_in',
          site: 'chase.com',
          reason: 'To pay the card bill, Albatross must sign in.',
        }}
        state="pending"
        existing={items[0]}
        onAdd={noop}
        onSkip={noop}
        onUseExisting={noop}
        onOpenSettings={noop}
      />
      <Caption>An ID request</Caption>
      <SecureRequestCard
        input={{
          kind: 'id_number',
          label: 'Passport',
          reason: 'The airline form asks for your passport number.',
        }}
        state="pending"
        onAdd={noop}
        onSkip={noop}
      />
    </div>
  );
}

function NoticeScreen() {
  const kinds: Array<{ kind: SecretShapeKind; draft: string; enabled: boolean }> = [
    { kind: 'ssn', draft: 'my number is 123-45-6789 for the form', enabled: true },
    // Built from parts, so secret scanners do not report the preview.
    {
      kind: 'api_key',
      draft: `use this key: ${['sk-', 'example', '0000000000000000'].join('')}`,
      enabled: true,
    },
    { kind: 'card', draft: 'pay with 4242 4242 4242 4242', enabled: true },
    { kind: 'ssn', draft: 'my number is 123-45-6789 (store off)', enabled: false },
  ];
  return (
    <div className="mx-auto flex max-w-[660px] flex-col gap-5">
      {kinds.map(({ kind, draft, enabled }) => (
        <div key={`${kind}:${enabled}`} className="flex flex-col gap-2">
          <Caption>
            {kind}
            {enabled ? '' : ', store off'}
          </Caption>
          <div className="rounded-ui border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] pt-1 pb-2.5 shadow-xs">
            <SecretNotice
              kind={kind}
              canSave={secretNoticeCanSave(kind, enabled)}
              onSave={noop}
              onSendWithout={noop}
            />
            <p className="px-3.5 pt-2.5 text-[13.5px]">{draft}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function SheetScreen() {
  const requests: SecureSheetRequest[] = [
    { kind: 'sign_in', site: 'springfieldwater.gov', label: 'Springfield Water' },
    { kind: 'id_number' },
    { kind: 'date_of_birth' },
    { kind: 'api_key', site: 'api.openai.com', label: 'OpenAI' },
  ];
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {requests.map((request) => (
        <div
          key={request.kind}
          className="flex flex-col rounded-ui border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]"
        >
          <SecureItemForm request={request} onSave={fakeSave} onCancel={noop} defaultNameOnId="Sam Rivera" />
        </div>
      ))}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium text-[var(--color-text-faint)]">{children}</p>;
}
