'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Pencil as EditIcon,
  ExternalLink,
  Eye,
  Forward as ForwardIcon,
  Paperclip,
  PenLine,
  Reply as ReplyIcon,
  Send as SendIcon,
  Undo2,
  X,
} from 'lucide-react';
import { marked } from 'marked';
import { motion } from 'motion/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import TextareaAutosize from 'react-textarea-autosize';
import { toast } from 'sonner';
import { MessageResponse } from '@/components/ai-elements/message';
import { Avatar } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { callTool } from '@/lib/api-client';
import { type ComposeMode, useClientStore } from '@/lib/client-state';
import { fireSendEffect } from '@/lib/effects/send-effect';
import { sanitizeOutgoingHtml } from '@/lib/sanitize';
import { formatBytes } from '@/lib/shared/files';
import { DEFAULT_UNDO_SEND_SECONDS } from '@/lib/shared/sending';
import { cn } from '@/lib/utils';
import { AttachmentIcon } from './attachment-chip';
import { attachmentPreviewKind, buildAttachmentPreviewItem } from './attachment-preview';

// Hard guard: gmail's hard ceiling is 25MB total per send. We refuse slightly
// under to leave headroom for MIME encoding overhead.
const MAX_TOTAL_BYTES = 23 * 1024 * 1024;
const SEND_STATUS_POLL_INTERVAL_MS = 600;
const SEND_STATUS_CONFIRM_TIMEOUT_MS = 12_000;

interface InlineComposerProps {
  mode: ComposeMode;
  account: string;
  // For reply/reply_all/forward, the message we're anchored to.
  threadId?: string | null;
  anchorMessageId?: string | null;
  // For reply/reply_all, a friendly "Replying to <name>" label.
  replyToLabel?: string;
  // For forward, the local-cache message id used by the server to synth the
  // quoted body. Same as anchorMessageId in practice; named for clarity.
  initialPrefill?: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
  };
  // Optional bump value: when the parent supplies a new nonce, we re-seed
  // the body field from initialPrefill.body. Lets the agent's draft_reply
  // overwrite the textarea even when the composer is already mounted.
  prefillNonce?: number;
  onSent?: (sent?: SentMessageRef) => void;
  onClose?: () => void;
  // Optional visual variant: the always-open top reply box uses 'dashed';
  // the new-message pane and forward use 'card' for a heavier frame.
  framed?: boolean;
}

type Phase = 'draft' | 'sending' | 'sent';

interface SentMessageRef {
  account?: string;
  threadId?: string | null;
  messageId?: string | null;
  refreshed?: boolean;
}

export function InlineComposer({
  mode,
  account,
  threadId,
  anchorMessageId,
  replyToLabel,
  initialPrefill,
  prefillNonce,
  onSent,
  onClose,
  framed = true,
}: InlineComposerProps) {
  const isReply = mode === 'reply' || mode === 'reply_all';

  const [to, setTo] = useState(initialPrefill?.to || '');
  const [cc, setCc] = useState(initialPrefill?.cc || '');
  const [bcc, setBcc] = useState(initialPrefill?.bcc || '');
  const [subject, setSubject] = useState(initialPrefill?.subject || '');
  const [body, setBody] = useState(initialPrefill?.body || '');
  const [showCcBcc, setShowCcBcc] = useState(!!(initialPrefill?.cc || initialPrefill?.bcc));
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [phase, setPhase] = useState<Phase>('draft');
  const [files, setFiles] = useState<File[]>([]);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [composerMode, setComposerMode] = useState<ComposeMode>(mode);
  const [fromAccount, setFromAccount] = useState<string>(account);
  const composerNeedsRecipients = composerMode === 'new' || composerMode === 'forward';
  const composerNeedsSubject = composerMode === 'new' || composerMode === 'forward';
  const composerNeedsReplyAnchor = composerMode === 'reply' || composerMode === 'reply_all';

  useEffect(() => setComposerMode(mode), [mode]);

  // Reset the From selection whenever the parent rebinds the composer to a
  // different anchor account (new thread, new reply target, etc.).
  useEffect(() => {
    setFromAccount(account);
  }, [account]);

  // Authed accounts (for the "From" selector). The Rail already fetches this
  // query — React Query dedupes, so this is a free read from cache.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: async () =>
      callTool<{
        accounts: {
          accountId: string;
          email: string;
          authed: boolean;
          primary?: boolean;
          displayName?: string;
        }[];
      }>('list_accounts'),
    staleTime: 60_000,
  });
  const accountAliasById = useMemo(
    () =>
      Object.fromEntries(
        (accountsQuery.data?.accounts || []).map((account) => [
          account.accountId,
          account.displayName || account.email,
        ]),
      ) as Record<string, string>,
    [accountsQuery.data?.accounts],
  );
  const authedAccounts = useMemo(
    () => (accountsQuery.data?.accounts || []).filter((a) => a.authed).map((a) => a.accountId),
    [accountsQuery.data],
  );
  // If the resolved account isn't in the authed list yet (e.g. still loading),
  // fall back to whatever the parent passed so the trigger stays populated.
  const fromOptions = useMemo(() => {
    const list = authedAccounts.length ? [...authedAccounts] : [account].filter(Boolean);
    if (fromAccount && !list.includes(fromAccount)) list.unshift(fromAccount);
    return list;
  }, [authedAccounts, fromAccount, account]);

  // Seed once on mount and again whenever a fresh prefill arrives. We let
  // the user keep their edits in between — only nonce bumps overwrite.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefill is a value-only seed bumped via prefillNonce; intentionally not subscribed.
  useEffect(() => {
    if (!initialPrefill) return;
    if (initialPrefill.to !== undefined) setTo(initialPrefill.to);
    if (initialPrefill.cc !== undefined) {
      setCc(initialPrefill.cc);
      if (initialPrefill.cc) setShowCcBcc(true);
    }
    if (initialPrefill.bcc !== undefined) {
      setBcc(initialPrefill.bcc);
      if (initialPrefill.bcc) setShowCcBcc(true);
    }
    if (initialPrefill.subject !== undefined) setSubject(initialPrefill.subject);
    if (initialPrefill.body !== undefined) setBody(initialPrefill.body);
  }, [prefillNonce]);

  const queryClient = useQueryClient();
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const openComposeNew = useClientStore((s) => s.openComposeNew);
  const openComposeReply = useClientStore((s) => s.openComposeReply);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customSendAt, setCustomSendAt] = useState('');
  const customSendAtMin = toDatetimeLocalValue(Date.now() + 60_000);
  const customSendAtMs = useMemo(
    () => (customSendAt ? Date.parse(customSendAt) : Number.NaN),
    [customSendAt],
  );
  const customSendAtIsFuture = Number.isFinite(customSendAtMs) && customSendAtMs > Date.now();

  // Undo-send window (seconds). Server-side pref; default applies while loading.
  const prefsQuery = useQuery({
    queryKey: ['prefs'],
    queryFn: async () => {
      const res = await fetch('/api/prefs', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok === false) throw new Error(data?.error || 'prefs failed');
      return data.prefs as { undoSendSeconds: number };
    },
    staleTime: 60_000,
  });
  const undoSendSeconds = prefsQuery.data?.undoSendSeconds ?? DEFAULT_UNDO_SEND_SECONDS;

  // Snapshot of the draft taken at send time so Undo can restore it after
  // the composer has already cleared/closed.
  const sendSnapshot = useRef<{
    mode: ComposeMode;
    account: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string;
    threadId?: string | null;
    anchorMessageId?: string | null;
    hadFiles: boolean;
  } | null>(null);

  const restoreSnapshot = useCallback(() => {
    const snap = sendSnapshot.current;
    if (!snap) return;
    if (snap.mode !== 'new' && (snap.threadId || snap.anchorMessageId)) {
      openComposeReply({
        mode: snap.mode,
        threadId: snap.threadId || '',
        messageId: snap.anchorMessageId || '',
        account: snap.account,
        prefill: { to: snap.to, cc: snap.cc, bcc: snap.bcc, subject: snap.subject, body: snap.body },
      });
    } else {
      openComposeNew({ to: snap.to, cc: snap.cc, bcc: snap.bcc, subject: snap.subject, body: snap.body });
    }
  }, [openComposeNew, openComposeReply]);

  const send = useMutation({
    mutationFn: async ({ sendAt }: { sendAt?: number } = {}) => {
      if (sendAt !== undefined && sendAt <= Date.now()) {
        throw new Error('Choose a future send time.');
      }
      const fd = new FormData();
      fd.set('mode', composerMode);
      fd.set('account', fromAccount || account);
      if (sendAt) fd.set('sendAt', String(sendAt));
      else if (undoSendSeconds > 0) fd.set('undoSeconds', String(undoSendSeconds));
      sendSnapshot.current = {
        mode: composerMode,
        account: fromAccount || account,
        to,
        cc,
        bcc,
        subject,
        body,
        threadId,
        anchorMessageId,
        hadFiles: files.length > 0,
      };
      if (composerNeedsReplyAnchor && !anchorMessageId && !threadId) {
        throw new Error(
          'Cannot send reply: original message/thread is missing. Reopen the thread and try again.',
        );
      }
      if (composerNeedsRecipients && !to.trim()) {
        throw new Error('Recipient is required.');
      }
      if (composerNeedsSubject && !subject.trim()) {
        throw new Error('Subject is required.');
      }
      if (composerNeedsRecipients) {
        fd.set('to', to);
        if (cc) fd.set('cc', cc);
        if (bcc) fd.set('bcc', bcc);
      }
      if (composerNeedsSubject) fd.set('subject', subject);
      fd.set('body', body);
      // Convert markdown → HTML and sanitize before sending. The plaintext
      // body still goes alongside as the fallback.
      const trimmed = body.trim();
      if (trimmed) {
        const rendered = await marked.parse(body, { gfm: true, breaks: true });
        const safe = sanitizeOutgoingHtml(String(rendered));
        if (safe) fd.set('html', safe);
      }
      if (threadId) fd.set('threadId', threadId);
      if (anchorMessageId) fd.set('messageId', anchorMessageId);
      for (const f of files) fd.append('attachments', f, f.name);

      const res = await fetch('/api/compose', { method: 'POST', body: fd });
      let data: any = null;
      try {
        data = await res.json();
      } catch {}
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `Send failed (${res.status})`);
      }
      return data;
    },
    onMutate: () => setPhase('sending'),
    onSuccess: (data) => {
      if (data?.pending) {
        const pending = data.pending as { id: string; fireAt: number; undoSeconds: number };
        const hadFiles = Boolean(sendSnapshot.current?.hadFiles);
        setPhase('sent');
        window.setTimeout(() => {
          setPhase('draft');
          setBody('');
          setFiles([]);
          setPreviewFile(null);
          if (composerMode === 'new' || composerMode === 'forward') {
            setTo('');
            setCc('');
            setBcc('');
            setSubject('');
          }
          onSent?.(undefined);
        }, 400);

        const windowMs = Math.max(0, pending.fireAt - Date.now());
        let undone = false;
        let toastId: string | number = '';
        const fireTimer = window.setTimeout(() => {
          if (undone) return;
          void waitForPendingSendStatus(pending.id).then((status) => {
            if (undone) return;
            toast.dismiss(toastId);
            if (status === 'sent') {
              fireSendEffect();
              toast.success('Sent');
            } else if (status === 'failed') {
              toast.error('Send failed after the undo window.');
            } else {
              toast('Send is still syncing — refreshing.');
            }
            void queryClient.invalidateQueries({ queryKey: ['thread'] });
            void queryClient.invalidateQueries({ queryKey: ['search'] });
          });
        }, windowMs);
        toastId = toast.custom(
          () => (
            <UndoSendToastBody
              fireAt={pending.fireAt}
              onUndo={async () => {
                undone = true;
                window.clearTimeout(fireTimer);
                toast.dismiss(toastId);
                try {
                  const res = await fetch('/api/compose/undo', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ pendingId: pending.id }),
                  });
                  const result = await res.json().catch(() => null);
                  if (result?.undone) {
                    restoreSnapshot();
                    toast(
                      hadFiles
                        ? 'Send cancelled — draft restored, re-attach files'
                        : 'Send cancelled — draft restored',
                    );
                  } else {
                    toast.error('Too late — already sent.');
                  }
                } catch {
                  toast.error('Could not reach the server to cancel.');
                }
              }}
            />
          ),
          { duration: windowMs + 1_000 },
        );
        return;
      }

      if (data?.scheduled) {
        const scheduled = data.scheduled as { sendAt: number };
        setPhase('draft');
        setScheduleOpen(false);
        setCustomSendAt('');
        setBody('');
        setFiles([]);
        setPreviewFile(null);
        if (composerMode === 'new' || composerMode === 'forward') {
          setTo('');
          setCc('');
          setBcc('');
          setSubject('');
        }
        toast.success(`Scheduled for ${new Date(scheduled.sendAt).toLocaleString()}`);
        onSent?.(undefined);
        return;
      }

      setPhase('sent');
      fireSendEffect();
      const sent = data?.sent as SentMessageRef | undefined;
      const sentAccount = sent?.account || fromAccount || account;
      const sentThreadId = sent?.threadId || threadId || null;
      // Brief solid-border flash then hand control back to the parent.
      window.setTimeout(() => {
        setPhase('draft');
        setBody('');
        setFiles([]);
        setPreviewFile(null);
        if (composerMode === 'new' || composerMode === 'forward') {
          setTo('');
          setCc('');
          setBcc('');
          setSubject('');
        }
        toast.success('Sent');
        if (sentThreadId) {
          setThreadAccount(sentAccount);
          setSelectedThread(sentThreadId);
          void queryClient.invalidateQueries({ queryKey: ['thread', sentAccount, sentThreadId] });
          if (sent?.refreshed === false) {
            window.setTimeout(() => {
              void callTool('get_thread', {
                account: sentAccount,
                threadId: sentThreadId,
                refresh: true,
              })
                .then((freshThread) => {
                  queryClient.setQueryData(['thread', sentAccount, sentThreadId], freshThread);
                })
                .catch(() => undefined);
            }, 1_500);
          }
        } else {
          void queryClient.invalidateQueries({ queryKey: ['thread'] });
        }
        queryClient.invalidateQueries({ queryKey: ['search'] });
        onSent?.(sent);
      }, 700);
    },
    onError: (err: any) => {
      setPhase('draft');
      toast.error(err?.message || 'Send failed');
    },
  });

  const aiDraft = useMutation({
    mutationFn: async () => {
      if (!threadId) throw new Error('no thread');
      return callTool<{ draft: string }>('draft_reply', { account, threadId });
    },
    onSuccess: (res) => setBody((b) => (b.trim() ? b : res.draft)),
    onError: (err: any) => toast.error(err?.message || 'Draft failed'),
  });

  // ---------- attachments ----------
  const addFiles = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of incoming) {
        if (!next.find((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      const total = next.reduce((sum, f) => sum + f.size, 0);
      if (total > MAX_TOTAL_BYTES) {
        toast.error(`Attachments over ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB total`);
        return prev;
      }
      return next;
    });
  }, []);
  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: openFilePicker,
  } = useDropzone({
    onDrop: addFiles,
    noClick: true,
    noKeyboard: true,
  });
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const items = e.clipboardData?.items || [];
      const dropped: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) dropped.push(f);
        }
      }
      if (dropped.length) {
        e.preventDefault();
        addFiles(dropped);
      }
    },
    [addFiles],
  );

  const canSend = useMemo(() => {
    if (phase !== 'draft') return false;
    if (!body.trim()) return false;
    if (composerNeedsRecipients && !to.trim()) return false;
    if (composerNeedsSubject && !subject.trim()) return false;
    if (composerNeedsReplyAnchor && !anchorMessageId && !threadId) return false;
    return true;
  }, [
    phase,
    body,
    composerNeedsRecipients,
    composerNeedsSubject,
    composerNeedsReplyAnchor,
    anchorMessageId,
    threadId,
    to,
    subject,
  ]);

  // ---------- visuals ----------
  const borderClass = useMemo(() => {
    if (phase === 'sent') return 'border-solid border-[var(--color-accent)]';
    if (phase === 'sending') return 'border-dashed border-[var(--color-accent)]/60';
    return framed ? 'border-dashed border-[var(--color-accent)]' : 'border-[var(--color-transparent)]';
  }, [phase, framed]);

  const modeLabel: Record<ComposeMode, string> = {
    new: 'New message',
    reply: 'Reply',
    reply_all: 'Reply all',
    forward: 'Forward',
  };

  return (
    <motion.section
      layout
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'overflow-hidden rounded-xl border bg-[var(--color-bg-elevated)] transition-colors duration-300',
        borderClass,
      )}
      {...getRootProps({ onPaste, role: undefined, tabIndex: undefined } as any)}
    >
      <input {...getInputProps()} />
      {isDragActive ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--color-accent)]/10 text-[12px] text-[var(--color-accent)]">
          Drop to attach
        </div>
      ) : null}

      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)]">
            {composerMode === 'forward' ? (
              <ForwardIcon className="h-3.5 w-3.5" />
            ) : composerMode === 'new' ? (
              <EditIcon className="h-3.5 w-3.5" />
            ) : (
              <ReplyIcon className="h-3.5 w-3.5" />
            )}
          </div>
          <span className="shrink-0 whitespace-nowrap text-[12.5px] font-medium text-[var(--color-text)]">
            {modeLabel[composerMode]}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--color-text-faint)]">
            <span className="shrink-0">from</span>
            {fromOptions.length > 1 ? (
              <Select value={fromAccount || account} onValueChange={setFromAccount}>
                <SelectTrigger
                  size="sm"
                  className="h-7 max-w-[11rem] gap-1 border-[var(--color-control-border)] bg-[var(--color-control)] px-2 py-0 text-[11px] text-[var(--color-text)] shadow-[var(--shadow-control)]"
                >
                  <SelectValue placeholder={account} />
                </SelectTrigger>
                <SelectContent align="start">
                  {fromOptions.map((accountId) => (
                    <SelectItem key={accountId} value={accountId} className="text-[12px]">
                      {accountAliasById[accountId] || accountId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="truncate text-[var(--color-text-muted)]">
                {accountAliasById[fromAccount || account] || fromAccount || account}
              </span>
            )}
          </span>
        </div>

        {isReply ? (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] p-0.5 text-[10.5px] shadow-[var(--shadow-control)] focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--color-bg)]">
            <ModeChip active={composerMode === 'reply'} onClick={() => setComposerMode('reply')}>
              Reply
            </ModeChip>
            <ModeChip active={composerMode === 'reply_all'} onClick={() => setComposerMode('reply_all')}>
              Reply all
            </ModeChip>
            <ModeChip active={composerMode === 'forward'} onClick={() => setComposerMode('forward')}>
              Forward
            </ModeChip>
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <TabButton
            active={tab === 'write'}
            onClick={() => setTab('write')}
            icon={<EditIcon className="h-3 w-3" />}
          >
            Write
          </TabButton>
          <TabButton
            active={tab === 'preview'}
            onClick={() => setTab('preview')}
            icon={<Eye className="h-3 w-3" />}
          >
            Preview
          </TabButton>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="ml-1 grid h-7 w-7 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-faint)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
              title="Close"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </header>

      {(composerNeedsRecipients || isReply) && (composerNeedsRecipients || replyToLabel) ? (
        <div className="border-b border-[var(--color-border)]">
          {composerNeedsRecipients ? (
            <>
              <RecipientField
                label="To"
                value={to}
                onChange={setTo}
                placeholder="alice@example.com, bob@example.com"
              />
              {showCcBcc ? (
                <>
                  <RecipientField label="Cc" value={cc} onChange={setCc} />
                  <RecipientField label="Bcc" value={bcc} onChange={setBcc} />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCcBcc(true)}
                  className="px-4 py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  + Cc / Bcc
                </button>
              )}
            </>
          ) : (
            <div className="grid grid-cols-[60px_1fr] items-center gap-2 px-4 py-1.5 text-[11.5px] text-[var(--color-text-muted)]">
              <span className="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">To</span>
              <div className="flex items-center gap-2">
                <Avatar name={replyToLabel} size={18} />
                <span className="truncate">{replyToLabel}</span>
              </div>
            </div>
          )}
          {composerNeedsSubject ? (
            <RecipientField label="Subject" value={subject} onChange={setSubject} placeholder="Subject" />
          ) : null}
        </div>
      ) : null}

      <div className="px-4 py-3">
        {tab === 'write' ? (
          <TextareaAutosize
            value={body}
            onChange={(e) => setBody(e.target.value)}
            minRows={composerMode === 'new' ? 10 : 4}
            maxRows={28}
            placeholder={
              composerMode === 'new'
                ? 'Compose your message in markdown… **bold**, _italics_, [links](https://…), lists, code fences.'
                : 'Reply in markdown… **bold**, _italics_, lists, code fences.'
            }
            className="w-full resize-none bg-[var(--color-transparent)] text-[13.5px] outline-none placeholder:text-[var(--color-text-faint)]"
          />
        ) : (
          <div className="min-h-[120px] rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-[13.5px]">
            {body.trim() ? (
              <MessageResponse className="text-[13.5px] leading-relaxed [&_a]:text-[var(--color-accent)] [&_a]:underline [&_a]:underline-offset-2">
                {body}
              </MessageResponse>
            ) : (
              <span className="text-[12px] italic text-[var(--color-text-faint)]">Nothing to preview.</span>
            )}
          </div>
        )}
      </div>

      {files.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
          {files.map((f) => (
            <FileChip
              key={`${f.name}-${f.size}`}
              file={f}
              onPreview={() => setPreviewFile(f)}
              onRemove={() => setFiles((arr) => arr.filter((x) => x !== f))}
            />
          ))}
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={openFilePicker}
            className="flex h-8 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] px-2 text-[11.5px] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
            title="Attach files"
          >
            <Paperclip className="h-3 w-3" />
            Attach
          </button>
          {isReply ? (
            <button
              type="button"
              onClick={() => aiDraft.mutate()}
              disabled={aiDraft.isPending || !threadId}
              className="flex h-8 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] px-2 text-[11.5px] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
              title="Ask AI to draft a reply"
            >
              <PenLine className="h-3 w-3 text-[var(--color-accent)]" />
              {aiDraft.isPending ? 'Drafting…' : 'AI draft'}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={!canSend}
                className="grid h-8 w-8 place-items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                title="Schedule send"
              >
                <CalendarClock className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-2">
              <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-faint)]">
                Schedule send
              </div>
              {schedulePresets().map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => send.mutate({ sendAt: preset.at })}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--color-text)] hover:bg-[var(--color-bg-muted)]"
                >
                  <span>{preset.label}</span>
                  <span className="text-[11px] text-[var(--color-text-faint)]">{preset.hint}</span>
                </button>
              ))}
              <div className="mt-2 border-t border-[var(--color-border)] pt-2">
                <input
                  type="datetime-local"
                  value={customSendAt}
                  min={customSendAtMin}
                  onChange={(e) => setCustomSendAt(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[12px] outline-none"
                />
                <button
                  type="button"
                  disabled={!customSendAtIsFuture}
                  onClick={() => send.mutate({ sendAt: customSendAtMs })}
                  className="mt-1.5 w-full rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-[12px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                >
                  Schedule
                </button>
              </div>
            </PopoverContent>
          </Popover>
          <button
            type="button"
            onClick={() => send.mutate({})}
            disabled={!canSend}
            className={cn(
              'flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
              phase === 'sent'
                ? 'bg-[var(--color-success)] text-[var(--color-success-foreground)]'
                : 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]',
              'disabled:opacity-50',
            )}
          >
            <SendIcon className={cn('h-3 w-3', phase === 'sending' && 'animate-pulse')} />
            {phase === 'sending' ? 'Sending…' : phase === 'sent' ? 'Sent' : 'Send'}
          </button>
        </div>
      </footer>

      <Dialog open={!!previewFile} onOpenChange={(open) => !open && setPreviewFile(null)}>
        <DialogContent className="max-h-[92vh] gap-3 overflow-hidden p-0 sm:max-w-[min(1000px,92vw)]">
          {previewFile ? <DraftAttachmentPreviewDialog file={previewFile} /> : null}
        </DialogContent>
      </Dialog>
    </motion.section>
  );
}

// Quick options for the schedule-send popover, computed at open time.
function schedulePresets(): { label: string; hint: string; at: number }[] {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60_000);
  const tomorrow9 = new Date(now);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  const monday9 = new Date(now);
  monday9.setDate(monday9.getDate() + ((1 - monday9.getDay() + 7) % 7));
  monday9.setHours(9, 0, 0, 0);
  if (monday9 <= now) monday9.setDate(monday9.getDate() + 7);
  const fmt = (d: Date) =>
    d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return [
    { label: 'In 1 hour', hint: fmt(inOneHour), at: inOneHour.getTime() },
    { label: 'Tomorrow morning', hint: fmt(tomorrow9), at: tomorrow9.getTime() },
    { label: 'Monday morning', hint: fmt(monday9), at: monday9.getTime() },
  ];
}

function toDatetimeLocalValue(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function waitForPendingSendStatus(
  pendingId: string,
  timeoutMs = SEND_STATUS_CONFIRM_TIMEOUT_MS,
): Promise<'sent' | 'failed' | 'cancelled' | 'missing' | 'timeout'> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const params = new URLSearchParams({ pendingId });
    const res = await fetch(`/api/compose/status?${params.toString()}`, { cache: 'no-store' }).catch(
      () => null,
    );
    const data = res?.ok ? await res.json().catch(() => null) : null;
    const status = data?.status as string | undefined;
    if (status === 'sent' || status === 'failed' || status === 'cancelled' || status === 'missing') {
      return status;
    }
    await new Promise((resolve) => window.setTimeout(resolve, SEND_STATUS_POLL_INTERVAL_MS));
  }
  return 'timeout';
}

// Countdown toast shown while a send is held in the undo window.
function UndoSendToastBody({ fireAt, onUndo }: { fireAt: number; onUndo: () => void }) {
  const [initialMs] = useState(() => Math.max(1, fireAt - Date.now()));
  const [remaining, setRemaining] = useState(initialMs);
  useEffect(() => {
    const interval = window.setInterval(() => {
      setRemaining(Math.max(0, fireAt - Date.now()));
    }, 250);
    return () => window.clearInterval(interval);
  }, [fireAt]);
  const seconds = Math.ceil(remaining / 1000);
  return (
    <div className="pointer-events-auto flex w-[320px] items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5 shadow-lg">
      <div className="relative grid h-8 w-8 shrink-0 place-items-center">
        <svg
          viewBox="0 0 32 32"
          className="absolute inset-0 -rotate-90"
          role="presentation"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="13" fill="none" stroke="var(--color-border)" strokeWidth="2.5" />
          <circle
            cx="16"
            cy="16"
            r="13"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 13}
            strokeDashoffset={(1 - remaining / initialMs) * 2 * Math.PI * 13}
            className="transition-[stroke-dashoffset] duration-200 ease-linear"
          />
        </svg>
        <span className="text-[11px] font-semibold tabular-nums text-[var(--color-text)]">{seconds}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-[var(--color-text)]">Sending…</div>
        <div className="truncate text-[11px] text-[var(--color-text-muted)]">
          Goes out in {seconds}s — change your mind?
        </div>
      </div>
      <button
        type="button"
        onClick={onUndo}
        className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-muted)]"
      >
        <Undo2 className="h-3.5 w-3.5" />
        Undo
      </button>
    </div>
  );
}

function RecipientField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[60px_1fr] items-center gap-2 border-b border-[var(--color-border)] px-4 py-1.5 last:border-b-0">
      <label htmlFor={id} className="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 bg-[var(--color-transparent)] text-[13px] outline-none placeholder:text-[var(--color-text-faint)]"
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] px-2 text-[11.5px] shadow-[var(--shadow-control)] transition-colors',
        active
          ? 'bg-[var(--color-control-hover)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 whitespace-nowrap rounded px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg-elevated)]',
        active
          ? 'bg-[var(--color-control-hover)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]',
      )}
    >
      {children}
    </button>
  );
}

function FileChip({
  file,
  onPreview,
  onRemove,
}: {
  file: File;
  onPreview: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex max-w-[260px] items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[11.5px] shadow-[var(--shadow-control)]">
      <button
        type="button"
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left hover:bg-[var(--color-hover-soft)]"
        title={`Preview ${file.name}`}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-lg bg-[var(--color-control)] text-[var(--color-text-muted)]">
          <AttachmentIcon mime={file.type} className="size-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[var(--color-text)]">{file.name}</span>
          <span className="block text-[10px] text-[var(--color-text-faint)]">{formatBytes(file.size)}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-lg text-[var(--color-text-faint)] opacity-0 transition-opacity hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)] focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg-elevated)] group-hover:opacity-100"
        title={`Remove ${file.name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function DraftAttachmentPreviewDialog({ file }: { file: File }) {
  const url = useObjectUrl(file);
  const mime = file.type || 'application/octet-stream';
  const meta = [mime, formatBytes(file.size)].filter(Boolean).join(' · ');

  return (
    <>
      <DialogHeader className="border-b border-[var(--color-border)] px-4 py-3 pr-11">
        <DialogTitle className="truncate text-[14px]">{file.name}</DialogTitle>
        <DialogDescription className="text-[11px]">{meta}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 bg-[var(--color-bg)] px-4 pb-4 pt-1">
        {url ? <DraftAttachmentPreview file={file} url={url} /> : <div className="h-60 rounded shimmer" />}
        {url ? (
          <div className="mt-3 flex justify-end">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] px-2.5 text-[12px] text-[var(--color-text-muted)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
            >
              <ExternalLink className="size-3.5" />
              Open
            </a>
          </div>
        ) : null}
      </div>
    </>
  );
}

function DraftAttachmentPreview({ file, url }: { file: File; url: string }) {
  const preview = buildAttachmentPreviewItem({
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    downloadHref: url,
    previewHref: url,
  });
  const kind = attachmentPreviewKind(file.type, file.name);
  const frameClass =
    'h-[min(68vh,760px)] w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]';

  if (kind === 'image') {
    return (
      <div className="grid max-h-[68vh] min-h-[240px] place-items-center overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]">
        {/* biome-ignore lint/performance/noImgElement: blob URLs from local draft files cannot be optimized by next/image. */}
        <img src={url} alt={file.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (['pdf', 'text', 'code', 'calendar'].includes(kind)) {
    return <iframe title={file.name} src={url} className={frameClass} sandbox="" />;
  }

  if (kind === 'video') {
    // biome-ignore lint/a11y/useMediaCaption: user attachments do not provide caption tracks.
    return <video src={url} controls className={frameClass} />;
  }

  if (kind === 'audio') {
    return (
      <div className="grid min-h-40 place-items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-soft)]">
        {/* biome-ignore lint/a11y/useMediaCaption: user attachments do not provide caption tracks. */}
        <audio src={url} controls className="w-full" />
      </div>
    );
  }

  return (
    <div className="grid min-h-[260px] place-items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 text-center shadow-[var(--shadow-soft)]">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <span className="grid size-12 place-items-center rounded-xl bg-[var(--color-control)] text-[var(--color-text-muted)] shadow-[var(--shadow-control)]">
          <AttachmentIcon mime={preview.mime} className="size-5" />
        </span>
        <div className="text-[12px] font-medium text-[var(--color-text)]">
          {preview.previewLabel} preview unavailable
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          This file type can still be opened by the browser.
        </div>
      </div>
    </div>
  );
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);
  return url;
}
