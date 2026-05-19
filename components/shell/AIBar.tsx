'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import {
  ArrowUp,
  Sparkles,
  X,
  Square,
  ChevronDown,
  ChevronRight,
  Search,
  Mail,
  MailOpen,
  Archive,
  Trash2,
  Send,
  Star,
  Pencil,
  Tag,
  Brain,
  Calendar,
  User,
  Globe,
  History,
  Eye,
  AlarmClock,
  CheckCircle2,
  Loader2,
  Trash,
  MessageSquarePlus,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import TextareaAutosize from 'react-textarea-autosize';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
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
  summarize_thread: Sparkles,
  triage_thread: Sparkles,
  draft_reply: Pencil,
  bulk_triage: Sparkles,
  extract_action_items: Sparkles,
  translate_thread: Sparkles,
  pre_send_critique: Sparkles,
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
  log_action: History,
  list_audit: History,
  ui_focus_thread: Eye,
  ui_set_query: Search,
  ui_open_compose: Pencil,
  ui_open_reply: Send,
  ui_toast: Sparkles,
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
  const Icon = TOOL_ICONS[name] || Sparkles;
  const verb = TOOL_VERBS[name] || name.replaceAll('_', ' ');
  const isUi = name.startsWith('ui_');
  return { Icon, verb, isUi };
}

// ---------- Shared chat instance via a tiny store-aware hook ----------
// Both the trigger and the sidebar use this. The sidebar is the only one
// that renders messages; the trigger just toggles open state.
function useAgentChat() {
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/agent' }), []);
  return useChat({ transport });
}

// ---------- Trigger: the pill at the top of the app shell ----------
export function AIBarTrigger() {
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);

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
      className="group relative flex h-8 w-full max-w-[640px] items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 text-left text-[13px] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      title="Toggle AI agent sidebar (⌘K)"
    >
      <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />
      <span className="flex-1 truncate">
        Ask Mail OS anything — search, summarize, draft, send…
      </span>
      <kbd>⌘K</kbd>
    </button>
  );
}

// ---------- Sidebar: the actual agent panel, lives on the right side ----------
export function AIBarSidebar() {
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const account = useClientStore((s) => s.account);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);

  const setQuery = useClientStore((s) => s.setQuery);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const openCompose = useClientStore((s) => s.openCompose);
  const setAccount = useClientStore((s) => s.setAccount);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  const qc = useQueryClient();

  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/agent' }), []);
  const { messages, sendMessage, status, stop, error, setMessages } = useChat({ transport });

  // Auto-scroll to bottom on new messages / streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // Auto-focus the textarea when the sidebar opens.
  useEffect(() => {
    if (aiBarOpen) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [aiBarOpen]);

  // Esc closes the sidebar if it's open.
  useEffect(() => {
    if (!aiBarOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement !== textareaRef.current) {
        setAiBarOpen(false);
      }
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
            if (args.account) setAccount(args.account);
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
            setAccount(args.account);
          }
        } catch {}
      }
    }
  }, [messages, setQuery, setSelectedThread, openCompose, setAccount, setPendingReplyBody, setAiBarOpen]);

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

  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput('');
    const contextLines = [
      account ? `Active account: ${account}` : '',
      selectedThreadId ? `Currently focused thread id: ${selectedThreadId}` : '',
    ].filter(Boolean).join('\n');
    sendMessage(
      { text },
      { body: { extraSystem: contextLines || undefined } } as any,
    );
  };

  const busy = status === 'streaming' || status === 'submitted';

  // The sidebar is always mounted but width is controlled by the grid; we
  // render nothing inside when closed to keep the DOM cheap.
  if (!aiBarOpen) return null;

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

      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
          <div className="relative grid h-5 w-5 place-items-center rounded-md bg-[var(--color-accent-soft)]">
            <Sparkles className="h-3 w-3 text-[var(--color-accent)]" />
            {busy ? (
              <span className="absolute inset-0 rounded-md bg-[var(--color-accent)]/20 animate-pulse" />
            ) : null}
          </div>
          <span className="font-medium text-[var(--color-text)]">Agent</span>
          <span className="text-[var(--color-text-faint)]">·</span>
          <span>gpt-5.5</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMessages([])}
            className="grid h-6 w-6 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
            title="Clear conversation"
          >
            <Trash className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setAiBarOpen(false)}
            className="grid h-6 w-6 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
            title="Close (⌘K)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <Suggestions onPick={submit} threadFocused={!!selectedThreadId} />
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m) => <MessageView key={m.id} message={m} />)}
            {busy && messages[messages.length - 1]?.role === 'user' ? <ThinkingDots /> : null}
          </div>
        )}
        {error ? (
          <div className="mt-3 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
            {error.message}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="flex items-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5"
      >
        <TextareaAutosize
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(input);
            }
          }}
          placeholder="Find, draft, schedule, label, anything…"
          maxRows={8}
          minRows={1}
          className="flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/30 placeholder:text-[var(--color-text-faint)]"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => stop()}
            className="grid h-8 w-8 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-danger)] hover:bg-[var(--color-bg-muted)]"
            title="Stop"
          >
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="grid h-8 w-8 place-items-center rounded-md bg-[var(--color-accent)] text-[var(--color-accent-foreground)] shadow-[var(--shadow-soft)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            title="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </form>
    </motion.section>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5 px-1 text-[11px] text-[var(--color-text-faint)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      Thinking…
    </div>
  );
}

// Indeterminate top progress bar (Linear-style sliding strip) instead of the
// old border-beam. Active only while the agent is streaming.
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

function Suggestions({ onPick, threadFocused }: { onPick: (text: string) => void; threadFocused: boolean }) {
  const base = [
    { text: 'Do I have any emails from Tori Kogler? Open the latest.', icon: Search },
    { text: 'Triage my newest 25 inbox threads', icon: Sparkles },
    { text: 'Summarize unread from this week', icon: Sparkles },
    { text: 'Find every Stripe receipt from 2025 and label them Receipts/2025', icon: Tag },
  ];
  const threadOnly = [
    { text: 'Summarize this thread', icon: Sparkles },
    { text: 'Draft a polite no to the latest message', icon: Pencil },
    { text: 'Extract action items', icon: MessageSquarePlus },
  ];
  const suggestions = threadFocused ? threadOnly : base;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-subtle)]/60 px-3 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text)]">
          <Sparkles className="h-3 w-3 text-[var(--color-accent)]" />
          What I can do
        </div>
        <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          Search, summarize, triage, label, snooze, draft replies, schedule sends, look up contacts and calendar, research links on the web — and drive your inbox in real time as I work.
        </p>
      </div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Try</div>
      {suggestions.map((s) => {
        const Icon = s.icon;
        return (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-2 text-left text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
          >
            <Icon className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
            <span className="line-clamp-2">{s.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function MessageView({ message }: { message: any }) {
  const isUser = message.role === 'user';
  if (isUser) {
    const text = userTextFromMessage(message);
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-[var(--color-accent-soft)] px-3 py-1.5 text-[13px] leading-relaxed text-[var(--color-text)] shadow-[var(--shadow-soft)]">
          {text || <span className="italic text-[var(--color-text-faint)]">(empty)</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
        <Sparkles className="h-2.5 w-2.5 text-[var(--color-accent)]" />
        Mail OS
      </div>
      <div className="flex flex-col gap-2">
        {(message.parts || []).map((part: any, i: number) => (
          <Part key={`${message.id}-${i}`} part={part} />
        ))}
      </div>
    </div>
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
  if (type === 'text') return <MarkdownText text={part.text || ''} />;
  if (type === 'reasoning' || type === 'thinking')
    return <ReasoningBlock text={part.text || part.reasoning || ''} />;
  if (typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')) {
    return <ToolCard part={part} />;
  }
  if (type === 'step-start' || type === 'step-end') return null;
  return null;
}

function MarkdownText({ text }: { text: string }) {
  if (!text) return <span className="block h-3 w-12 rounded shimmer" />;
  // Streamdown is Vercel's streaming-safe react-markdown drop-in with built-in
  // GFM, code highlighting, math, mermaid, link safety, and an in-progress
  // cursor — perfect for AI chat. We just give it our prose styles.
  return (
    <div className="prose prose-sm max-w-none break-words text-[13px] leading-relaxed text-[var(--color-text)] [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_a]:text-[var(--color-accent)] [&_a]:underline-offset-2 [&_a]:no-underline hover:[&_a]:underline [&_code]:break-words [&_code]:rounded [&_code]:bg-[var(--color-bg-subtle)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[11.5px] [&_code]:font-medium [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--color-border)] [&_pre]:bg-[var(--color-bg-subtle)] [&_pre]:p-2.5 [&_pre]:text-[11.5px] [&_pre_code]:whitespace-pre [&_pre_code]:break-normal [&_h1]:text-[14px] [&_h2]:text-[13.5px] [&_h3]:text-[13px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul>li]:my-0 [&_ol>li]:my-0 [&_ul]:pl-4 [&_ol]:pl-4 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-text-muted)] [&_strong]:font-semibold [&_em]:italic [&_table]:block [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[12px] [&_th]:border [&_td]:border [&_th]:border-[var(--color-border)] [&_td]:border-[var(--color-border)] [&_th]:px-1.5 [&_td]:px-1.5 [&_th]:py-1 [&_td]:py-1 [&_th]:bg-[var(--color-bg-subtle)] [&_hr]:my-2 [&_hr]:border-[var(--color-border)]">
      <Streamdown parseIncompleteMarkdown>{text}</Streamdown>
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="flex w-fit flex-col gap-1 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg-subtle)]/60 px-2 py-1.5 text-left text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)]"
    >
      <div className="flex items-center gap-1.5">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" />
        <span>{open ? 'Thinking' : `Thinking · ${text.split(/\s+/).length} words`}</span>
      </div>
      {open ? <p className="mt-1 max-w-[360px] whitespace-pre-wrap text-[var(--color-text-muted)]">{text}</p> : null}
    </button>
  );
}

function ToolCard({ part }: { part: any }) {
  const [open, setOpen] = useState(false);
  const name = part.toolName || (typeof part.type === 'string' ? part.type.replace(/^tool-/, '') : 'tool');
  const state = part.state || 'unknown';
  const meta = toolMeta(name);
  const Icon = meta.Icon;

  const isStreamingInput = state === 'input-streaming';
  const isPending = state === 'input-available' || state === 'input-streaming';
  const isDone = state === 'output-available';
  const isError = state === 'output-error';

  const args = part.input;
  const out = part.output;
  const summary = summaryFor(name, args, out);

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border px-2.5 py-1.5 text-[11.5px] transition-colors',
        meta.isUi
          ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]/40'
          : 'border-[var(--color-border)] bg-[var(--color-bg-subtle)]/60',
        isError && 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <div
          className={cn(
            'grid h-4 w-4 shrink-0 place-items-center rounded',
            meta.isUi ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]' : 'bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]',
            isError && 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]',
          )}
        >
          <Icon className="h-2.5 w-2.5" />
        </div>
        <div className="flex flex-1 items-baseline gap-1.5 truncate">
          <span className="font-medium text-[var(--color-text)]">{meta.verb}</span>
          {summary ? <span className="truncate text-[var(--color-text-muted)]">{summary}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-faint)]">
          {isPending ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : isDone ? (
            <CheckCircle2 className="h-2.5 w-2.5 text-[var(--color-success)]" />
          ) : isError ? (
            <span className="text-[var(--color-danger)]">err</span>
          ) : null}
          {open ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
        </div>
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-t border-[var(--color-border)] pt-1.5 font-mono text-[10px]">
          {args ? (
            <div>
              <div className="mb-0.5 text-[var(--color-text-faint)]">input</div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          ) : null}
          {isDone && out !== undefined ? (
            <div>
              <div className="mb-0.5 text-[var(--color-text-faint)]">output</div>
              <pre className="max-h-44 overflow-x-auto overflow-y-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
                {JSON.stringify(out, null, 2)}
              </pre>
            </div>
          ) : null}
          {isError && part.errorText ? (
            <div className="text-[var(--color-danger)]">{part.errorText}</div>
          ) : null}
        </div>
      ) : null}
    </div>
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
    if (name === 'snooze_thread' && args.untilTs)
      return new Date(args.untilTs).toLocaleString();
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
