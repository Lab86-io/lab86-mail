'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { GuidedStepPane } from '@/components/albatross/GuidedStep';
import { StepRunPanel } from '@/components/albatross/StepRunPanel';
import { ReadyForYouList } from '@/components/report/ReadyForYou';
import { SavedSignInsRow } from '@/components/settings/SavedSignIns';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { ledgerRunLabel } from '@/lib/albatross/step-run-client';
import {
  handoffFixtures,
  questionFixture,
  type StepRunFixtureName,
  stepRunFixtures,
} from '@/lib/albatross/step-run-fixtures';

/* Dev-only harness: every step-run state from fixtures, so each one can be
 * seen and screenshotted without a backend. Query switches:
 *   ?state=<name>   one block only (eligible, blocked, queued, running,
 *                   readyDraft, readyDocument, approve, signIn, finishOnPage,
 *                   needsAnswer, offline, review, stoppedTime, stoppedCost,
 *                   failed, done, guidedAgent, guidedUser, brief, settings)
 * Not linked from anywhere; 404s outside development. */
export default function StepRunPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <StepRunPreviewInner />;
}

// A fixed clock keeps the log times the same in every screenshot.
const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);
const TIME_ZONE = 'UTC';

const RUN_STATES: StepRunFixtureName[] = [
  'queued',
  'running',
  'readyDraft',
  'readyDocument',
  'approve',
  'signIn',
  'finishOnPage',
  'needsAnswer',
  'offline',
  'review',
  'stoppedTime',
  'stoppedCost',
  'failed',
  'done',
];

const noop = () => undefined;

function Block({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <section data-preview-block={name} className="mb-8">
      <h2 className="mb-2 text-[11.5px] text-[var(--color-text-faint)]">{title}</h2>
      {children}
    </section>
  );
}

function StepRunPreviewInner() {
  useApplyThemeExtras();
  const params = useSearchParams();
  const only = params.get('state');
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const runs = stepRunFixtures(NOW);
  const show = (name: string) => !only || only === name;

  const panel = (name: StepRunFixtureName) => (
    <StepRunPanel
      run={runs[name]}
      stepDone={false}
      enabled
      runnable
      activeRun={runs[name].state === 'running' || runs[name].state === 'queued' ? runs[name] : null}
      question={name === 'needsAnswer' ? questionFixture : null}
      timeZone={TIME_ZONE}
      onStart={noop}
      onCancel={noop}
      onResume={noop}
      onDismiss={noop}
      onDiscuss={noop}
      onNext={noop}
      onAnswer={noop}
    />
  );

  const guidedSteps = [
    {
      id: 'step-1',
      title: 'Send the dispute letter to the insurer',
      detail: 'Use the dispute form on the insurer site. Stop before any payment.',
      url: 'https://example-insurer.com/claims/dispute',
      knows: ['The policy number', 'The claim reference'],
      needsYou: ['Sign in on the insurer site.'],
      done: false,
      mode: 'agent_does' as const,
      doneWhen: 'The site shows the dispute reference number.',
      runLabel: ledgerRunLabel(runs.running),
    },
    {
      id: 'step-2',
      title: 'Save the dispute reference in the claim folder',
      knows: [],
      needsYou: [],
      done: false,
      mode: 'agent_does' as const,
    },
  ];

  return (
    <QueryProvider clerkEnabled={false}>
      <main
        data-preview-state={ready ? 'ready' : 'loading'}
        className="mx-auto min-h-dvh max-w-3xl bg-[var(--color-bg)] px-6 py-8 text-[var(--color-text)]"
      >
        {show('eligible') ? (
          <Block name="eligible" title="Eligible step">
            <StepRunPanel
              run={null}
              stepDone={false}
              enabled
              runnable
              onStart={noop}
              onCancel={noop}
              onResume={noop}
              onDismiss={noop}
              onNext={noop}
            />
          </Block>
        ) : null}
        {show('blocked') ? (
          <Block name="blocked" title="Blocked: another step runs">
            <StepRunPanel
              run={null}
              stepDone={false}
              enabled
              runnable
              activeRun={runs.running}
              onStart={noop}
              onCancel={noop}
              onResume={noop}
              onDismiss={noop}
              onNext={noop}
            />
          </Block>
        ) : null}
        {RUN_STATES.filter(show).map((name) => (
          <Block key={name} name={name} title={`Run: ${name}`}>
            {panel(name)}
          </Block>
        ))}
        {show('guidedAgent') ? (
          <Block name="guidedAgent" title="Guided work: Albatross has the page">
            <div className="h-[560px] overflow-hidden rounded-xl border border-[var(--color-border)]">
              <GuidedStepPane
                steps={guidedSteps}
                activeId="step-1"
                onComplete={noop}
                onDiscuss={noop}
                session={{
                  sessionId: 'session_fixture',
                  status: 'agent',
                  statusDetail: 'Opening the dispute form',
                  liveViewUrl: 'about:blank',
                }}
                onVerifySession={noop}
                onEndSession={noop}
                runPanel={panel('running')}
                browser={{ line: 'Opening the dispute form', action: 'take_over', onTakeOver: noop }}
              />
            </div>
          </Block>
        ) : null}
        {show('guidedUser') ? (
          <Block name="guidedUser" title="Guided work: your turn on the page">
            <div className="h-[600px] overflow-hidden rounded-xl border border-[var(--color-border)]">
              <GuidedStepPane
                steps={guidedSteps.map((step) =>
                  step.id === 'step-1' ? { ...step, runLabel: ledgerRunLabel(runs.signIn) } : step,
                )}
                activeId="step-1"
                onComplete={noop}
                onDiscuss={noop}
                session={{
                  sessionId: 'session_fixture',
                  status: 'user',
                  statusDetail: 'Sign in on the page, then press Continue.',
                  liveViewUrl: 'about:blank',
                }}
                onVerifySession={noop}
                onEndSession={noop}
                runPanel={panel('signIn')}
                browser={{
                  line: 'Sign in on the page, then press Continue. Albatross never sees the password.',
                  action: 'continue',
                  onContinue: noop,
                }}
              />
            </div>
          </Block>
        ) : null}
        {show('brief') ? (
          <Block name="brief" title="Brief: Ready for you">
            <ReadyForYouList items={handoffFixtures(NOW)} onOpenWork={noop} onAct={noop} />
          </Block>
        ) : null}
        {show('settings') ? (
          <Block name="settings" title="Settings: Saved sign-ins">
            <SavedSignInsRow
              state={{ saved: true, createdAt: NOW - 9 * 86_400_000, lastUsedAt: NOW - 2 * 86_400_000 }}
              onForget={noop}
            />
            <div className="mt-4">
              <SavedSignInsRow state={{ saved: false }} onForget={noop} />
            </div>
          </Block>
        ) : null}
      </main>
    </QueryProvider>
  );
}
