'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send as SendIcon, X, Sparkles } from 'lucide-react';
import TextareaAutosize from 'react-textarea-autosize';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';

export function ComposeDialog() {
  const open = useClientStore((s) => s.composeOpen);
  const setOpen = useClientStore((s) => s.setComposeOpen);
  const account = useClientStore((s) => s.account);

  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showCc, setShowCc] = useState(false);

  const send = useMutation({
    mutationFn: async () => callTool('send_message', { account, to, cc, bcc, subject, body }),
    onSuccess: () => {
      toast.success(`Sent to ${to}`);
      setOpen(false);
      setTo('');
      setCc('');
      setBcc('');
      setSubject('');
      setBody('');
    },
    onError: (err: any) => toast.error(err?.message || 'Send failed'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[720px] p-0">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
          <DialogTitle className="text-[13px] font-medium">
            New message <span className="text-[var(--color-text-faint)]">· from {account}</span>
          </DialogTitle>
          <button onClick={() => setOpen(false)} className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex flex-col">
          <Field label="To" value={to} onChange={setTo} placeholder="alice@example.com" />
          {showCc ? (
            <>
              <Field label="Cc" value={cc} onChange={setCc} />
              <Field label="Bcc" value={bcc} onChange={setBcc} />
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="self-start px-4 py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              + Cc / Bcc
            </button>
          )}
          <Field label="Subject" value={subject} onChange={setSubject} />
          <div className="px-4 py-3">
            <TextareaAutosize
              value={body}
              onChange={(e) => setBody(e.target.value)}
              minRows={10}
              maxRows={20}
              placeholder="Compose a message… (use the AI bar with ⌘K to ghost-write)"
              className="w-full resize-none bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-text-faint)]"
            />
          </div>
        </div>
        <footer className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-2.5">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)]"
          >
            <Sparkles className="h-3 w-3 text-[var(--color-accent)]" />
            AI assist
          </button>
          <button
            type="button"
            onClick={() => send.mutate()}
            disabled={!to || !subject || !body || send.isPending}
            className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            <SendIcon className="h-3 w-3" />
            {send.isPending ? 'Sending…' : 'Send'}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function Field({
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
    <div className="grid grid-cols-[60px_1fr] items-center gap-2 border-b border-[var(--color-border)] px-4 py-1.5">
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
