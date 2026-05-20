'use client';

import { useChat } from '@ai-sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { DefaultChatTransport } from 'ai';
import {
  AlarmClock,
  Archive,
  Bell,
  Brain,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Eye,
  Gauge,
  Globe,
  Languages,
  ListChecks,
  Loader2,
  Mail,
  MailOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  Star,
  Tag,
  Trash,
  Trash2,
  User,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Loader } from '@/components/ai-elements/loader';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Suggestion } from '@/components/ai-elements/suggestion';
import { Tool, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

const TOOL_ICONS: Record<string, any> = {
  search_threads: Search,
  nl_search: Search,
  get_thread: Mail,
  get_message: Mail,
  list_accounts: User,
  list_labels: Tag,
  list_attachments: Mail,
  recent_threads: Mail,
  list_account_threads: Mail,
  archive_thread: Archive,
  trash_thread: Trash2,
  restore_from_trash: Archive,
  mark_read: MailOpen,
  mark_unread: Mail,
  star: Star,
  unstar: Star,
  add_label: Tag,
  remove_label: Tag,
  create_label: Tag,
  mute_thread: MailOpen,
  snooze_thread: AlarmClock,
  unsnooze_thread: AlarmClock,
  save_draft: Pencil,
  update_draft: Pencil,
  delete_draft: Pencil,
  list_drafts: Pencil,
  send_message: Send,
  reply: Send,
  reply_all: Send,
  forward: Send,
  schedule_send: AlarmClock,
  cancel_scheduled: AlarmClock,
  undo_send: AlarmClock,
  summarize_thread: ScrollText,
  triage_thread: Gauge,
  draft_reply: Pencil,
  bulk_triage: ListChecks,
  extract_action_items: ListChecks,
  translate_thread: Languages,
  pre_send_critique: ShieldCheck,
  remember: Brain,
  recall: Brain,
  forget: Brain,
  list_memories: Brain,
  calendar_free_busy: Calendar,
  calendar_suggest_times: Calendar,
  calendar_create_event: Calendar,
  contact_lookup: User,
  expand_alias: User,
  browserbase_search: Globe,
  browserbase_fetch: Globe,
  log_action: ListChecks,
  list_audit: ListChecks,
  ui_focus_thread: Eye,
  ui_set_query: Search,
  ui_open_compose: Pencil,
  ui_open_reply: Send,
  ui_toast: Bell,
  ui_close_bar: X,
  ui_switch_account: User,
};

const TOOL_VERBS: Record<string, string> = {
  search_threads: 'Searching',
  nl_search: 'Translating to Gmail query',
  get_thread: 'Loading thread',
  get_message: 'Loading message',
  list_accounts: 'Listing accounts',
  list_labels: 'Listing labels',
  archive_thread: 'Archiving',
  trash_thread: 'Trashing',
  mark_read: 'Marking read',
  mark_unread: 'Marking unread',
  star: 'Starring',
  add_label: 'Labeling',
  remove_label: 'Unlabeling',
  create_label: 'Creating label',
  snooze_thread: 'Snoozing',
  send_message: 'Sending',
  reply: 'Replying',
  reply_all: 'Replying-all',
  forward: 'Forwarding',
  schedule_send: 'Scheduling send',
  summarize_thread: 'Summarizing',
  triage_thread: 'Triaging',
  draft_reply: 'Drafting reply',
  bulk_triage: 'Triaging batch',
  extract_action_items: 'Pulling action items',
  pre_send_critique: 'Reviewing draft',
  remember: 'Remembering',
  recall: 'Recalling',
  calendar_suggest_times: 'Suggesting times',
  calendar_create_event: 'Creating event',
  contact_lookup: 'Looking up contact',
  browserbase_search: 'Searching the web',
  browserbase_fetch: 'Fetching page',
  ui_focus_thread: 'Opening thread',
  ui_set_query: 'Filtering inbox',
  ui_open_compose: 'Opening compose',
  ui_open_reply: 'Opening reply',
  ui_toast: 'Notifying',
  ui_close_bar: 'Closing',
  ui_switch_account: 'Switching account',
};

function toolMeta(name: string) {
  const Icon = TOOL_ICONS[name] || Wrench;
  const verb = TOOL_VERBS[name] || name.replaceAll('_', ' ');
  const isUi = name.startsWith('ui_');
  return { Icon, verb, isUi };
}

// ---------- Trigger: the pill at the top of the app shell ----------
export function AIBarTrigger() {
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const Icon = aiBarOpen ? PanelRightClose : PanelRightOpen;

  // ⌘K toggles the sidebar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAiBarOpen(!aiBarOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setAiBarOpen, aiBarOpen]);

  return (
    <button
      type="button"
      onClick={() => setAiBarOpen(!aiBarOpen)}
      className={cn(
        'absolute top-16 z-30 grid h-8 w-8 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] transition-[right,background-color,color,border-color] duration-200 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
        aiBarOpen ? 'right-[406px]' : 'right-3',
      )}
      title={aiBarOpen ? 'Close agent sidebar (⌘K)' : 'Open agent sidebar (⌘K)'}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="sr-only">{aiBarOpen ? 'Close agent sidebar' : 'Open agent sidebar'}</span>
    </button>
  );
}

// ---------- Sidebar: the actual agent panel, lives on the right side ----------
export function AIBarSidebar() {
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const account = useClientStore((s) => s.account);
  const threadAccount = useClientStore((s) => s.threadAccount);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);

  const setQuery = useClientStore((s) => s.setQuery);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const openCompose = useClientStore((s) => s.openCompose);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  const qc = useQueryClient();

  const [input, setInput] = useState('');
  const inputWrapRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/agent' }), []);
  const { messages, sendMessage, status, stop, error, setMessages } = useChat({ transport });

  // Auto-focus the textarea when the sidebar opens.
  useEffect(() => {
    if (aiBarOpen)
      requestAnimationFrame(() => inputWrapRef.current?.querySelector('textarea')?.focus());
  }, [aiBarOpen]);

  // Esc closes the sidebar if it's open — unless the user is typing in the
  // prompt, where Esc should be a no-op.
  useEffect(() => {
    if (!aiBarOpen) return;
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
      if (e.key === 'Escape' && !typing) setAiBarOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [aiBarOpen, setAiBarOpen]);

  // --- UI tool intercept ---
  const handled = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const part of m.parts || []) {
        const type = (part as any).type;
        if (typeof type !== 'string') continue;
        if (!type.startsWith('tool-ui_')) continue;
        const state = (part as any).state;
        if (state !== 'input-available' && state !== 'output-available') continue;
        const callId = (part as any).toolCallId;
        if (!callId || handled.current.has(callId)) continue;
        handled.current.add(callId);

        const name = type.replace(/^tool-/, '');
        const args = (part as any).input || {};
        try {
          if (name === 'ui_focus_thread' && args.threadId) {
            if (args.account) setThreadAccount(args.account);
            setSelectedThread(args.threadId);
          } else if (name === 'ui_set_query' && args.query) {
            setQuery(args.query);
          } else if (name === 'ui_open_compose') {
            openCompose({
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
            });
          } else if (name === 'ui_open_reply') {
            setPendingReplyBody(args.body || '');
          } else if (name === 'ui_toast') {
            const kind = args.kind || 'info';
            const fn = (toast as any)[kind] || toast;
            fn(args.message || '');
          } else if (name === 'ui_close_bar') {
            // The bar is now the persistent sidebar; only close on explicit
            // request, with a delay so the user sees the final assistant text.
            setTimeout(() => setAiBarOpen(false), 1200);
          } else if (name === 'ui_switch_account' && args.account) {
            // Unified inbox: route the agent's account choice to the operating
            // (thread) account rather than collapsing the inbox view.
            setThreadAccount(args.account);
          }
        } catch {}
      }
    }
  }, [messages, setQuery, setSelectedThread, openCompose, setThreadAccount, setPendingReplyBody, setAiBarOpen]);

  // Refresh server queries when any mutating mail tool finishes.
  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts || []) {
        const type = (part as any).type;
        const state = (part as any).state;
        if (typeof type !== 'string' || state !== 'output-available') continue;
        const callId = (part as any).toolCallId;
        if (!callId || handled.current.has(`refresh:${callId}`)) continue;
        if (
          type.startsWith('tool-archive') ||
          type.startsWith('tool-trash') ||
          type.startsWith('tool-mark_') ||
          type.startsWith('tool-send_') ||
          type.startsWith('tool-reply') ||
          type.startsWith('tool-add_label') ||
          type.startsWith('tool-remove_label') ||
          type.startsWith('tool-snooze') ||
          type.startsWith('tool-unsnooze')
        ) {
          handled.current.add(`refresh:${callId}`);
          qc.invalidateQueries({ queryKey: ['search'] });
          qc.invalidateQueries({ queryKey: ['thread'] });
        }
      }
    }
  }, [messages, qc]);

  const busy = status === 'streaming' || status === 'submitted';

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    const activeAccount =
      threadAccount && threadAccount !== ALL_ACCOUNTS
        ? threadAccount
        : account && account !== ALL_ACCOUNTS
          ? account
          : '';
    const contextLines = [
      activeAccount
        ? `Active account: ${activeAccount}`
        : 'Working across all mailboxes (call list_accounts to enumerate).',
      selectedThreadId ? `Currently focused thread id: ${selectedThreadId}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    sendMessage({ text: trimmed }, { body: { extraSystem: contextLines || undefined } } as any);
  };

  const handleSubmit = (message: PromptInputMessage) => {
    if (busy) {
      stop();
      return;
    }
    send(message.text || '');
  };

  // The sidebar is always mounted but width is controlled by the grid; we
  // render nothing inside when closed to keep the DOM cheap.
  if (!aiBarOpen) return null;

  const last = messages[messages.length - 1];
  const showLoader = busy && (last?.role !== 'assistant' || !hasVisibleContent(last));

  return (
    <motion.section
      key="aibar-sidebar"
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 20, opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--color-bg-elevated)]"
    >
      <TopProgressBar active={busy} />

      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2.5">
        <div className="flex items-baseline gap-1.5 text-[13px]">
          <span className="font-medium text-[var(--color-text)]">Agent</span>
          <span className="text-[var(--color-text-faint)]">·</span>
          <span className="text-[11.5px] text-[var(--color-text-muted)]">gpt-5.5</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMessages([])}
            title="Clear conversation"
            className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            <Trash className="h-3.5 w-3.5" />
            <span className="sr-only">Clear conversation</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setAiBarOpen(false)}
            title="Close (⌘K)"
            className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            <X className="h-3.5 w-3.5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </header>

      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-5 py-8 text-center">
          <div className="space-y-1.5">
            <h3 className="text-[14px] font-medium text-[var(--color-text)]">How can I help?</h3>
            <p className="mx-auto max-w-[300px] text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              Search, triage, summarize, draft replies, schedule sends, look up contacts and
              calendar, research links — and act across your inbox in real time.
            </p>
          </div>
          <div className="flex w-full max-w-[320px] flex-col gap-2">
            {(selectedThreadId ? THREAD_SUGGESTIONS : BASE_SUGGESTIONS).map((s) => (
              <Suggestion
                key={s}
                suggestion={s}
                onClick={send}
                className="h-auto w-full justify-start whitespace-normal rounded-lg border-[var(--color-border)] px-3 py-2 text-left text-[12.5px] font-normal text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              />
            ))}
          </div>
        </div>
      ) : (
        <Conversation className="flex-1">
          <ConversationContent className="gap-4">
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            {showLoader ? (
              <div className="flex items-center gap-2 px-1 text-[12px] text-[var(--color-text-muted)]">
                <Loader size={14} />
                <span>Working…</span>
              </div>
            ) : null}
            {error ? (
              <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
                {error.message}
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <div ref={inputWrapRef} className="border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              placeholder="Find, draft, schedule, label, anything…"
              className="max-h-40 min-h-11 text-[13px]"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit status={status} disabled={!busy && !input.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </motion.section>
  );
}

const BASE_SUGGESTIONS = [
  'Do I have any emails from Tori Kogler? Open the latest.',
  'Triage my newest 25 inbox threads',
  'Summarize unread from this week',
  'Find every Stripe receipt from 2025 and label them Receipts/2025',
];

const THREAD_SUGGESTIONS = [
  'Summarize this thread',
  'Draft a polite no to the latest message',
  'Extract action items',
];

// Indeterminate top progress bar (Linear-style sliding strip). Active only
// while the agent is streaming.
function TopProgressBar({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden transition-opacity duration-200',
        active ? 'opacity-100' : 'opacity-0',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent [animation:topbar-slide_1.6s_ease-in-out_infinite]" />
      <style>{`
        @keyframes topbar-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

function hasVisibleContent(message: any): boolean {
  if (!message) return false;
  if (message.role === 'user') return true;
  for (const part of message.parts || []) {
    const type = part?.type;
    if (type === 'text' && (part.text || '').trim()) return true;
    if ((type === 'reasoning' || type === 'thinking') && (part.text || part.reasoning || '').trim())
      return true;
    if (typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool'))
      return true;
  }
  return false;
}

function MessageView({ message }: { message: any }) {
  const isUser = message.role === 'user';
  if (isUser) {
    const text = userTextFromMessage(message);
    return (
      <Message from="user">
        <MessageContent className="whitespace-pre-wrap text-[13px] leading-relaxed">
          {text || <span className="italic text-[var(--color-text-faint)]">(empty)</span>}
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message from="assistant">
      <MessageContent>
        {(message.parts || []).map((part: any, i: number) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: message parts are append-only during streaming and have no stable id
          <Part key={`${message.id}-${i}`} part={part} />
        ))}
      </MessageContent>
    </Message>
  );
}

function userTextFromMessage(message: any): string {
  // Be defensive: AI SDK 6 normally uses { parts: [{type:'text', text}] }, but
  // older shapes used { content: string } or { text: string }.
  if (typeof message?.content === 'string') return message.content;
  if (typeof message?.text === 'string') return message.text;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p: any) => p && p.type === 'text')
    .map((p: any) => p.text || '')
    .join('');
}

function Part({ part }: { part: any }) {
  const type = part.type;
  if (type === 'text') {
    const text = part.text || '';
    // Skip empty text parts entirely. The model emits these between tool calls;
    // rendering a placeholder for each is what produced the old "loading bar
    // flashing between every tool call".
    if (!text.trim()) return null;
    return (
      <MessageResponse className="text-[13px] leading-relaxed [&_a]:text-[var(--color-accent)]">
        {text}
      </MessageResponse>
    );
  }
  if (type === 'reasoning' || type === 'thinking') {
    const text = part.text || part.reasoning || '';
    if (!text.trim()) return null;
    return (
      <Reasoning className="w-full">
        <ReasoningTrigger />
        <ReasoningContent>{text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')) {
    return <ToolCard part={part} />;
  }
  return null;
}

function ToolStatus({ state }: { state: string }) {
  if (state === 'input-streaming' || state === 'input-available')
    return <Loader2 className="size-3 shrink-0 animate-spin text-[var(--color-text-faint)]" />;
  if (state === 'output-available')
    return <CheckCircle2 className="size-3 shrink-0 text-[var(--color-success)]" />;
  if (state === 'output-error') return <XCircle className="size-3 shrink-0 text-[var(--color-danger)]" />;
  return null;
}

function ToolCard({ part }: { part: any }) {
  const name = part.toolName || (typeof part.type === 'string' ? part.type.replace(/^tool-/, '') : 'tool');
  const state = part.state || 'input-available';
  const { Icon, verb, isUi } = toolMeta(name);
  const summary = summaryFor(name, part.input, part.output);
  const hasDetail = part.input !== undefined || part.output !== undefined || part.errorText;

  return (
    <Tool
      className={cn(
        'mb-0 overflow-hidden rounded-md border-[var(--color-border)] bg-[var(--color-bg-subtle)]/60 text-[12px]',
        isUi && 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]/40',
        state === 'output-error' && 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5',
      )}
    >
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded',
            isUi
              ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
              : 'bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]',
            state === 'output-error' && 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]',
          )}
        >
          <Icon className="size-3" />
        </span>
        <span className="font-medium text-[var(--color-text)]">{verb}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{summary}</span>
        ) : (
          <span className="flex-1" />
        )}
        <ToolStatus state={state} />
        {hasDetail ? (
          <ChevronDown className="size-3 shrink-0 text-[var(--color-text-faint)] transition-transform group-data-[state=open]:rotate-180" />
        ) : null}
      </CollapsibleTrigger>
      <ToolContent>
        {part.input !== undefined ? <ToolInput input={part.input} /> : null}
        {part.output !== undefined || part.errorText ? (
          <ToolOutput output={part.output} errorText={part.errorText} />
        ) : null}
      </ToolContent>
    </Tool>
  );
}

function summaryFor(name: string, args: any, out: any): string {
  if (!args) return '';
  try {
    if (name === 'search_threads' || name === 'nl_search') {
      const q = args.query || args.description;
      const n = out?.items?.length ?? out?.threads?.length;
      return q ? (n != null ? `"${q}" · ${n}` : `"${q}"`) : '';
    }
    if (name === 'get_thread') return `${args.threadId?.slice(-8) ?? ''}`;
    if (name === 'ui_focus_thread') return `${args.threadId?.slice(-8) ?? ''}`;
    if (name === 'ui_set_query') return `"${args.query ?? ''}"`;
    if (name === 'ui_open_compose')
      return [args.to ? `to ${args.to}` : '', args.subject].filter(Boolean).join(' · ');
    if (name === 'archive_thread' || name === 'trash_thread') return args.threadId?.slice(-8) ?? '';
    if (name === 'send_message' || name === 'reply' || name === 'reply_all')
      return `to ${args.to || args.messageId?.slice(-8) || ''}`;
    if (name === 'snooze_thread' && args.untilTs) return new Date(args.untilTs).toLocaleString();
    if (name === 'summarize_thread' || name === 'triage_thread' || name === 'draft_reply')
      return `${args.threadId?.slice(-8) ?? ''}`;
    if (name === 'remember' || name === 'recall' || name === 'forget') return args.email;
    if (name === 'browserbase_search') return `"${args.query}"`;
    if (name === 'browserbase_fetch') return args.url;
    if (name === 'ui_toast') return args.message;
    if (name === 'ui_switch_account') return args.account;
  } catch {}
  return '';
}
