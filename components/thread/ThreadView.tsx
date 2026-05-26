'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Forward,
  Mail,
  Reply,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MessageResponse } from '@/components/ai-elements/message';
import { ALL_ACCOUNTS } from '@/components/shell/Rail';
import { Avatar } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { sanitizeEmailHtml } from '@/lib/sanitize';
import { formatBytes } from '@/lib/shared/files';
import { emailFromHeader, formatDate, gmailUrlFor, shortFrom } from '@/lib/shared/format';
import type { Attachment } from '@/lib/shared/types';
import { cn } from '@/lib/utils';
import { AttachmentIcon } from './attachment-chip';
import { InlineComposer } from './InlineComposer';

export function ThreadView() {
  // The inbox runs unified; the open thread carries its own concrete account.
  const threadAccount = useClientStore((s) => s.threadAccount);
  const inboxAccount = useClientStore((s) => s.account);
  const primaryAccount = useClientStore((s) => s.primaryAccount);
  const account = threadAccount || inboxAccount;
  const threadId = useClientStore((s) => s.selectedThreadId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const compose = useClientStore((s) => s.compose);
  const openComposeReply = useClientStore((s) => s.openComposeReply);
  const closeCompose = useClientStore((s) => s.closeCompose);
  const pendingReplyBody = useClientStore((s) => s.pendingReplyBody);
  const setPendingReplyBody = useClientStore((s) => s.setPendingReplyBody);
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const queryClient = useQueryClient();
  const markedReadRef = useRef<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['thread', account, threadId],
    queryFn: async () =>
      callTool<{ threadId: string; subject: string; messages: any[] }>('get_thread', {
        account,
        threadId,
        refresh: true,
      }),
    enabled: !!account && !!threadId,
  });

  const archive = useMutation({
    mutationFn: async () => callTool('archive_thread', { account, threadId }),
    onSuccess: () => {
      toast.success('Archived');
      setSelectedThread(null);
      queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });

  const trash = useMutation({
    mutationFn: async () => callTool('trash_thread', { account, threadId }),
    onSuccess: () => {
      toast.success('Moved to Trash');
      setSelectedThread(null);
      queryClient.invalidateQueries({ queryKey: ['search'] });
    },
  });

  // Collect every sender visible in this thread up front so we can resolve
  // photos once, then pass them down to each card. (Same nedb-cached batch
  // tool the inbox uses.)
  const messages = useMemo(
    () => [...(data?.messages || [])].sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0)),
    [data?.messages],
  );
  const markThreadRead = useMutation({
    mutationFn: async ({ ids }: { ids: string[] }) =>
      callTool('mark_thread_read', { account, threadId, messageIds: ids }),
    onMutate: async ({ ids }) => {
      if (!account || !threadId || !ids.length) return;
      queryClient.setQueriesData({ queryKey: ['search'] }, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) => ({
            ...page,
            items: (page.items || []).map((item: any) =>
              item._id === threadId && item.account === account
                ? {
                    ...item,
                    unread: false,
                    labels: (item.labels || []).filter((label: string) => label !== 'UNREAD'),
                  }
                : item,
            ),
          })),
        };
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['smart-counts'] });
      queryClient.invalidateQueries({ queryKey: ['daily-report'] });
      queryClient.invalidateQueries({ queryKey: ['tracked-threads'] });
    },
  });
  useEffect(() => {
    if (!account || !threadId || !messages.length) return;
    const key = `${account}:${threadId}`;
    if (markedReadRef.current.has(key)) return;
    const unreadIds = messages
      .filter((m) => m.labels?.includes('UNREAD'))
      .map((m) => m._id)
      .filter(Boolean);
    if (!unreadIds.length) return;
    markedReadRef.current.add(key);
    markThreadRead.mutate({ ids: unreadIds });
  }, [account, threadId, messages, markThreadRead]);
  const lastMessage = messages[messages.length - 1];
  const latestMessageStamp = `${lastMessage?._id || ''}:${lastMessage?.date || 0}:${messages.length}`;
  const summary = useQuery({
    queryKey: ['summary', account, threadId, latestMessageStamp],
    queryFn: async () =>
      callTool<{ summary: string; model: string }>('summarize_thread', { account, threadId }),
    enabled: !!account && !!threadId && messages.length > 0,
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const ordered = useMemo(() => [...messages].reverse(), [messages]);

  const photoAccount =
    primaryAccount && primaryAccount !== ALL_ACCOUNTS
      ? primaryAccount
      : account && account !== ALL_ACCOUNTS
        ? account
        : '';
  const photoEmails = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      const email = emailFromHeader(m?.from);
      if (email) set.add(email);
    }
    return [...set].sort();
  }, [messages]);
  const photosQuery = useQuery({
    queryKey: ['photos', photoAccount, photoEmails.join(',')],
    queryFn: async () =>
      callTool<{ photos: Record<string, string | null> }>('resolve_photos', {
        account: photoAccount,
        emails: photoEmails,
      }),
    enabled: !!photoAccount && photoEmails.length > 0,
    staleTime: 24 * 60 * 60_000,
  });
  const photos = photosQuery.data?.photos || {};

  // The in-thread composer is hidden by default and only mounts when the user
  // explicitly hits Reply / Reply-all / Forward (header buttons) or the AI
  // agent fires ui_open_reply. Both paths flow through the store's compose
  // state so there's a single source of truth.
  const newest = ordered[0];
  const replyAnchor = newest?._id || null;
  const replyLabel = newest ? shortFrom(newest.from) : undefined;
  useEffect(() => {
    if (pendingReplyBody == null) return;
    if (!threadId || !replyAnchor) return;
    openComposeReply({
      mode: 'reply',
      threadId,
      messageId: replyAnchor,
      account,
      prefill: { body: pendingReplyBody },
    });
    setPendingReplyBody(null);
  }, [pendingReplyBody, threadId, replyAnchor, account, openComposeReply, setPendingReplyBody]);

  const startReply = (replyMode: 'reply' | 'reply_all' | 'forward') => {
    if (!threadId || !replyAnchor) return;
    openComposeReply({ mode: replyMode, threadId, messageId: replyAnchor, account });
  };

  // Compose 'new' takes the entire reading pane. We honor it regardless of
  // whether a thread is open — this is the user's "I'm writing a new
  // message" state.
  if (compose.mode === 'new') {
    const fromAccount = compose.anchorAccount
      ? compose.anchorAccount
      : primaryAccount && primaryAccount !== ALL_ACCOUNTS
        ? primaryAccount
        : account && account !== ALL_ACCOUNTS
          ? account
          : '';
    return (
      <div className="flex h-full flex-col bg-[var(--color-bg)]">
        <header
          className={cn(
            'flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3',
            !aiBarOpen && 'pr-12',
          )}
        >
          <h1 className="truncate text-[15px] font-semibold leading-tight">New message</h1>
          <button
            type="button"
            onClick={() => closeCompose()}
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-6">
          <InlineComposer
            mode="new"
            account={fromAccount}
            initialPrefill={compose.prefill || undefined}
            prefillNonce={compose.nonce}
            onSent={() => closeCompose()}
            onClose={() => closeCompose()}
          />
        </div>
      </div>
    );
  }

  if (!threadId) {
    return (
      <div className="grid h-full place-items-center text-center text-[12px] text-[var(--color-text-muted)]">
        <div className="flex flex-col items-center gap-2">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-[var(--color-bg-subtle)]">
            <Mail className="h-5 w-5 text-[var(--color-text-faint)]" />
          </div>
          <p className="max-w-[280px]">
            Select a thread to read. <kbd>j</kbd>/<kbd>k</kbd> to navigate.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className={cn('space-y-3 p-4', !aiBarOpen && 'pr-12')}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg shimmer" />
        ))}
      </div>
    );
  }

  // Only mount the composer when the store has an active reply/forward
  // anchored at this thread. The user hits Reply/Reply-all/Forward in the
  // header (or the AI agent calls ui_open_reply) to populate it.
  const composeForThisThread = compose.mode && compose.anchorThreadId === threadId ? compose : null;
  const activeMode = composeForThisThread?.mode as 'reply' | 'reply_all' | 'forward' | undefined;
  const activeAnchorMessageId = composeForThisThread?.anchorMessageId;
  const activeAccount = composeForThisThread?.anchorAccount || account;
  const activePrefill = composeForThisThread?.prefill || undefined;
  const activeNonce = composeForThisThread?.nonce ?? 0;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <header
        className={cn(
          'flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3',
          !aiBarOpen && 'pr-12',
        )}
      >
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold leading-tight">{data.subject}</h1>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
            <span>
              {messages.length} message{messages.length === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span>{shortFrom(lastMessage?.from)}</span>
            <span>·</span>
            <span>{formatDate(lastMessage?.date)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => startReply('reply')}
            disabled={!replyAnchor}
            className="flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-[11.5px] text-[var(--color-text)] hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
            title="Reply (r)"
          >
            <Reply className="h-3.5 w-3.5" />
            Reply
          </button>
          <button
            type="button"
            onClick={() => startReply('reply_all')}
            disabled={!replyAnchor}
            className="flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-[11.5px] text-[var(--color-text)] hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
            title="Reply all"
          >
            <Reply className="h-3.5 w-3.5" />
            Reply all
          </button>
          <button
            type="button"
            onClick={() => startReply('forward')}
            disabled={!replyAnchor}
            className="flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)] disabled:opacity-50"
            title="Forward"
          >
            <Forward className="h-3.5 w-3.5" />
            Forward
          </button>
          <span className="mx-1 h-5 w-px bg-[var(--color-border)]" aria-hidden />
          <IconBtn title="Archive (e)" onClick={() => archive.mutate()}>
            <Archive className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn title="Trash (#)" onClick={() => trash.mutate()}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
          <a
            href={gmailUrlFor(account, threadId)}
            target="_blank"
            rel="noreferrer"
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)]"
            title="Open in Gmail"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <IconBtn title="Close" onClick={() => setSelectedThread(null)}>
            <X className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <SummaryCard
          data={summary.data?.summary || ''}
          model={summary.data?.model || ''}
          loading={summary.isLoading}
          error={summary.error ? (summary.error as Error).message : null}
          onRetry={() => summary.refetch()}
        />

        {composeForThisThread && activeMode && activeAnchorMessageId ? (
          <div className="mt-4">
            <InlineComposer
              key={`${activeMode}-${activeAnchorMessageId}-${activeNonce}`}
              mode={activeMode}
              account={activeAccount}
              threadId={threadId}
              anchorMessageId={activeAnchorMessageId}
              replyToLabel={replyLabel}
              initialPrefill={activePrefill}
              prefillNonce={activeNonce}
              onSent={() => closeCompose()}
              onClose={() => closeCompose()}
            />
          </div>
        ) : null}

        <LayoutGroup>
          <div className="mt-4 flex flex-col gap-2">
            {ordered.map((m, i) => {
              const email = emailFromHeader(m?.from);
              return (
                <MessageCard
                  key={m._id}
                  message={m}
                  defaultOpen={i === 0}
                  account={account}
                  photoUrl={email ? (photos[email] ?? null) : null}
                />
              );
            })}
          </div>
        </LayoutGroup>
      </div>
    </div>
  );
}

function SummaryCard({
  data,
  loading,
  model,
  error,
  onRetry,
}: {
  data: string;
  loading: boolean;
  model: string;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3"
    >
      <header className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Summary
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--color-text-faint)]">{model || 'gpt-5.5-mini'}</span>
          <button
            type="button"
            onClick={onRetry}
            className="text-[10px] text-[var(--color-text-faint)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
          >
            retry
          </button>
        </div>
      </header>
      {loading ? (
        <div className="space-y-1.5">
          <div className="h-3 w-3/4 rounded shimmer" />
          <div className="h-3 w-4/5 rounded shimmer" />
          <div className="h-3 w-2/3 rounded shimmer" />
        </div>
      ) : error ? (
        <div className="text-[12px] text-[var(--color-danger)]">Couldn't summarize: {error}</div>
      ) : data ? (
        <MessageResponse className="text-[12.5px] leading-relaxed text-[var(--color-text)] [&_p]:my-0 [&_ul]:mt-1 [&_ul]:mb-0 [&_ul]:pl-4 [&_li]:my-0.5 [&_li]:marker:text-[var(--color-text-faint)]">
          {data}
        </MessageResponse>
      ) : (
        <div className="text-[12px] text-[var(--color-text-muted)]">No summary yet.</div>
      )}
    </motion.section>
  );
}

function MessageCard({
  message,
  defaultOpen,
  account,
  photoUrl,
}: {
  message: any;
  defaultOpen: boolean;
  account: string;
  photoUrl?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <motion.article
      layout
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[30px_1fr_auto] items-center gap-3 px-3 py-2 text-left"
      >
        <Avatar name={shortFrom(message.from)} src={photoUrl} size={26} />
        <div className="flex min-w-0 flex-col gap-0">
          <div className="flex items-center gap-2 truncate">
            <span className="truncate text-[13px] font-semibold text-[var(--color-text)]">
              {shortFrom(message.from)}
            </span>
            <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">
              → {shortFrom(message.to || message.account)}
            </span>
          </div>
          {!open ? (
            <span className="line-clamp-1 text-[11.5px] text-[var(--color-text-muted)]">
              {message.snippet}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-text-faint)]">{formatDate(message.date)}</span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
          )}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-[var(--color-border)]"
          >
            <div className="px-4 py-3">
              <MessageBody html={message.htmlBody} text={message.textBody} />
              <Attachments attachments={message.attachments} messageId={message._id} account={account} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
}

function MessageBody({ html, text }: { html?: string; text?: string }) {
  const [safe, setSafe] = useState<string | null>(null);
  useEffect(() => {
    if (html) setSafe(sanitizeEmailHtml(html));
  }, [html]);
  if (safe) {
    return (
      <div
        className="email-body break-words text-[13.5px] text-[var(--color-text)]"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }
  if (html && !safe) {
    return <div className="h-24 rounded shimmer" />;
  }
  return <PlainTextBody text={text || ''} />;
}

function PlainTextBody({ text }: { text: string }) {
  const paragraphs = String(text || '').split(/\r?\n\s*\r?\n/);
  return (
    <div className="email-body break-words text-[13.5px] text-[var(--color-text)]">
      {paragraphs.map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 12)}`} className="whitespace-pre-wrap">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function Attachments({
  attachments,
  messageId,
  account,
}: {
  attachments?: Attachment[];
  messageId: string;
  account: string;
}) {
  const list = (attachments || []).filter((a) => a.attachmentId);
  const [preview, setPreview] = useState<AttachmentPreviewItem | null>(null);
  if (!list.length) return null;
  return (
    <>
      <TooltipProvider delayDuration={250}>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
          {list.map((att, i) => {
            const href = attachmentHref({ account, messageId, attachment: att, preview: false });
            const previewHref = attachmentHref({ account, messageId, attachment: att, preview: true });
            const item = attachmentPreviewItem(att, href, previewHref);
            return (
              <div
                key={att.attachmentId || i}
                className="group flex max-w-[300px] items-stretch overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-muted)]"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setPreview(item)}
                      title={`Preview ${att.filename}`}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--color-bg-muted)] text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]">
                        <AttachmentIcon mime={att.mimeType} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-[var(--color-text)]">
                          {att.filename}
                        </span>
                        {item.meta ? (
                          <span className="block text-[10.5px] text-[var(--color-text-faint)]">
                            {item.meta}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align="start"
                    className="border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-2 text-[var(--color-text)] shadow-[var(--shadow-pop)]"
                  >
                    <AttachmentPreview item={item} compact />
                  </TooltipContent>
                </Tooltip>
                <a
                  href={href}
                  download={att.filename}
                  title={`Download ${att.filename}`}
                  className="grid min-h-[48px] w-10 shrink-0 place-items-center border-l border-[var(--color-border)] text-[var(--color-text-faint)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
                >
                  <Download className="size-3.5" />
                </a>
              </div>
            );
          })}
        </div>
      </TooltipProvider>
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-h-[92vh] gap-3 overflow-hidden p-0 sm:max-w-[min(1000px,92vw)]">
          {preview ? (
            <>
              <DialogHeader className="border-b border-[var(--color-border)] px-4 py-3 pr-11">
                <DialogTitle className="truncate text-[14px]">{preview.filename}</DialogTitle>
                <DialogDescription className="text-[11px]">{preview.meta || preview.mime}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 px-4 pb-4">
                <AttachmentPreview item={preview} />
                <div className="mt-3 flex justify-end gap-2">
                  <a
                    href={preview.downloadHref}
                    download={preview.filename}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-bg-subtle)]"
                  >
                    <Download className="size-3.5" />
                    Download
                  </a>
                  <a
                    href={preview.previewHref}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 text-[12px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
                  >
                    <ExternalLink className="size-3.5" />
                    Open
                  </a>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

type AttachmentPreviewItem = {
  filename: string;
  mime: string;
  meta: string;
  downloadHref: string;
  previewHref: string;
  previewKind: 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'unknown';
};

function attachmentHref({
  account,
  messageId,
  attachment,
  preview,
}: {
  account: string;
  messageId: string;
  attachment: Attachment;
  preview: boolean;
}) {
  const href = `/api/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(
    attachment.attachmentId,
  )}?account=${encodeURIComponent(account)}&name=${encodeURIComponent(
    attachment.filename,
  )}&mime=${encodeURIComponent(attachment.mimeType)}`;
  return preview ? `${href}&preview=1` : href;
}

function attachmentPreviewItem(
  att: Attachment,
  downloadHref: string,
  previewHref: string,
): AttachmentPreviewItem {
  const mime = (att.mimeType || '').toLowerCase();
  const ext = (att.filename.split('.').pop() || '').slice(0, 5).toUpperCase();
  const meta = [ext, formatBytes(att.size)].filter(Boolean).join(' · ');
  let previewKind: AttachmentPreviewItem['previewKind'] = 'unknown';
  if (mime.startsWith('image/')) previewKind = 'image';
  else if (mime === 'application/pdf') previewKind = 'pdf';
  else if (mime.startsWith('text/') || /(json|xml|csv|markdown)/.test(mime)) previewKind = 'text';
  else if (mime.startsWith('video/')) previewKind = 'video';
  else if (mime.startsWith('audio/')) previewKind = 'audio';
  return {
    filename: att.filename,
    mime: att.mimeType || 'application/octet-stream',
    meta,
    downloadHref,
    previewHref,
    previewKind,
  };
}

function AttachmentPreview({ item, compact = false }: { item: AttachmentPreviewItem; compact?: boolean }) {
  const frameClass = compact
    ? 'h-40 w-64 rounded border border-[var(--color-border)] bg-[var(--color-bg)]'
    : 'h-[min(68vh,760px)] w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]';

  if (item.previewKind === 'image') {
    const className = compact
      ? 'grid h-40 w-64 place-items-center overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]'
      : 'grid max-h-[68vh] min-h-[240px] place-items-center overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]';
    return (
      <div className={className}>
        <img src={item.previewHref} alt={item.filename} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (item.previewKind === 'pdf' || item.previewKind === 'text') {
    return <iframe title={item.filename} src={item.previewHref} className={frameClass} />;
  }

  if (item.previewKind === 'video') {
    return <video src={item.previewHref} controls className={frameClass} />;
  }

  if (item.previewKind === 'audio') {
    return (
      <div className="grid min-h-40 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
        <audio src={item.previewHref} controls className="w-full" />
      </div>
    );
  }

  const className = compact
    ? 'grid h-40 w-64 place-items-center rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-center'
    : 'grid min-h-[260px] place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-6 text-center';
  return (
    <div className={className}>
      <div className="flex max-w-sm flex-col items-center gap-2">
        <span className="grid size-12 place-items-center rounded-lg bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
          <AttachmentIcon mime={item.mime} className="size-5" />
        </span>
        <div className="text-[12px] font-medium text-[var(--color-text)]">Preview unavailable</div>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          This file type can still be opened or downloaded.
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}
