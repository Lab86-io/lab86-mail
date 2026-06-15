'use client';

import { useChat } from '@ai-sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import {
  AlarmClock,
  Archive,
  ArrowUp,
  Bell,
  Brain,
  Calendar,
  Eye,
  Gauge,
  Globe,
  Languages,
  ListChecks,
  Mail,
  MailOpen,
  Paperclip,
  Pencil,
  Plus,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  Square,
  SquareKanban,
  Star,
  Tag,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { motion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChoicePrompt } from '@/components/ai-elements/choice-prompt';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import { ChatContainerContent, ChatContainerRoot } from '@/components/ui/chat-container';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HistoryIcon } from '@/components/ui/history';
import { Loader } from '@/components/ui/loader';
import { Markdown } from '@/components/ui/markdown';
import { Message, MessageContent } from '@/components/ui/message';
import { MessageSquareIcon } from '@/components/ui/message-square';
import { PlusIcon } from '@/components/ui/plus';
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from '@/components/ui/prompt-input';
import { PromptSuggestion } from '@/components/ui/prompt-suggestion';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ui/reasoning';
import { RowIcon } from '@/components/ui/row-icon';
import { ScrollButton } from '@/components/ui/scroll-button';
import { useClientStore } from '@/lib/client-state';
import { formatDate } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

interface ChatSessionSummary {
  _id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

interface StagedChatUpload {
  uploadId: string;
  name: string;
  contentType?: string;
  size: number;
}

// DataTransfer is the only sanctioned way to construct a FileList.
function createFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  for (const file of files) dt.items.add(file);
  return dt.files;
}

async function stageChatFiles(files: File[]): Promise<StagedChatUpload[]> {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  const response = await fetch('/api/agent/uploads', { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not upload files for the assistant.');
  return data.uploads || [];
}

function newChatId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    `chat${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  );
}

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
  calendar_list_events: Calendar,
  calendar_update_event: Calendar,
  calendar_delete_event: Calendar,
  calendar_delete_recurring_series: Calendar,
  calendar_unsubscribe_calendar: Calendar,
  tasks_list_boards: SquareKanban,
  tasks_get_board: SquareKanban,
  tasks_create_board: SquareKanban,
  tasks_create_card: SquareKanban,
  tasks_update_card: SquareKanban,
  tasks_move_card: SquareKanban,
  tasks_delete_card: SquareKanban,
  tasks_attach_link: Paperclip,
  tasks_attach_file: Paperclip,
  tasks_attach_calendar_event_link: Calendar,
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
  nl_search: 'Translating to mail query',
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
  calendar_list_events: 'Listing events',
  calendar_update_event: 'Updating event',
  calendar_delete_event: 'Deleting event',
  calendar_delete_recurring_series: 'Deleting recurring events',
  calendar_unsubscribe_calendar: 'Unsubscribing calendar',
  tasks_get_board: 'Loading board',
  tasks_create_card: 'Creating task',
  tasks_update_card: 'Updating task',
  tasks_attach_link: 'Attaching link',
  tasks_attach_file: 'Attaching file',
  tasks_attach_calendar_event_link: 'Attaching calendar link',
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

// ---------- Trigger: the "Ask Assistant" launcher, bottom-right of the shell ----------
// Text-only (no icon), anchored bottom-right, with an animated Magic UI glow
// around the border so it reads as the live AI entry point.
export function AIBarTrigger() {
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const threadFullscreen = useClientStore((s) => s.threadFullscreen);

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

  // When the sidebar is open it owns its own pane and Close button, so we
  // only render this floating trigger while it's closed. The fullscreen
  // reader popout owns the whole window — no floating chrome above it.
  if (aiBarOpen || threadFullscreen) return null;

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      onClick={() => setAiBarOpen(true)}
      title="Ask Assistant (⌘K)"
      className="ask-assistant-glow group absolute bottom-4 right-4 z-30 flex items-center gap-2 overflow-hidden rounded-full bg-[var(--color-bg-elevated)] px-4 py-2 text-[12.5px] font-medium text-[var(--color-text)]"
    >
      {/* Magic UI traveling light inside the hairline ring (CSS class). */}
      <BorderBeam size={56} duration={9} borderWidth={1} />
      <span>Ask Assistant</span>
      <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-1 py-px font-mono text-[9.5px] text-[var(--color-text-faint)]">
        ⌘K
      </kbd>
      <span className="sr-only">Open the assistant</span>
    </motion.button>
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
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  const qc = useQueryClient();

  const [input, setInput] = useState('');
  // Files attached to the next message (images/PDFs the model can read).
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);

  // The browser's IANA timezone rides along so the agent (and calendar
  // tools) interpret wall-clock times like "2:30" in the user's zone.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/agent',
        body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      }),
    [],
  );
  const { messages, sendMessage, status, stop, error, setMessages, addToolResult } = useChat({
    transport,
    // When the client answers a human-in-the-loop tool (ask_user), auto-continue
    // the agent with that answer instead of waiting for a manual send.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  // Hand the ask_user answer back into the stream. Memoized so the context
  // value is stable across renders.
  const answerAskUser = useCallback(
    (toolCallId: string, selected: string[]) => {
      void addToolResult({ tool: 'ask_user', toolCallId, output: { selected } });
    },
    [addToolResult],
  );

  // --- Persistent sessions: restore the last chat, autosave as you go ---
  const lastChatId = useClientStore((s) => s.lastChatId);
  const lastChatAt = useClientStore((s) => s.lastChatAt);
  const setLastChatId = useClientStore((s) => s.setLastChatId);
  const sessionIdRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const saveTimer = useRef<number | null>(null);

  const loadSession = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data?.ok && Array.isArray(data.session?.messages)) {
          sessionIdRef.current = id;
          setLastChatId(id);
          setMessages(data.session.messages);
          return true;
        }
      } catch {
        // history is best-effort; a failed load just starts fresh
      }
      return false;
    },
    [setLastChatId, setMessages],
  );

  // First open: pick up where the user left off — but only if that
  // conversation is RECENT. Restoring an hours-old thread on cmd+k reads as
  // a bug, not a continuation; stale sessions stay in history instead.
  const CHAT_RESTORE_WINDOW_MS = 30 * 60_000;
  useEffect(() => {
    if (!aiBarOpen || restoredRef.current) return;
    restoredRef.current = true;
    const fresh = lastChatAt && Date.now() - lastChatAt < CHAT_RESTORE_WINDOW_MS;
    if (lastChatId && fresh && messages.length === 0) {
      sessionIdRef.current = lastChatId;
      void loadSession(lastChatId);
    }
  }, [aiBarOpen, lastChatId, lastChatAt, messages.length, loadSession]);

  // Autosave once the stream settles (debounced so multi-step turns save once).
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
        body: JSON.stringify({ id, messages }),
      })
        .then(() => qc.invalidateQueries({ queryKey: ['chat-sessions'] }))
        .catch(() => undefined);
    }, 600);
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
  }, [messages, status, qc]);

  const startNewChat = useCallback(() => {
    sessionIdRef.current = null;
    setLastChatId(null);
    setMessages([]);
  }, [setLastChatId, setMessages]);

  const { data: sessionsData } = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: async () => {
      const res = await fetch('/api/chats');
      const data = await res.json();
      return (data?.sessions || []) as ChatSessionSummary[];
    },
    enabled: aiBarOpen,
    staleTime: 30_000,
  });
  const chatSessions = sessionsData || [];

  // Auto-focus the textarea when the sidebar opens.
  useEffect(() => {
    if (aiBarOpen) requestAnimationFrame(() => inputWrapRef.current?.querySelector('textarea')?.focus());
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
        // Tool calls arrive either as static `tool-<name>` parts or, via some
        // providers (OpenRouter), as `dynamic-tool` parts carrying `toolName`.
        // Resolve the name from both so UI actions (compose, focus, …) fire
        // regardless of which shape the model emits.
        const name =
          type === 'dynamic-tool'
            ? (part as any).toolName
            : type.startsWith('tool-')
              ? type.replace(/^tool-/, '')
              : '';
        if (!name?.startsWith('ui_')) continue;
        const state = (part as any).state;
        if (state !== 'input-available' && state !== 'output-available') continue;
        const callId = (part as any).toolCallId;
        if (!callId || handled.current.has(callId)) continue;
        handled.current.add(callId);

        const args = (part as any).input || {};
        try {
          if (name === 'ui_focus_thread' && args.threadId) {
            if (args.account) setThreadAccount(args.account);
            setSelectedThread(args.threadId);
          } else if (name === 'ui_set_query' && args.query) {
            setQuery(args.query);
          } else if (name === 'ui_open_compose') {
            openComposeNew({
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
            });
          } else if (name === 'ui_open_reply') {
            if (args.account) setThreadAccount(args.account);
            if (args.threadId) setSelectedThread(args.threadId);
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
  }, [
    messages,
    setQuery,
    setSelectedThread,
    openComposeNew,
    setThreadAccount,
    setPendingReplyBody,
    setAiBarOpen,
  ]);

  // Refresh server queries when any mutating mail tool finishes.
  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts || []) {
        const type = (part as any).type;
        const state = (part as any).state;
        if (typeof type !== 'string' || state !== 'output-available') continue;
        const callId = (part as any).toolCallId;
        if (!callId || handled.current.has(`refresh:${callId}`)) continue;
        const name =
          type === 'dynamic-tool'
            ? (part as any).toolName || ''
            : type.startsWith('tool-')
              ? type.slice(5)
              : '';
        if (/^(archive|trash|mark_|send_|reply|add_label|remove_label|snooze|unsnooze)/.test(name)) {
          handled.current.add(`refresh:${callId}`);
          qc.invalidateQueries({ queryKey: ['search'] });
          qc.invalidateQueries({ queryKey: ['thread'] });
        }
      }
    }
  }, [messages, qc]);

  const streaming = status === 'streaming' || status === 'submitted';
  const busy = streaming || uploadingFiles;

  const send = async (text: string) => {
    const trimmed = text.trim();
    const filesForTurn = pendingFiles;
    if ((!trimmed && !filesForTurn.length) || busy) return;

    let stagedUploads: StagedChatUpload[] = [];
    if (filesForTurn.length) {
      setUploadingFiles(true);
      try {
        stagedUploads = await stageChatFiles(filesForTurn);
      } catch (err: any) {
        toast.error(err?.message || 'Could not upload files for the assistant');
        setUploadingFiles(false);
        return;
      }
      setUploadingFiles(false);
    }

    // Lazily mint a session id on the first message so autosave has a home
    // and the conversation shows up in history.
    if (!sessionIdRef.current) {
      sessionIdRef.current = newChatId();
      setLastChatId(sessionIdRef.current);
    }
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
    const uploadContext = stagedUploads.length
      ? [
          'Files uploaded in this user turn. To attach one of these files to a task card, call tasks_attach_file with the matching chatUploadId:',
          ...stagedUploads.map(
            (file) =>
              `- ${file.name} (${file.contentType || 'application/octet-stream'}, ${file.size} bytes): chatUploadId=${file.uploadId}`,
          ),
        ].join('\n')
      : '';
    const files = filesForTurn.length ? createFileList(filesForTurn) : undefined;
    setInput('');
    setPendingFiles([]);
    sendMessage(
      { text: trimmed || 'Use the attached file(s).', ...(files ? { files } : {}) } as any,
      {
        body: {
          extraSystem: [contextLines, uploadContext].filter(Boolean).join('\n\n') || undefined,
        },
      } as any,
    );
  };

  const submit = () => {
    if (streaming) {
      stop();
      return;
    }
    if (uploadingFiles) return;
    void send(input);
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
      className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--color-bg)]"
    >
      <TopProgressBar active={busy} />

      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <RowIcon icon={MessageSquareIcon} size={14} className="text-[var(--color-accent)]" />
          <span className="truncate font-medium text-[var(--color-text)]">Ask Assistant</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={startNewChat}
            title="New chat"
            className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            <RowIcon icon={PlusIcon} size={14} />
            <span className="sr-only">New chat</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Chat history"
                className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              >
                <RowIcon icon={HistoryIcon} size={14} />
                <span className="sr-only">Chat history</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
              <DropdownMenuLabel>Previous chats</DropdownMenuLabel>
              {chatSessions.length === 0 ? (
                <DropdownMenuItem disabled>No saved chats yet</DropdownMenuItem>
              ) : (
                chatSessions.map((session) => (
                  <DropdownMenuItem
                    key={session._id}
                    onSelect={() => void loadSession(session._id)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="w-full truncate text-[12.5px] text-[var(--color-text)]">
                      {session.title || 'Untitled chat'}
                    </span>
                    <span className="text-[10.5px] text-[var(--color-text-faint)]">
                      {formatDate(session.updatedAt)} · {session.messageCount} message
                      {session.messageCount === 1 ? '' : 's'}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={startNewChat}>
                <Plus className="size-3.5" />
                Start a new chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
        <div className="scrollable flex flex-1 flex-col items-center justify-center gap-5 px-5 py-8 text-center">
          <div className="space-y-1.5">
            <h3 className="text-[14px] font-medium text-[var(--color-text)]">How can I help?</h3>
            <p className="mx-auto max-w-[300px] text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              Search, triage, summarize, draft replies, schedule sends, look up contacts and calendar,
              research links — and act across your inbox in real time.
            </p>
          </div>
          <div className="flex w-full max-w-[320px] flex-col gap-2">
            {(selectedThreadId ? THREAD_SUGGESTIONS : BASE_SUGGESTIONS).map((s) => (
              <PromptSuggestion
                key={s}
                variant="outline"
                onClick={() => void send(s)}
                className="h-auto w-full justify-start whitespace-normal rounded-xl border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-2.5 text-left text-[12.5px] font-normal text-[var(--color-accent)] shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]"
              >
                {s}
              </PromptSuggestion>
            ))}
          </div>
        </div>
      ) : (
        <ChatContainerRoot className="relative flex-1">
          <ChatContainerContent className="gap-4 px-3 py-4">
            <AskUserContext.Provider value={answerAskUser}>
              {messages.map((m) => (
                <MessageView key={m.id} message={m} />
              ))}
            </AskUserContext.Provider>
            {showLoader ? (
              <div className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-[var(--color-text-muted)]">
                <Loader variant="typing" />
              </div>
            ) : null}
            {error ? (
              <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
                {error.message}
              </div>
            ) : null}
          </ChatContainerContent>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <ScrollButton className="pointer-events-auto shadow-[var(--shadow-pop)]" />
          </div>
        </ChatContainerRoot>
      )}

      <div ref={inputWrapRef} className="p-2.5">
        <PromptInput
          value={input}
          onValueChange={setInput}
          isLoading={busy}
          onSubmit={submit}
          maxHeight={176}
          className="border-[var(--color-accent)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]"
        >
          <PromptInputTextarea
            placeholder="Find, draft, schedule, label, anything…"
            className="text-[13px] leading-relaxed text-[var(--color-text)]"
          />
          {pendingFiles.length ? (
            <div className="flex flex-wrap gap-1 px-1 pb-1">
              {pendingFiles.map((file, index) => (
                <span
                  key={`${file.name}-${file.size}-${file.lastModified}`}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--color-text-muted)]"
                >
                  {file.name}
                  <button
                    type="button"
                    onClick={() => setPendingFiles(pendingFiles.filter((_, i) => i !== index))}
                    className="hover:text-[var(--color-danger)]"
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <PromptInputActions className="justify-end pt-1">
            <PromptInputAction tooltip="Attach a file for the assistant">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              >
                <Paperclip className="size-3.5" />
                <span className="sr-only">Attach file</span>
              </Button>
            </PromptInputAction>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/plain,text/csv"
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files || []);
                if (picked.length) setPendingFiles((prev) => [...prev, ...picked].slice(0, 5));
                event.target.value = '';
              }}
            />
            <PromptInputAction tooltip={busy ? 'Stop' : 'Send'}>
              <Button
                type="button"
                size="icon-sm"
                onClick={submit}
                disabled={!busy && !input.trim() && !pendingFiles.length}
                className="rounded-full"
                aria-label={busy ? 'Stop' : 'Send'}
              >
                {busy ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>
    </motion.section>
  );
}

const BASE_SUGGESTIONS = [
  'What needs my reply today? Open the most urgent one.',
  'Triage my newest 25 inbox threads',
  'Summarize unread from this week',
  'Find every receipt from last year and label them Receipts',
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
      <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-[var(--color-transparent)] via-[var(--color-accent)] to-[var(--color-transparent)] [animation:topbar-slide_1.6s_ease-in-out_infinite]" />
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
    if (typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')) return true;
  }
  return false;
}

function MessageView({ message }: { message: any }) {
  const isUser = message.role === 'user';
  if (isUser) {
    const text = userTextFromMessage(message);
    return (
      <Message className="justify-end">
        <MessageContent className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--color-text)]">
          {text || '(empty)'}
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message className="justify-start">
      <div className="flex w-full min-w-0 flex-col gap-2">
        {(message.parts || []).map((part: any, i: number) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: streamed parts are append-only with no stable id
          <Part key={`${message.id}-${i}`} part={part} />
        ))}
      </div>
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

// Lets the deeply-nested Part renderer hand an ask_user answer back to useChat.
const AskUserContext = createContext<(toolCallId: string, selected: string[]) => void>(() => {});

// Renders the agent's multiple-choice question (the ask_user HITL tool). The
// chosen labels are sent back via addToolResult, which auto-continues the agent.
function AskUserPart({ part }: { part: any }) {
  const answer = useContext(AskUserContext);
  const input = part.input || {};
  const options = Array.isArray(input.options) ? input.options : [];
  const state = part.state;
  if (state === 'input-streaming') return null;
  if (!input.question || !options.length) return null;
  const answered = state === 'output-available';
  const selected = Array.isArray(part.output?.selected) ? part.output.selected : [];
  return (
    <ChoicePrompt
      question={input.question}
      options={options}
      multiSelect={Boolean(input.multiSelect)}
      answered={answered}
      selected={selected}
      onSubmit={(labels) => answer(part.toolCallId, labels)}
    />
  );
}

function Part({ part }: { part: any }) {
  const type = part.type;
  if (type === 'text') {
    const text = part.text || '';
    // Skip empty text parts (the model emits these between tool calls).
    if (!text.trim()) return null;
    return (
      <Markdown className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[var(--color-text)] dark:prose-invert [&_a]:text-[var(--color-accent)]">
        {text}
      </Markdown>
    );
  }
  if (type === 'reasoning' || type === 'thinking') {
    const text = part.text || part.reasoning || '';
    if (!text.trim()) return null;
    return (
      <Reasoning className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
        <ReasoningTrigger className="text-[12px] font-medium text-[var(--color-text-muted)]">
          Thinking
        </ReasoningTrigger>
        <ReasoningContent markdown className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">
          {text}
        </ReasoningContent>
      </Reasoning>
    );
  }
  if (type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'))) {
    const toolName = type === 'dynamic-tool' ? part.toolName : type.replace(/^tool-/, '');
    if (toolName === 'ask_user') return <AskUserPart part={part} />;
    return <ToolCard part={part} />;
  }
  return null;
}

// A single human-readable line for each agent step — no JSON, no call ids.
function ToolCard({ part }: { part: any }) {
  const name =
    part.type === 'dynamic-tool'
      ? part.toolName
      : typeof part.type === 'string'
        ? part.type.replace(/^tool-/, '')
        : 'tool';
  const { Icon, verb } = toolMeta(name);
  const state = part.state || 'input-available';
  const errored = state === 'output-error';
  const done = state === 'output-available';
  const working = !errored && !done;
  const text = errored
    ? part.errorText || 'That step ran into a problem.'
    : working
      ? `${verb}…`
      : humanizeTool(name, part.input, part.output);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-[12px] leading-snug text-[var(--color-text-muted)]">
      <span
        className={cn(
          'mt-px grid size-4 shrink-0 place-items-center',
          errored
            ? 'text-[var(--color-danger)]'
            : done
              ? 'text-[var(--color-success)]'
              : 'text-[var(--color-text-faint)]',
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

// Turn a tool call + its result into a friendly sentence for the chat log.
function humanizeTool(name: string, args: any, out: any): string {
  const a = args || {};
  const count = (o: any) =>
    o?.items?.length ?? o?.threads?.length ?? o?.verdicts?.length ?? o?.results?.length ?? null;
  try {
    switch (name) {
      case 'search_threads':
      case 'nl_search': {
        const q = a.query || a.description || '';
        const n = count(out);
        return n != null
          ? `Found ${n} thread${n === 1 ? '' : 's'}${q ? ` for “${q}”` : ''}.`
          : q
            ? `Searched for “${q}”.`
            : 'Searched your mail.';
      }
      case 'get_thread':
        return 'Read the thread.';
      case 'summarize_thread':
        return out?.summary ? `Summary: ${out.summary}` : 'Summarized the thread.';
      case 'triage_thread':
        return out?.reason ? `Triaged — ${out.reason}` : 'Triaged the thread.';
      case 'draft_reply':
        return 'Drafted a reply for you to review.';
      case 'extract_action_items':
        return 'Pulled out the action items.';
      case 'classify_threads':
        return 'Re-checked smart categories.';
      case 'archive_thread':
        return 'Archived the thread.';
      case 'trash_thread':
        return 'Moved the thread to trash.';
      case 'mark_read':
        return 'Marked as read.';
      case 'mark_unread':
        return 'Marked as unread.';
      case 'add_label':
        return a.label ? `Added the “${a.label}” label.` : 'Added a label.';
      case 'snooze_thread':
        return a.untilTs ? `Snoozed until ${new Date(a.untilTs).toLocaleString()}.` : 'Snoozed it.';
      case 'send_message':
      case 'reply':
      case 'reply_all':
        return `Prepared a message${a.to ? ` to ${a.to}` : ''} for your review.`;
      case 'ui_open_compose':
        return `Opened the composer${a.to ? ` to ${a.to}` : ''}${a.subject ? ` — “${a.subject}”` : ''}.`;
      case 'ui_open_reply':
        return 'Opened a reply for you to review.';
      case 'ui_focus_thread':
        return 'Opened that thread in your reader.';
      case 'ui_set_query':
        return a.query ? `Filtered your inbox to “${a.query}”.` : 'Filtered your inbox.';
      case 'remember':
        return a.email ? `Saved a note about ${a.email}.` : 'Saved a note.';
      case 'recall':
        return a.email ? `Recalled what I know about ${a.email}.` : 'Recalled my notes.';
      case 'calendar_free_busy':
        return 'Checked your calendar availability.';
      case 'calendar_suggest_times':
        return 'Suggested some meeting times.';
      case 'calendar_create_event':
        return 'Created a calendar event.';
      case 'calendar_list_events': {
        const n = out?.events?.length ?? null;
        return n != null ? `Found ${n} calendar event${n === 1 ? '' : 's'}.` : 'Listed calendar events.';
      }
      case 'tasks_create_card':
        return a.title ? `Created task “${a.title}”.` : 'Created a task.';
      case 'tasks_update_card':
        return 'Updated the task.';
      case 'tasks_attach_link':
        return a.url ? `Attached ${a.url} to the task.` : 'Attached a link to the task.';
      case 'tasks_attach_file':
        return out?.name ? `Attached ${out.name} to the task.` : 'Attached a file to the task.';
      case 'tasks_attach_calendar_event_link':
        return out?.name
          ? `Attached calendar link “${out.name}” to the task.`
          : 'Attached a calendar link to the task.';
      case 'contact_lookup':
        return 'Looked up the contact.';
      case 'browserbase_search':
        return a.query ? `Searched the web for “${a.query}”.` : 'Searched the web.';
      case 'browserbase_fetch':
        return a.url ? `Read ${a.url}.` : 'Fetched a web page.';
      case 'list_accounts':
        return 'Checked your connected accounts.';
      default: {
        const n = count(out);
        return n != null ? `Done — ${n} result${n === 1 ? '' : 's'}.` : 'Done.';
      }
    }
  } catch {
    return 'Done.';
  }
}
