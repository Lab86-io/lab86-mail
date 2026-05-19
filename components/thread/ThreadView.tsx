'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import {
  Archive,
  Trash2,
  Mail,
  MailOpen,
  Star,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Sparkles,
  Reply,
  Forward,
  Send as SendIcon,
  X,
  AlarmClock,
} from 'lucide-react';
import { toast } from 'sonner';
import TextareaAutosize from 'react-textarea-autosize';
import { callTool } from '@/lib/api-client';
import { sanitizeEmailHtml } from '@/lib/sanitize';
import { useClientStore } from '@/lib/client-state';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { formatDate, shortFrom, gmailUrlFor } from '@/lib/shared/format';

export function ThreadView() {
  const account = useClientStore((s) => s.account);
  const threadId = useClientStore((s) => s.selectedThreadId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['thread', account, threadId],
    queryFn: async () =>
      callTool<{ threadId: string; subject: string; messages: any[] }>('get_thread', {
        account,
        threadId,
      }),
    enabled: !!account && !!threadId,
  });

  const summary = useQuery({
    queryKey: ['summary', account, threadId],
    queryFn: async () => callTool<{ summary: string; model: string }>('summarize_thread', { account, threadId }),
    enabled: !!account && !!threadId && (data?.messages?.length || 0) > 0,
    staleTime: 5 * 60_000,
    retry: 0,
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

  if (!threadId) {
    return (
      <div className="grid h-full place-items-center text-center text-[12px] text-[var(--color-text-muted)]">
        <div className="flex flex-col items-center gap-2">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-[var(--color-bg-subtle)]">
            <Mail className="h-5 w-5 text-[var(--color-text-faint)]" />
          </div>
          <p className="max-w-[280px]">Select a thread to read. <kbd>j</kbd>/<kbd>k</kbd> to navigate.</p>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg shimmer" />
        ))}
      </div>
    );
  }

  const messages = data.messages || [];
  const lastMessage = messages[messages.length - 1];

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold leading-tight">{data.subject}</h1>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
            <span>{messages.length} message{messages.length === 1 ? '' : 's'}</span>
            <span>·</span>
            <span>{shortFrom(lastMessage?.from)}</span>
            <span>·</span>
            <span>{formatDate(lastMessage?.date)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
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
        <LayoutGroup>
          <div className="mt-4 flex flex-col gap-2">
            {messages.map((m, i) => (
              <MessageCard
                key={m._id}
                message={m}
                defaultOpen={i === messages.length - 1}
                threadId={threadId}
                isLast={i === messages.length - 1}
                account={account}
              />
            ))}
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
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
          <Sparkles className="h-2.5 w-2.5" />
          AI summary
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
        <div className="text-[12px] text-[var(--color-danger)]">
          Couldn't summarize: {error}
        </div>
      ) : data ? (
        <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-[var(--color-text)]">{data}</pre>
      ) : (
        <div className="text-[12px] text-[var(--color-text-muted)]">No summary yet.</div>
      )}
    </motion.section>
  );
}

function MessageCard({
  message,
  defaultOpen,
  isLast,
  threadId,
  account,
}: {
  message: any;
  defaultOpen: boolean;
  isLast: boolean;
  threadId: string;
  account: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [replyOpen, setReplyOpen] = useState(false);
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
        <Avatar name={shortFrom(message.from)} size={26} />
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
            <span className="line-clamp-1 text-[11.5px] text-[var(--color-text-muted)]">{message.snippet}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-text-faint)]">{formatDate(message.date)}</span>
          {open ? <ChevronDown className="h-3.5 w-3.5 text-[var(--color-text-faint)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />}
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
            </div>
            {isLast ? (
              <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
                <button
                  type="button"
                  onClick={() => setReplyOpen(true)}
                  className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]"
                >
                  <Reply className="h-3 w-3" />
                  Reply
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11.5px] hover:bg-[var(--color-bg-subtle)]"
                >
                  <Reply className="h-3 w-3" />
                  Reply all
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11.5px] hover:bg-[var(--color-bg-subtle)]"
                >
                  <Forward className="h-3 w-3" />
                  Forward
                </button>
              </div>
            ) : null}

            {replyOpen ? (
              <InlineReply
                onClose={() => setReplyOpen(false)}
                account={account}
                threadId={threadId}
                messageId={message._id}
                replyTo={shortFrom(message.from)}
              />
            ) : null}
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
        className="prose prose-sm max-w-none break-words text-[13.5px] text-[var(--color-text)] [&_a]:text-[var(--color-accent)] [&_a]:underline [&_a]:underline-offset-2 [&_img]:max-w-full [&_pre]:whitespace-pre-wrap [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-text-muted)]"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }
  if (html && !safe) {
    return <div className="h-24 rounded shimmer" />;
  }
  return <pre className="whitespace-pre-wrap font-sans text-[13.5px]">{text || ''}</pre>;
}

function InlineReply({
  onClose,
  account,
  threadId,
  messageId,
  replyTo,
}: {
  onClose: () => void;
  account: string;
  threadId: string;
  messageId: string;
  replyTo: string;
}) {
  const [body, setBody] = useState('');
  const [drafting, setDrafting] = useState(false);

  const draft = useMutation({
    mutationFn: async () => callTool<{ draft: string }>('draft_reply', { account, threadId }),
    onSuccess: (res) => setBody((b) => b || res.draft),
  });

  const send = useMutation({
    mutationFn: async () =>
      callTool('reply', { account, messageId, threadId, body }),
    onSuccess: () => {
      toast.success(`Sent to ${replyTo}`);
      onClose();
    },
    onError: (err: any) => toast.error(err?.message || 'Send failed'),
  });

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
    >
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
        <span>Replying to {replyTo}</span>
        <button onClick={onClose} className="hover:text-[var(--color-text)]">
          <X className="h-3 w-3" />
        </button>
      </div>
      <TextareaAutosize
        value={body}
        onChange={(e) => setBody(e.target.value)}
        minRows={3}
        maxRows={12}
        placeholder="Write your reply… or click AI Draft."
        className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/30"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => draft.mutate()}
          disabled={draft.isPending}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1 text-[11.5px] hover:bg-[var(--color-bg-muted)]"
        >
          <Sparkles className="h-3 w-3 text-[var(--color-accent)]" />
          {draft.isPending ? 'Drafting…' : 'AI draft'}
        </button>
        <button
          type="button"
          onClick={() => send.mutate()}
          disabled={!body.trim() || send.isPending}
          className="ml-auto flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-3 py-1 text-[11.5px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          <SendIcon className="h-3 w-3" />
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </motion.div>
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
