'use client';

// Conversational area setup — the Areas tab in settings. The agent interviews
// the user about the parts of their life, investigates real mail evidence, and
// records facts under the trust model. Replaces the retired modal wizard.
//
// Research (Albatross contract — research before code):
// - Mobbin/Base44 build chat (mobbin.com/screens/7e6acf41-e32f-4628-b83b-e9b4dc06aecb):
//   the assistant's question renders as an inline card with tappable options and a
//   free-text escape hatch — exactly the ask_user shape.
// - Mobbin/Wix ADI setup chat (mobbin.com/screens/1d7665df-7eee-4fd6-aecc-a70c73043d3f):
//   assistant asks, user answers in bubbles, and recorded results surface as quiet
//   structured cards inside the same transcript, ending in a summary.
// - Mobbin/Sana AI onboarding (mobbin.com/screens/a287a759-5602-4ca1-b17f-408dc4192691)
//   and Chatbase setup (mobbin.com/screens/6c22e0e3-47b0-4910-aaf9-b31364015f84): the
//   assistant speaks first with one plain invitation, not an empty input.
//
// The chat stack mirrors components/shell/AIBar.tsx (the house pattern):
// useChat + DefaultChatTransport('/api/agent'), ask_user answers returned via
// addToolResult, debounced autosave to /api/chats. One deliberate divergence:
// extraSystem rides in the TRANSPORT body, not per-sendMessage, so ask_user
// auto-continues keep the Teach persona too.

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { ArrowUp, Check, Square } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AskAnswer, AskUserForm } from '@/components/ai-elements/choice-prompt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChatContainerContent, ChatContainerRoot } from '@/components/ui/chat-container';
import { Loader } from '@/components/ui/loader';
import { Markdown } from '@/components/ui/markdown';
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from '@/components/ui/prompt-input';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { TEACH_SYSTEM_PROMPT } from '@/lib/albatross/teach-prompt';
import {
  factRowFromToolOutput,
  isTeachChatSession,
  senderCardsFromToolOutput,
  TEACH_CHAT_TITLE,
  TEACH_PANE_INITIAL,
  type TeachFactRow,
  teachPaneReducer,
  toolPartName,
} from '@/lib/albatross/teach-ui';
import { cn } from '@/lib/utils';

export function TeachAreas() {
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-4">
          <h2 className="text-[16px] font-semibold tracking-tight">Areas</h2>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">
            The parts of your life Albatross files mail, events, and tasks against. Teach it in conversation —
            it checks your actual mail and asks before it records anything.
          </p>
        </div>
        <TeachChat />
      </section>
      <AreaManagementList />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Teach chat
// ---------------------------------------------------------------------------

function newTeachChatId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    `teach${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  );
}

// The seeded opener is rendered locally and never persisted: the real thread
// starts with the user's first reply, so the saved transcript stays clean.
const TEACH_OPENER =
  'What parts of your life are you responsible for? A job, a family, a property, a side project — name one and I will check your mail for it.';

function TeachChat() {
  const [input, setInput] = useState('');
  const [pane, dispatch] = useReducer(teachPaneReducer, TEACH_PANE_INITIAL);

  // TEACH_SYSTEM_PROMPT lives in the transport body so EVERY request carries
  // it — including the automatic continuation after an ask_user answer, which
  // sends no per-message body.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/agent',
        body: {
          extraSystem: TEACH_SYSTEM_PROMPT,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error, setMessages, addToolResult, regenerate } = useChat({
    transport,
    // Auto-continue ONLY after the user answers an ask_user question — same
    // rationale as AIBar: the server runs ordinary tools to completion in one
    // response, so the built-in predicate would resubmit in a loop.
    sendAutomaticallyWhen: ({ messages: msgs }) => {
      const last = msgs[msgs.length - 1] as any;
      if (!last || last.role !== 'assistant') return false;
      return (last.parts || []).some(
        (p: any) => toolPartName(p) === 'ask_user' && p.state === 'output-available',
      );
    },
  });

  const answerAskUser = useCallback(
    (toolCallId: string, answers: AskAnswer[]) => {
      void addToolResult({ tool: 'ask_user', toolCallId, output: { answers } });
    },
    [addToolResult],
  );

  // --- Session: one persisted conversation, found again by its reserved title ---
  const sessionIdRef = useRef<string | null>(null);
  const probedRef = useRef(false);
  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    (async () => {
      try {
        const listRes = await fetch('/api/chats');
        const listData = await listRes.json();
        const teach = ((listData?.sessions || []) as Array<{ _id: string; title?: string }>).find(
          isTeachChatSession,
        );
        if (teach) {
          const res = await fetch(`/api/chats?id=${encodeURIComponent(teach._id)}`);
          const data = await res.json();
          if (data?.ok && Array.isArray(data.session?.messages)) {
            sessionIdRef.current = teach._id;
            setMessages(data.session.messages);
            dispatch({ type: 'loaded', messageCount: data.session.messages.length });
            return;
          }
        }
      } catch {
        // History is best-effort; a failed probe just starts fresh.
      }
      dispatch({ type: 'loaded', messageCount: 0 });
    })();
  }, [setMessages]);

  // Autosave once the stream settles, always under the reserved title so the
  // next visit finds this exact thread again.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return;
    if (!messages.length || !sessionIdRef.current) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    const id = sessionIdRef.current;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, title: TEACH_CHAT_TITLE, messages }),
      }).catch(() => undefined);
    }, 600);
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
  }, [messages, status]);

  // Empty-completion recovery, same as AIBar: some models intermittently
  // return a zero-token turn; retry it transparently a couple of times.
  const emptyRetryCount = useRef(0);
  useEffect(() => {
    if (status !== 'ready') return;
    const last = messages[messages.length - 1] as any;
    if (!last || last.role !== 'assistant') return;
    if (hasRenderableContent(last)) {
      emptyRetryCount.current = 0;
      return;
    }
    if (emptyRetryCount.current >= 2) return;
    emptyRetryCount.current += 1;
    void regenerate();
  }, [status, messages, regenerate]);

  const streaming = status === 'streaming' || status === 'submitted';

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    emptyRetryCount.current = 0;
    if (!sessionIdRef.current) sessionIdRef.current = newTeachChatId();
    dispatch({ type: 'send' });
    setInput('');
    sendMessage({ text });
  };

  const submit = () => {
    if (streaming) {
      stop();
      return;
    }
    send();
  };

  if (!pane.loaded) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">
        <Loader variant="typing" />
        Loading the Teach conversation…
      </div>
    );
  }

  // The compact strip: same thread, one tap away.
  if (pane.collapsed) {
    return (
      <button
        type="button"
        onClick={() => dispatch({ type: 'expand' })}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-left shadow-[var(--shadow-soft)] transition-colors hover:border-[var(--color-accent)]"
      >
        <span className="block text-[13px] font-medium text-[var(--color-text)]">Teach Albatross more</span>
        <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">
          Same conversation as before — it remembers what you already covered.
        </span>
      </button>
    );
  }

  const last = messages[messages.length - 1] as any;
  const showLoader = streaming && (last?.role !== 'assistant' || !hasRenderableContent(last));

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3.5 py-2">
        <span className="text-[12.5px] font-medium text-[var(--color-text)]">Teach conversation</span>
        {messages.length ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'collapse' })}
            className="text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            Done for now
          </button>
        ) : null}
      </div>

      <ChatContainerRoot className="h-[420px] bg-[var(--color-bg)]/25">
        <ChatContainerContent className="gap-3.5 px-3.5 py-4">
          {messages.length === 0 ? <AssistantBubble>{TEACH_OPENER}</AssistantBubble> : null}
          {messages.map((message: any) =>
            message.role === 'user' ? (
              <UserBubble key={message.id} message={message} />
            ) : (
              <div key={message.id} className="flex w-full min-w-0 flex-col gap-2">
                {(message.parts || []).map((part: any, i: number) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: streamed parts are append-only with no stable id
                  <TeachPart key={`${message.id}-${i}`} part={part} onAskAnswer={answerAskUser} />
                ))}
              </div>
            ),
          )}
          {showLoader ? (
            <div className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-[var(--color-text-muted)]">
              <Loader variant="typing" />
            </div>
          ) : null}
          {error ? (
            <div className="space-y-1.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
              <div>{error.message}</div>
              <button
                type="button"
                onClick={() => regenerate()}
                className="rounded border border-[var(--color-danger)]/40 px-2 py-0.5 font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/15"
              >
                Continue
              </button>
            </div>
          ) : null}
        </ChatContainerContent>
      </ChatContainerRoot>

      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)]/45 p-2.5">
        <PromptInput
          value={input}
          onValueChange={setInput}
          isLoading={streaming}
          onSubmit={submit}
          maxHeight={140}
          className="border-[var(--color-control-border)] bg-[var(--color-control)] shadow-[var(--shadow-control)]"
        >
          <PromptInputTextarea
            placeholder={messages.length ? 'Reply…' : 'Name a part of your life…'}
            className="text-[13px] leading-relaxed text-[var(--color-text)]"
          />
          <PromptInputActions className="justify-end pt-1">
            <PromptInputAction tooltip={streaming ? 'Stop' : 'Send'}>
              <Button
                type="button"
                size="icon-sm"
                onClick={submit}
                disabled={!streaming && !input.trim()}
                className="rounded-full"
                aria-label={streaming ? 'Stop' : 'Send'}
              >
                {streaming ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>
    </div>
  );
}

// Reasoning parts are intentionally not rendered in the Teach pane, so they
// must not count as "visible" — otherwise the typing loader would vanish
// while the model thinks silently.
function hasRenderableContent(message: any): boolean {
  if (!message) return false;
  if (message.role === 'user') return true;
  for (const part of message.parts || []) {
    const type = part?.type;
    if (type === 'text' && (part.text || '').trim()) return true;
    if (typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')) return true;
  }
  return false;
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[92%] text-[13px] leading-relaxed text-[var(--color-text)]">{children}</div>;
}

function UserBubble({ message }: { message: any }) {
  const text =
    typeof message?.content === 'string'
      ? message.content
      : ((message?.parts || []) as any[])
          .filter((p) => p?.type === 'text')
          .map((p) => p.text || '')
          .join('');
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-[var(--color-bg-muted)] px-3.5 py-2 text-[13px] leading-relaxed text-[var(--color-text)]">
        {text || '(empty)'}
      </div>
    </div>
  );
}

// Progress lines for the read-only investigation tools.
const TEACH_STEP_VERBS: Record<string, { working: string; done: string }> = {
  area_domain_activity: { working: 'Checking recent senders', done: 'Checked recent senders.' },
  corpus_search: { working: 'Searching your mail', done: 'Searched your mail.' },
  sender_profile: { working: 'Looking up the sender', done: 'Looked up the sender.' },
  area_list: { working: 'Checking saved areas', done: 'Checked saved areas.' },
};

function TeachPart({
  part,
  onAskAnswer,
}: {
  part: any;
  onAskAnswer: (toolCallId: string, answers: AskAnswer[]) => void;
}) {
  const type = part?.type;
  if (type === 'text') {
    const text = part.text || '';
    if (!text.trim()) return null;
    return (
      <AssistantBubble>
        <Markdown className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[var(--color-text)] dark:prose-invert [&_a]:text-[var(--color-accent)]">
          {text}
        </Markdown>
      </AssistantBubble>
    );
  }
  if (typeof type !== 'string' || (!type.startsWith('tool-') && type !== 'dynamic-tool')) return null;

  const name = toolPartName(part);
  const state = part.state || 'input-available';
  const working = state !== 'output-available' && state !== 'output-error';

  if (name === 'ask_user') {
    if (state === 'input-streaming') return null;
    const questions = Array.isArray(part.input?.questions) ? part.input.questions : [];
    if (!questions.length) return null;
    const answered = state === 'output-available';
    const answers = Array.isArray(part.output?.answers) ? part.output.answers : [];
    return (
      <AskUserForm
        questions={questions}
        answered={answered}
        answers={answers}
        onSubmit={(a) => onAskAnswer(part.toolCallId, a)}
      />
    );
  }

  if (state === 'output-error') {
    return (
      <div className="px-1 text-[11.5px] text-[var(--color-danger)]">
        {part.errorText || 'That step ran into a problem.'}
      </div>
    );
  }

  if (name === 'area_domain_activity') {
    if (working) return <StepLine text="Checking recent senders…" working />;
    return <SenderCards input={part.input} output={part.output} />;
  }

  const factRow = working ? null : factRowFromToolOutput(name, part.input, part.output);
  if (factRow) return <FactConfirmationRow row={factRow} />;

  const verbs = TEACH_STEP_VERBS[name];
  if (working) return <StepLine text={`${verbs?.working || name.replaceAll('_', ' ')}…`} working />;
  if (verbs) return <StepLine text={verbs.done} />;
  // Mutating area tools with a failed/absent summary, plus any other tool:
  // one quiet completed line, no JSON.
  return <StepLine text="Done." />;
}

function StepLine({ text, working }: { text: string; working?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-1 text-[11.5px] text-[var(--color-text-faint)]',
        working && 'text-[var(--color-text-muted)]',
      )}
    >
      {working ? <Loader variant="typing" /> : null}
      <span>{text}</span>
    </div>
  );
}

// area_domain_activity result: the evidence itself, as sender cards — initials
// avatar, name, address, thread count, freshest subject. The agent's follow-up
// question ("coworkers?") arrives as its own ask_user part.
function SenderCards({ input, output }: { input: any; output: any }) {
  const cards = senderCardsFromToolOutput(output);
  const scope = input?.domain || input?.senderEmail || '';
  if (!cards.length) {
    return <StepLine text={scope ? `No recent senders found for ${scope}.` : 'No recent senders found.'} />;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      {scope ? (
        <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          Recent senders — {scope}
        </div>
      ) : null}
      {cards.map((card) => (
        <div
          key={card.email}
          className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[10px] font-semibold text-[var(--color-accent)]">
            {card.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                {card.name || card.email}
              </span>
              {card.name ? (
                <span className="truncate text-[11px] text-[var(--color-text-faint)]">{card.email}</span>
              ) : null}
            </span>
            {card.lastSubject ? (
              <span className="block truncate text-[11.5px] text-[var(--color-text-muted)]">
                {card.lastSubject}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
            {card.threads} thread{card.threads === 1 ? '' : 's'}
          </span>
        </div>
      ))}
    </div>
  );
}

// Quiet confirmation for recorded changes ("CardHunt created", "Verified: …").
function FactConfirmationRow({ row }: { row: TeachFactRow }) {
  return (
    <div className="flex items-center gap-1.5 px-1 text-[12px]">
      {row.tone === 'verified' ? (
        <Check className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            row.tone === 'created' && 'bg-[var(--color-accent)]',
            row.tone === 'candidate' && 'border border-[var(--color-text-faint)]',
            row.tone === 'retired' && 'bg-[var(--color-text-faint)]',
          )}
        />
      )}
      <span
        className={cn(
          'min-w-0 truncate',
          row.tone === 'retired' ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-text-muted)]',
        )}
      >
        {row.text}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Area management list — live rows under the chat
// ---------------------------------------------------------------------------

interface AreaOverviewRow {
  _id: Id<'areas'>;
  name: string;
  kind: string;
  status: string;
  description?: string;
  factCounts: { verified: number; candidate: number };
}

function AreaManagementList() {
  // Skip until the Clerk token has reached the Convex client — first-paint
  // queries otherwise run unauthenticated and throw server-side.
  const { isAuthenticated } = useConvexAuth();
  const areas = useQuery(api.albatross.listAreasOverview, isAuthenticated ? { status: 'active' } : 'skip') as
    | AreaOverviewRow[]
    | undefined;
  const archiveArea = useMutation(api.albatross.archiveArea);
  const [busyId, setBusyId] = useState<string | null>(null);

  const archive = async (area: AreaOverviewRow) => {
    if (!window.confirm(`Archive ${area.name}? Its history is kept — nothing is deleted.`)) return;
    setBusyId(area._id);
    try {
      await archiveArea({ areaId: area._id });
      toast.success(`${area.name} archived`);
    } catch (err: any) {
      toast.error(err?.message || 'Could not archive the area');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-[16px] font-semibold tracking-tight">Your areas</h2>
        <p className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">
          Everything the conversation has recorded. Archiving keeps history — tell the chat you left something
          and it handles the rest.
        </p>
      </div>
      {areas === undefined ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">
          Loading areas…
        </div>
      ) : areas.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
          No areas yet — name one in the conversation above.
        </div>
      ) : (
        <div className="space-y-2.5">
          {areas.map((area) => (
            <div
              key={area._id}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]',
                busyId === area._id && 'opacity-60',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{area.name}</span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
                    {area.kind}
                  </Badge>
                </div>
                <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                  {area.factCounts.verified} verified
                  {area.factCounts.candidate ? ` · ${area.factCounts.candidate} to confirm` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/?area=${area._id}`}>View</Link>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyId === area._id}
                  onClick={() => void archive(area)}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                >
                  Archive
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
