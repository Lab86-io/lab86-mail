'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Pencil as EditIcon,
  Eye,
  Forward as ForwardIcon,
  Paperclip,
  PenLine,
  Reply as ReplyIcon,
  Send as SendIcon,
  X,
} from 'lucide-react';
import { marked } from 'marked';
import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import TextareaAutosize from 'react-textarea-autosize';
import { toast } from 'sonner';
import { MessageResponse } from '@/components/ai-elements/message';
import { Avatar } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { callTool } from '@/lib/api-client';
import type { ComposeMode } from '@/lib/client-state';
import { sanitizeOutgoingHtml } from '@/lib/sanitize';
import { formatBytes } from '@/lib/shared/files';
import { cn } from '@/lib/utils';
import { AttachmentIcon } from './attachment-chip';

// Hard guard: gmail's hard ceiling is 25MB total per send. We refuse slightly
// under to leave headroom for MIME encoding overhead.
const MAX_TOTAL_BYTES = 23 * 1024 * 1024;

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
  onSent?: () => void;
  onClose?: () => void;
  // Optional visual variant: the always-open top reply box uses 'dashed';
  // the new-message pane and forward use 'card' for a heavier frame.
  framed?: boolean;
}

type Phase = 'draft' | 'sending' | 'sent';

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
  const showRecipients = mode === 'new' || mode === 'forward';
  const showSubject = mode === 'new' || mode === 'forward';

  const [to, setTo] = useState(initialPrefill?.to || '');
  const [cc, setCc] = useState(initialPrefill?.cc || '');
  const [bcc, setBcc] = useState(initialPrefill?.bcc || '');
  const [subject, setSubject] = useState(initialPrefill?.subject || '');
  const [body, setBody] = useState(initialPrefill?.body || '');
  const [showCcBcc, setShowCcBcc] = useState(!!(initialPrefill?.cc || initialPrefill?.bcc));
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [phase, setPhase] = useState<Phase>('draft');
  const [files, setFiles] = useState<File[]>([]);
  const [composerMode, setComposerMode] = useState<ComposeMode>(mode);
  const [fromAccount, setFromAccount] = useState<string>(account);

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
      callTool<{ accounts: { email: string; authed: boolean; primary?: boolean }[] }>('list_accounts'),
    staleTime: 60_000,
  });
  const authedAccounts = useMemo(
    () => (accountsQuery.data?.accounts || []).filter((a) => a.authed).map((a) => a.email),
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

  const send = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.set('mode', composerMode);
      fd.set('account', fromAccount || account);
      if (showRecipients) {
        fd.set('to', to);
        if (cc) fd.set('cc', cc);
        if (bcc) fd.set('bcc', bcc);
      }
      if (showSubject) fd.set('subject', subject);
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
    onSuccess: () => {
      setPhase('sent');
      // Brief solid-border flash then hand control back to the parent.
      window.setTimeout(() => {
        setPhase('draft');
        setBody('');
        setFiles([]);
        if (mode === 'new' || mode === 'forward') {
          setTo('');
          setCc('');
          setBcc('');
          setSubject('');
        }
        toast.success('Sent');
        queryClient.invalidateQueries({ queryKey: ['thread'] });
        queryClient.invalidateQueries({ queryKey: ['search'] });
        onSent?.();
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
    if (showRecipients && !to.trim()) return false;
    if (showSubject && !subject.trim()) return false;
    return true;
  }, [phase, body, showRecipients, showSubject, to, subject]);

  // ---------- visuals ----------
  const borderClass = useMemo(() => {
    if (phase === 'sent') return 'border-solid border-[var(--color-accent)]';
    if (phase === 'sending') return 'border-dashed border-[var(--color-accent)]/60';
    return framed ? 'border-dashed border-[var(--color-border-strong)]' : 'border-transparent';
  }, [phase, framed]);

  const modeLabel: Record<ComposeMode, string> = {
    new: 'New message',
    reply: replyToLabel ? `Reply to ${replyToLabel}` : 'Reply',
    reply_all: replyToLabel ? `Reply-all (${replyToLabel})` : 'Reply-all',
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

      <header className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
          {composerMode === 'forward' ? (
            <ForwardIcon className="h-3.5 w-3.5" />
          ) : composerMode === 'new' ? (
            <EditIcon className="h-3.5 w-3.5" />
          ) : (
            <ReplyIcon className="h-3.5 w-3.5" />
          )}
        </div>
        <span className="text-[12.5px] font-medium text-[var(--color-text)]">{modeLabel[composerMode]}</span>
        <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-faint)]">
          <span>· from</span>
          {fromOptions.length > 1 ? (
            <Select value={fromAccount || account} onValueChange={setFromAccount}>
              <SelectTrigger
                size="sm"
                className="h-6 gap-1 border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0 text-[11px] text-[var(--color-text)] shadow-none focus-visible:ring-0"
              >
                <SelectValue placeholder={account} />
              </SelectTrigger>
              <SelectContent align="start">
                {fromOptions.map((email) => (
                  <SelectItem key={email} value={email} className="text-[12px]">
                    {email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-[var(--color-text-muted)]">{fromAccount || account}</span>
          )}
        </span>

        {isReply ? (
          <div className="ml-3 flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5 text-[10.5px]">
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

        <div className="ml-auto flex items-center gap-1">
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
              className="ml-1 grid h-6 w-6 place-items-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]"
              title="Close"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </header>

      {(showRecipients || isReply) && (showRecipients || replyToLabel) ? (
        <div className="border-b border-[var(--color-border)]">
          {showRecipients ? (
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
              <label className="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">
                To
              </label>
              <div className="flex items-center gap-2">
                <Avatar name={replyToLabel} size={18} />
                <span className="truncate">{replyToLabel}</span>
              </div>
            </div>
          )}
          {showSubject ? (
            <RecipientField label="Subject" value={subject} onChange={setSubject} placeholder="Subject" />
          ) : null}
        </div>
      ) : null}

      <div className="px-4 py-3">
        {tab === 'write' ? (
          <TextareaAutosize
            value={body}
            onChange={(e) => setBody(e.target.value)}
            minRows={mode === 'new' ? 10 : 4}
            maxRows={28}
            placeholder={
              mode === 'new'
                ? 'Compose your message in markdown… **bold**, _italics_, [links](https://…), lists, code fences.'
                : 'Reply in markdown… **bold**, _italics_, lists, code fences.'
            }
            className="w-full resize-none bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-text-faint)]"
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
              onRemove={() => setFiles((arr) => arr.filter((x) => x !== f))}
            />
          ))}
        </div>
      ) : null}

      <footer className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={openFilePicker}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)]"
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
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
              title="Ask AI to draft a reply"
            >
              <PenLine className="h-3 w-3 text-[var(--color-accent)]" />
              {aiDraft.isPending ? 'Drafting…' : 'AI draft'}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => send.mutate()}
          disabled={!canSend}
          className={cn(
            'flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
            phase === 'sent'
              ? 'bg-[var(--color-success)] text-white'
              : 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]',
            'disabled:opacity-50',
          )}
        >
          <SendIcon className={cn('h-3 w-3', phase === 'sending' && 'animate-pulse')} />
          {phase === 'sending' ? 'Sending…' : phase === 'sent' ? 'Sent' : 'Send'}
        </button>
      </footer>
    </motion.section>
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
  return (
    <div className="grid grid-cols-[60px_1fr] items-center gap-2 border-b border-[var(--color-border)] px-4 py-1.5 last:border-b-0">
      <label className="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-text-faint)]"
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
        'flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] transition-colors',
        active
          ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-soft)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
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
        'rounded px-1.5 py-0.5 transition-colors',
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
      )}
    >
      {children}
    </button>
  );
}

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="group flex max-w-[260px] items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11.5px]">
      <span className="grid size-5 shrink-0 place-items-center rounded bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
        <AttachmentIcon mime={file.type} className="size-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-[var(--color-text)]">{file.name}</span>
        <span className="block text-[10px] text-[var(--color-text-faint)]">{formatBytes(file.size)}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-4 w-4 place-items-center rounded text-[var(--color-text-faint)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
        title="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
