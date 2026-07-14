'use client';

import { useChat } from '@ai-sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DefaultChatTransport } from 'ai';
import { ArrowUp, Paperclip, Plus, Square, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AskAnswer, AskUserForm } from '@/components/ai-elements/choice-prompt';
import { HitlPart } from '@/components/ai-elements/hitl-parts';
import { ToolActivityRow } from '@/components/ai-elements/tool-activity';
import { TOOL_UI_RENDERED_TOOLS, ToolUiDisplayPart } from '@/components/ai-elements/tool-ui-part';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import SiriOrb from '@/components/smoothui/siri-orb';
import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import { ChatContainerContent, ChatContainerRoot } from '@/components/ui/chat-container';
import { DotGridGlow } from '@/components/ui/dot-grid-glow';
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
import {
  createHitlAutoContinueGuard,
  isHitlToolName,
  toolActivityLine,
  toolActivityState,
  toolPartName,
} from '@/lib/albatross/teach-ui';
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

// Orb colors derive from the live accent (relative OKLCH) so any theme keeps
// the assistant presence coherent — same recipe as the New Intent launcher.
const ORB_COLORS = {
  bg: 'transparent',
  c1: 'oklch(from var(--color-accent) calc(l + 0.25) calc(c * 0.6) h)',
  c2: 'oklch(from var(--color-accent) calc(l + 0.12) c calc(h + 50))',
  c3: 'oklch(from var(--color-accent) calc(l + 0.12) c calc(h - 50))',
};

// ---------- Trigger: the "Ask Assistant" launcher, bottom-right of the shell ----------
// Text-only (no icon), anchored bottom-right, with an animated Magic UI glow
// around the border so it reads as the live AI entry point.
export function AIBarTrigger({ buttonHidden = false }: { buttonHidden?: boolean }) {
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
  // With Albatross on, New Intent owns the bottom-right slot and the
  // assistant stays reachable via Cmd+K — keep the hook, skip the button.
  if (buttonHidden || aiBarOpen || threadFullscreen) return null;

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

// ---------- The assistant panel: a floating, dreamy chat surface ----------
// Same plumbing as the old docked sidebar (useChat → /api/agent, /api/chats
// persistence, ask_user forms, UI tool intercepts) presented as a floating
// translucent panel in the New Intent capture family: SiriOrb presence,
// DotGridGlow behind, soft springs. Research — Mobbin: Linear "Ask Linear"
// floating panel (mobbin.com/screens/51c2bd60-f22d-4879-8c28-c5800ac1f4b6),
// Ferndesk floating agent card (mobbin.com/screens/0e209d9a-bd32-4bfc-9818-
// acd69949f45e), Notion AI's quiet inline "Searching the web" activity line
// (mobbin.com/screens/2c72548e-6813-4575-8861-29ebf927a221).
export function AssistantChat() {
  const reduceMotion = useReducedMotion() ?? false;
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const account = useClientStore((s) => s.account);
  const threadAccount = useClientStore((s) => s.threadAccount);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const chatScopeKind = useClientStore((s) => s.chatScopeKind);
  const chatScopeAreaId = useClientStore((s) => s.chatScopeAreaId);
  const chatScopeWorkId = useClientStore((s) => s.chatScopeWorkId);
  const setChatScope = useClientStore((s) => s.setChatScope);
  const scopeKey = `${chatScopeKind}:${chatScopeAreaId || ''}:${chatScopeWorkId || ''}`;

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
        body: {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          extraSystem:
            chatScopeKind === 'work' && chatScopeWorkId
              ? `This conversation is scoped to Albatross Work ${chatScopeWorkId}. Keep questions and actions about that Work unless the user explicitly broadens scope.`
              : chatScopeKind === 'area' && chatScopeAreaId
                ? `This conversation is scoped to Albatross Area ${chatScopeAreaId}. Keep context and questions within that Area unless the user explicitly broadens scope.`
                : undefined,
        },
      }),
    [chatScopeAreaId, chatScopeKind, chatScopeWorkId],
  );
  const shouldAutoContinueHitl = useMemo(() => createHitlAutoContinueGuard(), []);
  const { messages, sendMessage, status, stop, error, setMessages, addToolResult, regenerate } = useChat({
    transport,
    // Auto-continue ONLY after the user answers a human-in-the-loop tool call
    // (ask_user, ask_approval, ask_parameters, ask_preferences,
    // ask_question_flow). The built-in
    // lastAssistantMessageIsCompleteWithToolCalls also fires after ordinary
    // server-tool turns, which can resubmit in a loop — our server already
    // runs server tools to completion in one response.
    sendAutomaticallyWhen: ({ messages: msgs }) => shouldAutoContinueHitl(msgs as any),
  });

  // Hand human-in-the-loop answers back into the stream. Memoized so the
  // context value is stable across renders.
  const answerHitl = useCallback(
    (tool: string, toolCallId: string, output: Record<string, unknown>) => {
      void addToolResult({ tool: tool as any, toolCallId, output });
    },
    [addToolResult],
  );

  // The model (esp. gpt-5.x via OpenRouter) intermittently returns an EMPTY
  // completion — finishReason 'other', zero tokens — which lands as a blank
  // assistant turn ("loads, then nothing"). Transparently retry an empty turn a
  // couple times so the chat recovers instead of silently dropping.
  const emptyRetryCount = useRef(0);
  useEffect(() => {
    if (status !== 'ready') return;
    const last = messages[messages.length - 1] as any;
    if (!last || last.role !== 'assistant') return;
    if (hasVisibleContent(last)) {
      emptyRetryCount.current = 0;
      return;
    }
    if (emptyRetryCount.current >= 2) return; // cap retries; Continue button remains
    emptyRetryCount.current += 1;
    void regenerate();
  }, [status, messages, regenerate]);

  // --- Persistent sessions: restore the last chat, autosave as you go ---
  const lastChatId = useClientStore((s) => s.lastChatId);
  const lastChatAt = useClientStore((s) => s.lastChatAt);
  const setLastChatId = useClientStore((s) => s.setLastChatId);
  const sessionIdRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const priorScopeRef = useRef(scopeKey);

  useEffect(() => {
    if (priorScopeRef.current === scopeKey) return;
    priorScopeRef.current = scopeKey;
    sessionIdRef.current = null;
    setMessages([]);
  }, [scopeKey, setMessages]);

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
    if (chatScopeKind === 'global' && lastChatId && fresh && messages.length === 0) {
      sessionIdRef.current = lastChatId;
      void loadSession(lastChatId);
    }
  }, [aiBarOpen, chatScopeKind, lastChatId, lastChatAt, messages.length, loadSession]);

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
        body: JSON.stringify({
          id,
          messages,
          scopeKind: chatScopeKind,
          areaId: chatScopeAreaId || undefined,
          workId: chatScopeWorkId || undefined,
        }),
      })
        .then(() => qc.invalidateQueries({ queryKey: ['chat-sessions'] }))
        .catch(() => undefined);
    }, 600);
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
  }, [chatScopeAreaId, chatScopeKind, chatScopeWorkId, messages, status, qc]);

  const startNewChat = useCallback(() => {
    sessionIdRef.current = null;
    setLastChatId(null);
    setMessages([]);
  }, [setLastChatId, setMessages]);

  const { data: sessionsData } = useQuery({
    queryKey: ['chat-sessions', scopeKey],
    queryFn: async () => {
      const params = new URLSearchParams({ scopeKind: chatScopeKind });
      if (chatScopeAreaId) params.set('areaId', chatScopeAreaId);
      if (chatScopeWorkId) params.set('workId', chatScopeWorkId);
      const res = await fetch(`/api/chats?${params.toString()}`);
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

  // Esc dismisses the floating panel — even from the composer (the field is
  // auto-focused, so a typing exception would leave Esc dead). Radix layers
  // (menus, dropdowns) preventDefault their own Escape, so they close first.
  // Draft text survives: the panel stays mounted, only hidden.
  useEffect(() => {
    if (!aiBarOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setAiBarOpen(false);
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

  // Message count from the previous commit — messages at or above this index
  // mounted in this commit (a restored batch gets staggered entrances, a
  // freshly streamed message floats in immediately).
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    const filesForTurn = pendingFiles;
    if ((!trimmed && !filesForTurn.length) || busy) return;
    emptyRetryCount.current = 0; // fresh turn — reset empty-completion retries

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
      if (chatScopeKind === 'global') setLastChatId(sessionIdRef.current);
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
      chatScopeKind === 'work' && chatScopeWorkId
        ? `This conversation is scoped to Albatross Work ${chatScopeWorkId}. Keep questions and actions about that Work unless the user explicitly broadens scope.`
        : '',
      chatScopeKind === 'area' && chatScopeAreaId
        ? `This conversation is scoped to Albatross Area ${chatScopeAreaId}. Keep context and questions within that Area unless the user explicitly broadens scope.`
        : '',
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

  const last = messages[messages.length - 1];
  const showLoader = busy && (last?.role !== 'assistant' || !hasVisibleContent(last));

  // Stagger only the batch that mounts together (a restored conversation).
  // A message appended while chatting has index >= the previous commit's
  // length, so it springs in immediately with no queued delay.
  const staggerFloor = prevMessageCountRef.current;

  return (
    <AnimatePresence>
      {aiBarOpen ? (
        <>
          {/* The dreamy layer: the app's own dot grid, accent-tinted, revealed
              around the cursor while the assistant is open. Quiet by design —
              pointer-events-none, no shader washes. */}
          <motion.div
            key="assistant-glow"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.4 }}
            className="pointer-events-none fixed inset-0 z-40"
          >
            <DotGridGlow />
          </motion.div>

          <motion.section
            key="assistant-panel"
            role="dialog"
            aria-label="Assistant"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 26, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
            transition={
              reduceMotion ? { duration: 0.1 } : { type: 'spring', stiffness: 380, damping: 32, mass: 0.9 }
            }
            className="fixed inset-x-3 bottom-3 z-50 flex h-[min(620px,calc(100dvh-24px))] flex-col overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/85 shadow-[0_32px_90px_-28px_rgb(0_0_0/0.45),var(--shadow-soft)] backdrop-blur-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[min(660px,calc(100dvh-48px))] sm:w-[420px]"
          >
            <header className="flex items-center justify-between gap-2 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2 text-[13px]">
                {/* Assistant presence: a still gradient pearl that only turns
                while the model is actually streaming. */}
                <span
                  aria-hidden
                  className={cn(
                    'flex shrink-0 items-center justify-center',
                    !streaming && '[&_.siri-orb::before]:[animation-play-state:paused]',
                  )}
                >
                  <SiriOrb size="20px" animationDuration={7} colors={ORB_COLORS} />
                </span>
                <button
                  type="button"
                  title={
                    chatScopeKind === 'global'
                      ? 'Global Albatross conversation'
                      : 'Return to global conversation'
                  }
                  onClick={() => {
                    if (chatScopeKind !== 'global') setChatScope({ kind: 'global' });
                  }}
                  className="truncate font-medium text-[var(--color-text)] hover:underline"
                >
                  Albatross{chatScopeKind === 'work' ? ' · Work' : chatScopeKind === 'area' ? ' · Area' : ''}
                </button>
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
                <ChatContainerContent className="gap-4 px-3.5 py-4">
                  <ChatPartContext.Provider
                    value={{
                      answer: answerHitl,
                      openDraft: (draft) =>
                        openComposeNew({
                          to: draft.to,
                          cc: draft.cc,
                          bcc: draft.bcc,
                          subject: draft.subject,
                          body: draft.body,
                        }),
                    }}
                  >
                    {messages.map((m, i) => (
                      <MessageFloat
                        key={m.id}
                        reduceMotion={reduceMotion}
                        delay={i < staggerFloor ? 0 : Math.min((i - staggerFloor) * 0.05, 0.3)}
                      >
                        <MessageView message={m} />
                      </MessageFloat>
                    ))}
                  </ChatPartContext.Provider>
                  {showLoader ? (
                    <div className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-[var(--color-text-muted)]">
                      <Loader variant="typing" />
                    </div>
                  ) : null}
                  {error ? (
                    <div className="space-y-1.5 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
                      <div>{error.message}</div>
                      {/* Long conversations can hit a limit mid-turn; let the user
                    pick up where it stopped (the server windows the transcript,
                    so the retry fits). */}
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
                <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                  <ScrollButton className="pointer-events-auto shadow-[var(--shadow-pop)]" />
                </div>
              </ChatContainerRoot>
            )}

            {/* Composer: a rounded floating field pinned to the panel bottom —
            no hard border-t seam, it hovers over the translucent surface. */}
            <div ref={inputWrapRef} className="p-3 pt-1.5">
              <PromptInput
                value={input}
                onValueChange={setInput}
                isLoading={busy}
                onSubmit={submit}
                maxHeight={176}
                className="rounded-2xl border-[var(--color-control-border)] bg-[var(--color-control)]/95 shadow-[var(--shadow-pop)]"
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
                          aria-label={`Remove ${file.name}`}
                          title={`Remove ${file.name}`}
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
        </>
      ) : null}
    </AnimatePresence>
  );
}

// Soft spring entrance for each chat message; instant under reduced motion.
function MessageFloat({
  delay,
  reduceMotion,
  children,
}: {
  delay: number;
  reduceMotion: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 460, damping: 38, delay }}
      className="flex w-full min-w-0 flex-col"
    >
      {children}
    </motion.div>
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

// Lets the deeply-nested Part renderer hand human-in-the-loop answers back to
// useChat, and route "open this draft" requests into the real composer.
interface ChatPartHandlers {
  answer: (tool: string, toolCallId: string, output: Record<string, unknown>) => void;
  openDraft?: (draft: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string }) => void;
}
const ChatPartContext = createContext<ChatPartHandlers>({ answer: () => {} });

// Renders the agent's questionnaire (the ask_user HITL tool) — up to four
// questions, each choice-based or free-text. Answers go back via addToolResult,
// which auto-continues the agent.
function AskUserPart({ part }: { part: any }) {
  const { answer } = useContext(ChatPartContext);
  const input = part.input || {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const state = part.state;
  if (state === 'input-streaming') return null;
  if (!questions.length) return null;
  const answered = state === 'output-available';
  const answers = Array.isArray(part.output?.answers) ? part.output.answers : [];
  return (
    <AskUserForm
      questions={questions}
      answered={answered}
      answers={answers}
      onSubmit={(a: AskAnswer[]) => answer('ask_user', part.toolCallId, { answers: a })}
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
    const toolName = toolPartName(part);
    if (toolName === 'ask_user') return <AskUserPart part={part} />;
    if (isHitlToolName(toolName)) return <HitlToolPart toolName={toolName} part={part} />;
    // Successful display tools render their designed tool-ui component; the
    // quiet activity row still covers running/failed states below.
    const state = part.state || 'input-available';
    if (
      TOOL_UI_RENDERED_TOOLS.has(toolName) &&
      toolActivityState(state, part.output) === 'done' &&
      part.output?.ok
    ) {
      return <RichDisplayPart toolName={toolName} output={part.output} />;
    }
    // One consistent tool-activity grammar — the same quiet sentence rows the
    // Teach chat renders (components/ai-elements/tool-activity.tsx).
    return (
      <ToolActivityRow
        activity={toolActivityLine(toolName, part.input, state, part.output, part.errorText)}
      />
    );
  }
  return null;
}

// Non-ask_user human-in-the-loop forms (approval card, sliders, preferences,
// question flow), wired to the same addToolResult continuation.
function HitlToolPart({ toolName, part }: { toolName: string; part: any }) {
  const { answer } = useContext(ChatPartContext);
  return (
    <HitlPart
      toolName={toolName}
      part={part}
      onResult={(output) => answer(toolName, part.toolCallId, output)}
    />
  );
}

// A successful show_* tool output, rendered with its tool-ui component. Falls
// back to null (→ activity row) when the payload is not renderable.
function RichDisplayPart({ toolName, output }: { toolName: string; output: any }) {
  const { openDraft } = useContext(ChatPartContext);
  return <ToolUiDisplayPart toolName={toolName} output={output} onOpenDraft={openDraft} />;
}
