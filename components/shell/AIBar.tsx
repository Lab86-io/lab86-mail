'use client';

import { useChat } from '@ai-sdk/react';
import { ArrowUp, Sparkles, X, Square, ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

interface Props {
  extraSystem?: string;
}

export function AIBar({ extraSystem }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const account = useClientStore((s) => s.account);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);

  const { messages, sendMessage, status, stop, error } = useChat({
    transport: undefined,
  });

  // Auto-focus when expanded.
  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  // ⌘K opens the bar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput('');
    const contextLines = [
      account ? `Active account: ${account}` : '',
      selectedThreadId ? `Currently focused thread id: ${selectedThreadId}` : '',
      extraSystem || '',
    ].filter(Boolean).join('\n');
    sendMessage(
      { text },
      {
        body: { extraSystem: contextLines || undefined },
      } as any,
    );
  };

  const busy = status === 'streaming' || status === 'submitted';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative flex h-8 w-full max-w-[640px] items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 text-left text-[13px] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        title="Open AI command bar (⌘K)"
      >
        <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="flex-1 truncate">
          Ask Mail OS anything — search, summarize, draft, send…
        </span>
        <kbd>⌘K</kbd>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] grid place-items-start justify-center bg-black/30 px-4 pt-[8vh] backdrop-blur-sm"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="relative flex w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-pop)]"
            >
              {busy ? <span className="border-beam" aria-hidden /> : null}

              <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
                <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
                  <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                  <span className="font-medium text-[var(--color-text)]">Mail OS · Agent</span>
                  <span className="text-[var(--color-text-faint)]">·</span>
                  <span>gpt-5.5</span>
                  {selectedThreadId ? (
                    <>
                      <span className="text-[var(--color-text-faint)]">·</span>
                      <span className="font-mono text-[10px]">thread {selectedThreadId.slice(-8)}</span>
                    </>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              <div className="flex max-h-[55vh] min-h-[120px] flex-col gap-3 overflow-y-auto px-4 py-4">
                {messages.length === 0 ? (
                  <Suggestions onPick={submit} />
                ) : (
                  messages.map((m) => <MessageView key={m.id} message={m} />)
                )}
                {error ? (
                  <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
                    {error.message}
                  </div>
                ) : null}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(input);
                }}
                className="flex items-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3"
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
                  placeholder="Find emails, draft a reply, schedule a meeting, label receipts, anything…"
                  maxRows={6}
                  minRows={1}
                  className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-[var(--color-text-faint)]"
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
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  const suggestions = [
    'Triage my newest 25 inbox threads',
    'Summarize unread from this week',
    'Find every Stripe receipt from 2025 and label them Receipts/2025',
    'Draft a polite no to the last message in this thread',
    'Pull every meeting invite from today and propose 3 times to push back',
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Try</div>
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-left text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
        >
          <Sparkles className="h-3 w-3 text-[var(--color-accent)]" />
          {s}
        </button>
      ))}
    </div>
  );
}

function MessageView({ message }: { message: any }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
        {isUser ? 'You' : 'Mail OS'}
      </div>
      <div
        className={cn(
          'max-w-[88%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed',
          isUser
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]'
            : 'bg-[var(--color-bg-subtle)] text-[var(--color-text)]',
        )}
      >
        {message.parts?.map((part: any, i: number) => <Part key={i} part={part} />) ?? null}
      </div>
    </div>
  );
}

function Part({ part }: { part: any }) {
  if (part.type === 'text') return <span className="whitespace-pre-wrap">{part.text}</span>;
  if (part.type === 'reasoning') return <ReasoningCollapsed text={part.text || part.reasoning || ''} />;
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    return <ToolCard part={part} />;
  }
  if (part.type === 'dynamic-tool') return <ToolCard part={part} />;
  return null;
}

function ToolCard({ part }: { part: any }) {
  const name = part.toolName || (typeof part.type === 'string' ? part.type.replace(/^tool-/, '') : 'tool');
  const state = part.state || 'unknown';
  const done = state === 'output-available';
  const error = state === 'output-error';
  return (
    <div
      className={cn(
        'mt-1 flex flex-col gap-1 rounded-md border px-2.5 py-1.5 font-mono text-[11px]',
        error
          ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
          : done
            ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/5 text-[var(--color-text-muted)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-[var(--color-text)]">{name}</span>
        <span className="text-[var(--color-text-faint)]">{state}</span>
      </div>
      {part.input ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-[var(--color-text-faint)]">
          {JSON.stringify(part.input, null, 2).slice(0, 360)}
        </pre>
      ) : null}
      {done && part.output ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-[var(--color-text-muted)]">
          {summarize(part.output)}
        </pre>
      ) : null}
      {error && part.errorText ? <span className="text-[10px]">{part.errorText}</span> : null}
    </div>
  );
}

function ReasoningCollapsed({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <details
      className="mt-1 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1 text-[11px]"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center gap-1 text-[var(--color-text-faint)]">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Thinking
      </summary>
      <p className="mt-1 whitespace-pre-wrap text-[var(--color-text-muted)]">{text}</p>
    </details>
  );
}

function summarize(value: unknown): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return s.length > 600 ? `${s.slice(0, 600)}\n…` : s;
  } catch {
    return String(value);
  }
}
