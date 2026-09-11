'use client';

import { useChat } from '@ai-sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChatTransport, DefaultChatTransport, type UIMessage } from 'ai';
import { Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AskAnswer, AskUserForm } from '@/components/ai-elements/choice-prompt';
import { HitlPart } from '@/components/ai-elements/hitl-parts';
import { RevealDot } from '@/components/ai-elements/reveal-dot';
import { ToolActivityRow } from '@/components/ai-elements/tool-activity';
import { TOOL_UI_RENDERED_TOOLS, ToolUiDisplayPart } from '@/components/ai-elements/tool-ui-part';
import { WorkLog } from '@/components/ai-elements/work-log';
import {
  AskHoldComposer,
  type AskHoldComposerProps,
  type DoorRequest,
} from '@/components/shell/AskHoldComposer';
import { AssistantGreeting } from '@/components/shell/AssistantGreeting';
import { HoldThisControl } from '@/components/shell/HoldThisControl';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import SiriOrb from '@/components/smoothui/siri-orb';
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
import { Markdown } from '@/components/ui/markdown';
import { Message, MessageContent } from '@/components/ui/message';
import { PlusIcon } from '@/components/ui/plus';
import { PromptSuggestion } from '@/components/ui/prompt-suggestion';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ui/reasoning';
import { RowIcon } from '@/components/ui/row-icon';
import { ScrollButton } from '@/components/ui/scroll-button';
import { routeEmailPreviewThread } from '@/lib/ai/email-preview-routing';
import { type HoldCard, holdText, kickAdvance } from '@/lib/albatross/capture-client';
import {
  createHitlAutoContinueGuard,
  isHitlToolName,
  toolActivityLine,
  toolActivityState,
  toolPartName,
} from '@/lib/albatross/teach-ui';
import { groupMessageParts, reasoningLabel, toolPartSignature } from '@/lib/chat/work-log';
import { assistantLauncherPlacement, isAssistantShortcut, useClientStore } from '@/lib/client-state';
import { mailSearchShortcutLabel } from '@/lib/mail/search/focus-contract';
import { formatDate } from '@/lib/shared/format';
import { assistantPageContext, assistantPhrases } from '@/lib/shell/assistant-context';
import { cn } from '@/lib/utils';
import { AssistantLauncher } from './ShellActions';

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
// A quiet, raised control; shortcut handling stays mounted while the panel is open.
export function AIBarTrigger() {
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const threadFullscreen = useClientStore((s) => s.threadFullscreen);
  const readerOpen = useClientStore((s) => !!(s.selectedThreadId || s.compose.mode));
  const primaryView = useClientStore((s) => s.primaryView);
  const assistantDocument = useClientStore((s) => s.assistantDocument);
  const [shortcut, setShortcut] = useState('⌘K');
  useEffect(() => {
    setShortcut(mailSearchShortcutLabel(navigator.platform).replace('F', 'K'));
  }, []);

  // ⌘K toggles the assistant panel from anywhere in the shell, including
  // while the button itself is hidden behind the open panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isAssistantShortcut(e)) {
        e.preventDefault();
        if (!aiBarOpen) {
          const launcher = document.querySelector<HTMLButtonElement>('[data-assistant-launcher]');
          if (launcher) {
            // The shortcut opens the exact invitation currently on the button,
            // including its document context and chosen presentation.
            launcher.click();
            return;
          }
          const state = useClientStore.getState();
          state.setAssistantInvitation(assistantPhrases(state.primaryView, state.assistantDocument)[0]);
        }
        setAiBarOpen(!aiBarOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setAiBarOpen, aiBarOpen]);

  // The open panel owns its own pane and Close button, and the fullscreen
  // reader popout owns the whole window — no floating chrome above either.
  // An open reader's action bar shares this corner, so the launcher stacks
  // above it rather than overlapping. The capture pill is gone: the bar is
  // the one door for Hold.
  const placement = assistantLauncherPlacement({
    aiBarOpen,
    threadFullscreen,
    capturePillVisible: false,
    readerOpen,
  });
  if (placement === 'hidden') return null;

  return (
    <AssistantLauncher
      placement={placement}
      shortcut={shortcut}
      phrases={assistantPhrases(primaryView, assistantDocument)}
      onOpen={(phrase) => {
        useClientStore.getState().setAssistantInvitation(phrase);
        if (primaryView === 'files' && assistantDocument)
          useClientStore.getState().setAssistantPresentation('split');
        else setAiBarOpen(true);
      }}
    />
  );
}

// One conversation owner across corner, split, and chat-only presentations.
// AssistantWorkspace owns the outer frame; transport, tool cards, attachments
// and composer state stay mounted here when that presentation changes.
export function AssistantChat({
  transport: previewTransport,
  preview = false,
  clerkEnabled = false,
  userName,
}: {
  transport?: ChatTransport<UIMessage>;
  preview?: boolean;
  clerkEnabled?: boolean;
  userName?: string;
} = {}) {
  const reduceMotion = useReducedMotion() ?? false;
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const presentation = useClientStore((s) => s.assistantPresentation);
  const setPresentation = useClientStore((s) => s.setAssistantPresentation);
  const account = useClientStore((s) => s.account);
  const threadAccount = useClientStore((s) => s.threadAccount);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const invitation = useClientStore((s) => s.assistantInvitation);
  const pendingBriefResponse = useClientStore((s) => s.assistantBriefRequest);
  const briefContext = useClientStore((s) => s.assistantBriefContext);
  const primaryView = useClientStore((s) => s.primaryView);
  const assistantDocument = useClientStore((s) => s.assistantDocument);
  const chatScopeKind = useClientStore((s) => s.chatScopeKind);
  const chatScopeAreaId = useClientStore((s) => s.chatScopeAreaId);
  const chatScopeWorkId = useClientStore((s) => s.chatScopeWorkId);
  const chatScopeLabel = useClientStore((s) => s.chatScopeLabel);
  const setChatScope = useClientStore((s) => s.setChatScope);
  const scopeKey = `${chatScopeKind}:${chatScopeAreaId || ''}:${chatScopeWorkId || ''}`;

  const setQuery = useClientStore((s) => s.setQuery);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  const qc = useQueryClient();

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
        body: () => ({
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          briefResponse: useClientStore.getState().assistantBriefContext?.reference,
          areaDiscovery:
            !useClientStore.getState().assistantBriefContext && chatScopeKind === 'area' && chatScopeAreaId
              ? { mode: 'area', areaId: chatScopeAreaId }
              : undefined,
          contextAttachments:
            !useClientStore.getState().assistantBriefContext && chatScopeKind === 'work' && chatScopeWorkId
              ? [{ kind: 'work', id: chatScopeWorkId }]
              : undefined,
          extraSystem: [
            assistantPageContext(
              useClientStore.getState().primaryView,
              useClientStore.getState().assistantDocument,
            ),
            chatScopeKind === 'area' && chatScopeAreaId
              ? `This conversation is scoped to Albatross Area ${chatScopeAreaId}. Keep context and questions within that Area unless the user explicitly broadens scope.`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }),
      }),
    [chatScopeAreaId, chatScopeKind, chatScopeWorkId],
  );
  const shouldAutoContinueHitl = useMemo(() => createHitlAutoContinueGuard(), []);
  const { messages, sendMessage, status, stop, error, setMessages, addToolResult, regenerate } = useChat({
    transport: previewTransport ?? transport,
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

  const streaming = status === 'streaming' || status === 'submitted';
  const busy = streaming || uploadingFiles;

  // --- Persistent sessions: restore the last chat, autosave as you go ---
  const lastChatId = useClientStore((s) => s.lastChatId);
  const lastChatAt = useClientStore((s) => s.lastChatAt);
  const setLastChatId = useClientStore((s) => s.setLastChatId);
  const sessionIdRef = useRef<string | null>(null);
  const sessionLoadGenerationRef = useRef(0);
  const activeScopeKeyRef = useRef(scopeKey);
  activeScopeKeyRef.current = scopeKey;
  const restoredRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const priorScopeRef = useRef(scopeKey);

  useEffect(() => {
    if (priorScopeRef.current === scopeKey) return;
    priorScopeRef.current = scopeKey;
    sessionLoadGenerationRef.current += 1;
    sessionIdRef.current = null;
    setMessages([]);
  }, [scopeKey, setMessages]);

  const loadSession = useCallback(
    async (id: string) => {
      if (busy) return false;
      const generation = ++sessionLoadGenerationRef.current;
      const loadScopeKey = activeScopeKeyRef.current;
      try {
        const res = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (generation !== sessionLoadGenerationRef.current || loadScopeKey !== activeScopeKeyRef.current) {
          return false;
        }
        if (data?.ok && Array.isArray(data.session?.messages)) {
          useClientStore.getState().clearBriefResponse();
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
    [busy, setLastChatId, setMessages],
  );

  // First open: pick up where the user left off — but only if that
  // conversation is RECENT. Restoring an hours-old thread on cmd+k reads as
  // a bug, not a continuation; stale sessions stay in history instead.
  const CHAT_RESTORE_WINDOW_MS = 30 * 60_000;
  useEffect(() => {
    if (preview || !aiBarOpen || restoredRef.current) return;
    restoredRef.current = true;
    const fresh = lastChatAt && Date.now() - lastChatAt < CHAT_RESTORE_WINDOW_MS;
    if (
      !useClientStore.getState().assistantBriefRequest &&
      chatScopeKind === 'global' &&
      lastChatId &&
      fresh &&
      messages.length === 0
    ) {
      sessionIdRef.current = lastChatId;
      void loadSession(lastChatId);
    }
  }, [preview, aiBarOpen, chatScopeKind, lastChatId, lastChatAt, messages.length, loadSession]);

  // Autosave once the stream settles (debounced so multi-step turns save once).
  useEffect(() => {
    if (preview || status === 'streaming' || status === 'submitted') return;
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
  }, [preview, chatScopeAreaId, chatScopeKind, chatScopeWorkId, messages, status, qc]);

  const startNewChat = useCallback(() => {
    if (busy) return;
    sessionLoadGenerationRef.current += 1;
    sessionIdRef.current = null;
    useClientStore.getState().clearBriefResponse();
    setLastChatId(null);
    setMessages([]);
  }, [busy, setLastChatId, setMessages]);

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
    enabled: aiBarOpen && !preview,
    staleTime: 30_000,
  });
  const chatSessions = sessionsData || [];

  // Auto-focus the textarea when the sidebar opens.
  useEffect(() => {
    if (aiBarOpen) requestAnimationFrame(() => inputWrapRef.current?.querySelector('textarea')?.focus());
  }, [aiBarOpen]);

  // The capture door. The rail button, the "n" shortcut, a selection, and
  // the empty states all raise `captureOpen`. The bar opens with the chip
  // preset to Hold and the seed text in the field. The takeover is gone.
  const captureOpen = useClientStore((s) => s.captureOpen);
  const captureSeed = useClientStore((s) => s.captureSeed);
  const setCaptureOpen = useClientStore((s) => s.setCaptureOpen);
  const [door, setDoor] = useState<DoorRequest | null>(null);
  useEffect(() => {
    if (!captureOpen) return;
    setDoor((current) => ({ seed: captureSeed, nonce: (current?.nonce ?? 0) + 1 }));
    setAiBarOpen(true);
    setCaptureOpen(false);
  }, [captureOpen, captureSeed, setAiBarOpen, setCaptureOpen]);

  // Hold from the bar: one capture with the chat conversation as its source.
  // The response carries the parsed cards for the landing. New Work gets its
  // plan kick after the landing, never before the user saw the card.
  const holdFromBar = useCallback(async (text: string): Promise<HoldCard[]> => {
    const result = await holdText({ text, conversationId: sessionIdRef.current || newChatId() });
    return result.cards;
  }, []);
  const afterHeld = useCallback((cards: HoldCard[]) => {
    void kickAdvance(cards.map((card) => card.id));
  }, []);

  const messageSnapshot = useRef(messages);
  messageSnapshot.current = messages;
  const toolSignature = toolPartSignature(messages);

  const partHandlers = useMemo<ChatPartHandlers>(
    () => ({
      answer: answerHitl,
      openDraft: (draft) => openComposeNew(draft),
      openThread: (target) => routeEmailPreviewThread(target, { setThreadAccount, setSelectedThread }),
    }),
    [answerHitl, openComposeNew, setThreadAccount, setSelectedThread],
  );

  // --- UI tool intercept ---
  const handled = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!toolSignature || preview) return;
    for (const m of messageSnapshot.current) {
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
        if (name?.startsWith('document_') && (part as any).state === 'output-available') {
          const result = (part as any).output;
          const id = (part as any).toolCallId;
          if (result?.documentId && id && !handled.current.has(id)) {
            handled.current.add(id);
            void qc.invalidateQueries({ queryKey: ['document', result.documentId] });
          }
        }
        if (name === 'google_document_edit' && (part as any).state === 'output-available') {
          const result = (part as any).output;
          const id = (part as any).toolCallId;
          if (result?.status === 'proposed' && result.fileId && id && !handled.current.has(id)) {
            handled.current.add(id);
            qc.setQueryData(
              ['google-document-suggestions', result.connectionId, result.fileId],
              (current: any[] = []) =>
                current.some((item) => item.suggestionId === result.suggestionId)
                  ? current
                  : [...current, result],
            );
          }
        }
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
    toolSignature,
    preview,
    qc,
    setQuery,
    setSelectedThread,
    openComposeNew,
    setThreadAccount,
    setPendingReplyBody,
    setAiBarOpen,
  ]);

  // Refresh server queries when any mutating mail tool finishes.
  useEffect(() => {
    if (!toolSignature || preview) return;
    for (const m of messageSnapshot.current) {
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
  }, [toolSignature, preview, qc]);

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
    if ((!trimmed && !filesForTurn.length) || busy) return false;
    sessionLoadGenerationRef.current += 1;
    emptyRetryCount.current = 0; // fresh turn — reset empty-completion retries

    let stagedUploads: StagedChatUpload[] = [];
    if (filesForTurn.length) {
      setUploadingFiles(true);
      try {
        stagedUploads = await stageChatFiles(filesForTurn);
      } catch (err: any) {
        toast.error(err?.message || 'Could not upload files for the assistant');
        setUploadingFiles(false);
        return false;
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
      assistantPageContext(
        useClientStore.getState().primaryView,
        useClientStore.getState().assistantDocument,
      ),
      activeAccount
        ? `Active account: ${activeAccount}`
        : 'Working across all mailboxes (call list_accounts to enumerate).',
      selectedThreadId ? `Currently focused thread id: ${selectedThreadId}` : '',
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
    setPendingFiles([]);
    sendMessage(
      { text: trimmed || 'Use the attached file(s).', ...(files ? { files } : {}) } as any,
      {
        body: {
          extraSystem: [contextLines, uploadContext].filter(Boolean).join('\n\n') || undefined,
          contextAttachments:
            !useClientStore.getState().assistantBriefContext && chatScopeKind === 'work' && chatScopeWorkId
              ? [{ kind: 'work', id: chatScopeWorkId }]
              : undefined,
        },
      } as any,
    );
    return true;
  };

  useEffect(() => {
    if (!pendingBriefResponse || busy) return;
    if (chatScopeKind !== 'global') {
      // Finish and save the existing scoped turn before opening this distinct
      // handoff. Otherwise a response about Work B would be saved under Work A.
      if (sessionIdRef.current && messages.length) {
        void fetch('/api/chats', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: sessionIdRef.current,
            messages,
            scopeKind: chatScopeKind,
            areaId: chatScopeAreaId || undefined,
            workId: chatScopeWorkId || undefined,
          }),
        }).catch(() => undefined);
      }
      restoredRef.current = true;
      setChatScope({ kind: 'global' });
      return;
    }
    const request = useClientStore.getState().claimBriefResponse(pendingBriefResponse.id);
    if (!request) return; // Atomic claim also prevents Strict Mode double submission.
    sessionLoadGenerationRef.current += 1;
    emptyRetryCount.current = 0;
    restoredRef.current = true;
    if (!sessionIdRef.current) {
      sessionIdRef.current = newChatId();
      if (chatScopeKind === 'global') setLastChatId(sessionIdRef.current);
    }
    void sendMessage(
      { text: `Regarding “${request.title}”:\n${request.response}` },
      {
        body: {
          briefResponse: request.reference,
          contextAttachments: [],
          areaDiscovery: undefined,
          extraSystem: undefined,
        },
      },
    );
  }, [
    pendingBriefResponse,
    busy,
    sendMessage,
    chatScopeKind,
    chatScopeAreaId,
    chatScopeWorkId,
    messages,
    setChatScope,
    setLastChatId,
  ]);

  const last = messages[messages.length - 1];
  const waitingForContent = busy && (last?.role !== 'assistant' || !hasVisibleContent(last));

  // Stagger only the batch that mounts together (a restored conversation).
  // A message appended while chatting has index >= the previous commit's
  // length, so it springs in immediately with no queued delay.
  const staggerFloor = prevMessageCountRef.current;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header
        data-assistant-header
        className="rounded-ui mx-3 mb-1 mt-3 flex shrink-0 items-center justify-between gap-2 border border-[color-mix(in_oklab,var(--color-border)_55%,transparent)] bg-[var(--color-content)] px-2 py-1.5 shadow-[0_2px_10px_rgb(15_23_42/0.025)]"
      >
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
              chatScopeKind === 'global' ? 'Global Albatross conversation' : 'Return to global conversation'
            }
            onClick={() => {
              if (chatScopeKind !== 'global') setChatScope({ kind: 'global' });
            }}
            disabled={busy || chatScopeKind === 'global'}
            className="truncate font-medium text-[var(--color-text)] enabled:hover:underline disabled:cursor-default disabled:opacity-70"
          >
            {chatScopeKind === 'global'
              ? 'Albatross'
              : chatScopeLabel || (chatScopeKind === 'work' ? 'Attached Work' : 'Attached Area')}
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPresentation(presentation === 'full' ? 'split' : 'full')}
            title={presentation === 'full' ? 'Show current page' : 'Focus on chat'}
            aria-label={presentation === 'full' ? 'Show current page' : 'Focus on chat'}
            className="hidden md:inline-flex"
          >
            {presentation === 'full' ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPresentation(presentation === 'corner' ? 'split' : 'corner')}
            title={presentation === 'corner' ? 'Expand chat beside this page' : 'Return to corner chat'}
            aria-label={presentation === 'corner' ? 'Expand chat beside this page' : 'Return to corner chat'}
            className="hidden md:inline-flex"
          >
            {presentation === 'corner' ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={startNewChat}
            disabled={busy}
            title="New chat"
            className="size-11 text-[var(--color-text-muted)] hover:text-[var(--color-text)] md:size-8"
          >
            <RowIcon icon={PlusIcon} size={14} />
            <span className="sr-only">New chat</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                title="Chat history"
                className="size-11 text-[var(--color-text-muted)] hover:text-[var(--color-text)] md:size-8"
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
                    disabled={busy}
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
              <DropdownMenuItem onSelect={startNewChat} disabled={busy}>
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
            className="size-11 text-[var(--color-text-muted)] hover:text-[var(--color-text)] md:size-8"
          >
            <X className="h-3.5 w-3.5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </header>

      {briefContext || pendingBriefResponse ? (
        <div
          className="mx-3 mb-2 flex items-center justify-between gap-2 text-[11px] text-[var(--color-text-muted)]"
          data-assistant-brief-context
        >
          <span className="truncate">
            {pendingBriefResponse ? 'Up next · ' : 'From your brief · '}
            {(pendingBriefResponse || briefContext)?.title}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy && !pendingBriefResponse}
            onClick={() => {
              if (pendingBriefResponse) useClientStore.setState({ assistantBriefRequest: null });
              else useClientStore.getState().clearBriefResponse();
            }}
          >
            {pendingBriefResponse ? 'Cancel' : 'Detach'}
          </Button>
        </div>
      ) : null}
      {messages.length === 0 ? (
        <div className="scrollable flex flex-1 flex-col items-center justify-center gap-5 px-5 py-8 text-center">
          <AssistantGreeting
            phrase={invitation || assistantPhrases(primaryView, assistantDocument)[0]}
            clerkEnabled={clerkEnabled}
            userName={userName}
          />
          <div className="flex w-full max-w-[320px] flex-col gap-2">
            {(primaryView === 'files' && assistantDocument
              ? assistantPhrases(primaryView, assistantDocument)
              : chatScopeKind === 'work'
                ? WORK_SUGGESTIONS
                : selectedThreadId
                  ? THREAD_SUGGESTIONS
                  : BASE_SUGGESTIONS
            ).map((s) => (
              <PromptSuggestion
                key={s}
                variant="outline"
                onClick={() => void send(s)}
                className="h-auto w-full justify-start whitespace-normal rounded-ui border-[var(--color-control-border)] bg-[var(--color-control)] px-3 py-2.5 text-left text-[12.5px] font-normal text-[var(--color-text)] shadow-none transition-colors hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
              >
                {s}
              </PromptSuggestion>
            ))}
          </div>
        </div>
      ) : (
        <ChatContainerRoot className="relative flex-1">
          <ChatContainerContent className="gap-4 px-3.5 py-4">
            <ChatPartContext.Provider value={partHandlers}>
              {messages.map((m, i) => (
                <MessageFloat
                  key={m.id}
                  reduceMotion={reduceMotion}
                  delay={i < staggerFloor ? 0 : Math.min((i - staggerFloor) * 0.05, 0.3)}
                >
                  <MessageView
                    message={m}
                    streaming={streaming && i === messages.length - 1}
                    hold={
                      m.role === 'assistant' && sessionIdRef.current
                        ? {
                            conversationId: sessionIdRef.current,
                            userText: precedingUserText(messages, i),
                            onKept: afterHeld,
                          }
                        : undefined
                    }
                  />
                </MessageFloat>
              ))}
            </ChatPartContext.Provider>
            {waitingForContent ? (
              <div className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-[var(--color-text-muted)]">
                <span role="status" aria-label="Working">
                  <RevealDot />
                </span>
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
      <div ref={inputWrapRef}>
        {primaryView === 'files' && assistantDocument ? (
          <p
            data-assistant-document-context
            className="mb-2 truncate px-1 text-[11px] text-[var(--color-text-muted)]"
            title={assistantDocument.title}
          >
            {assistantDocument.title}
            {assistantDocument.dirty ? ' · Unsaved changes' : ''}
          </p>
        ) : null}
        <ChatComposer
          placeholder={
            primaryView === 'files' && assistantDocument
              ? 'Describe the changes you have in mind…'
              : undefined
          }
          busy={busy}
          streaming={streaming}
          hasFiles={pendingFiles.length > 0}
          onSendText={send}
          onStop={stop}
          onHold={holdFromBar}
          onHeld={afterHeld}
          door={door}
          reduceMotion={reduceMotion}
          before={
            <>
              {chatScopeKind !== 'global' ? (
                <div className="flex px-1 pt-1">
                  <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-ui border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] px-2.5 py-1 text-[10.5px] text-[var(--color-accent)]">
                    <span className="truncate">
                      {chatScopeKind === 'work' ? 'Work' : 'Area'}: {chatScopeLabel || 'Current context'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setChatScope({ kind: 'global' })}
                      disabled={busy}
                      aria-label={`Detach ${chatScopeKind}`}
                      title={`Detach ${chatScopeKind}`}
                      className="shrink-0 enabled:hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                </div>
              ) : null}
              {pendingFiles.length ? (
                <div className="flex flex-wrap gap-1 px-1 pb-1">
                  {pendingFiles.map((file, index) => (
                    <span
                      key={`${file.name}-${file.size}-${file.lastModified}`}
                      className="inline-flex items-center gap-1 rounded-ui border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--color-text-muted)]"
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
            </>
          }
          leading={
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                title="Attach a file for the assistant"
                className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              >
                <Paperclip className="size-3.5" />
                <span className="sr-only">Attach file</span>
              </Button>
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
            </>
          }
        />
      </div>
    </div>
  );
}

// Soft spring entrance for each chat message; instant under reduced motion.
const MessageFloat = memo(function MessageFloat({
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
});

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

const WORK_SUGGESTIONS = [
  'I have already made progress. Search my connected sources and update this plan.',
  'What is the next concrete step?',
  'Check whether the evidence says any step is already done.',
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

interface HoldReplyContext {
  conversationId: string;
  userText: string;
  onKept?: (cards: HoldCard[]) => void;
}

export const MessageView = memo(
  function MessageView({
    message,
    streaming = false,
    hold,
  }: {
    message: any;
    streaming?: boolean;
    hold?: HoldReplyContext;
  }) {
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
    const replyText = streaming ? '' : replyTextFromMessage(message);
    return (
      <Message className="justify-start">
        <div className="flex w-full min-w-0 flex-col gap-2">
          <Thought parts={message.parts || []} streaming={streaming} />
          {groupMessageParts(message.parts || []).map((segment) =>
            segment.kind === 'work-log' ? (
              <WorkLog
                key={segment.key}
                rows={segment.rows}
                finished={!streaming}
                renderRich={renderRichTool}
              />
            ) : segment.part.type === 'reasoning' || segment.part.type === 'thinking' ? null : (
              <Part key={`${message.id}-${segment.index}`} part={segment.part} streaming={streaming} />
            ),
          )}
          {hold && replyText ? (
            <HoldThisControl
              messageId={String(message.id)}
              conversationId={hold.conversationId}
              userText={hold.userText}
              replyText={replyText}
              onKept={(result) => hold.onKept?.(result.existing ? [] : result.cards)}
              className="-mt-0.5"
            />
          ) : null}
        </div>
      </Message>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.streaming === next.streaming &&
    previous.hold?.conversationId === next.hold?.conversationId &&
    previous.hold?.userText === next.hold?.userText &&
    previous.hold?.onKept === next.hold?.onKept,
);

function renderRichTool(toolName: string, output: unknown) {
  return <RichDisplayPart toolName={toolName} output={output} />;
}

function Thought({ parts, streaming }: { parts: any[]; streaming: boolean }) {
  const reasoning = parts.filter((part) => part.type === 'reasoning' || part.type === 'thinking');
  const text = reasoning.map((part) => part.text || part.reasoning || '').join('\n');
  const live = streaming && reasoning.some((part) => part.state !== 'done');
  const start = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>();
  useEffect(() => {
    if (live && start.current == null) start.current = Date.now();
    if (!live && start.current != null && duration == null) setDuration(Date.now() - start.current);
  }, [live, duration]);
  if (!text.trim()) return null;
  return (
    <Reasoning className="w-full text-[12px] text-[var(--color-text-muted)]">
      <ReasoningTrigger>{reasoningLabel(live, duration)}</ReasoningTrigger>
      <ReasoningContent markdown className="mt-1.5">
        {text}
      </ReasoningContent>
    </Reasoning>
  );
}

function ChatComposer({
  onSendText,
  hasFiles,
  ...props
}: Omit<AskHoldComposerProps, 'value' | 'onValueChange' | 'canSend' | 'onSend'> & {
  onSendText: (text: string) => Promise<boolean>;
  hasFiles: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <AskHoldComposer
      {...props}
      value={value}
      onValueChange={setValue}
      canSend={Boolean(value.trim()) || hasFiles}
      onSend={() => {
        const sent = value;
        void onSendText(sent).then((accepted) => {
          if (accepted) setValue((current) => (current === sent ? '' : current));
        });
      }}
    />
  );
}

/** The text of an assistant reply: its text parts, joined. Empty for tool-only turns. */
export function replyTextFromMessage(message: any): string {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((part: any) => part && part.type === 'text')
    .map((part: any) => String(part.text || ''))
    .join('\n')
    .trim();
}

/** The user's message the reply at `index` answers: the nearest one above it. */
export function precedingUserText(messages: any[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return userTextFromMessage(messages[i]);
  }
  return '';
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
  openThread?: (target: { account: string; threadId: string }) => void;
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

const Part = memo(function Part({ part, streaming = false }: { part: any; streaming?: boolean }) {
  const type = part.type;
  if (type === 'text') {
    const text = part.text || '';
    // Skip empty text parts (the model emits these between tool calls).
    if (!text.trim()) return null;
    return (
      <Markdown
        streaming={streaming && part.state !== 'done'}
        className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[var(--color-text)] dark:prose-invert [&_a]:text-[var(--color-accent)]"
      >
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
});

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
  const { openDraft, openThread } = useContext(ChatPartContext);
  return (
    <ToolUiDisplayPart
      toolName={toolName}
      output={output}
      onOpenDraft={openDraft}
      onOpenThread={openThread}
    />
  );
}
