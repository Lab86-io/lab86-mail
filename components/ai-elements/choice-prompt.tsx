'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ChoiceOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  options?: ChoiceOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  question: string;
  response: string;
}

// The agent's in-chat questionnaire (the `ask_user` human-in-the-loop tool).
// Renders up to four questions at once; each can offer quick choices AND always
// accepts a free-text answer. One Confirm submits them all. Once answered it
// collapses to a compact summary.
export function AskUserForm({
  questions,
  answered = false,
  answers = [],
  onSubmit,
}: {
  questions: AskQuestion[];
  answered?: boolean;
  answers?: AskAnswer[];
  onSubmit: (answers: AskAnswer[]) => void;
}) {
  // Per-question state keyed by index, so it stays correct even if `questions`
  // changes after mount (missing entries just default to empty).
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});

  if (answered) {
    return (
      <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-[12px]">
        {(answers.length ? answers : questions.map((q) => ({ question: q.question, response: '—' }))).map(
          (a, idx) => (
            <div key={idx}>
              <div className="text-[var(--color-text-muted)]">{a.question}</div>
              <div className="mt-0.5 flex items-center gap-1 font-medium text-[var(--color-accent)]">
                <Check className="size-3 shrink-0" />
                <span>{a.response || '—'}</span>
              </div>
            </div>
          ),
        )}
      </div>
    );
  }

  const responseFor = (i: number): string => {
    const labels = picked[i] ?? [];
    const text = (typed[i] ?? '').trim();
    if (labels.length && text) return `${labels.join(', ')} — ${text}`;
    if (labels.length) return labels.join(', ');
    return text;
  };
  const allAnswered = questions.every((_, i) => responseFor(i).length > 0);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const arr = prev[qi] ?? [];
      const nextArr = multi
        ? arr.includes(label)
          ? arr.filter((x) => x !== label)
          : [...arr, label]
        : arr.includes(label)
          ? []
          : [label];
      return { ...prev, [qi]: nextArr };
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-elevated)] px-3 py-3">
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          <div className="text-[12.5px] font-medium text-[var(--color-text)]">{q.question}</div>
          {q.options?.length ? (
            <div className="grid gap-1.5">
              {q.options.map((option) => {
                const isPicked = (picked[qi] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => toggle(qi, option.label, Boolean(q.multiSelect))}
                    className={cn(
                      'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                      isPicked
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                        : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-hover-soft)]',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                        isPicked
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                          : 'border-[var(--color-border-strong)]',
                      )}
                    >
                      {isPicked ? <Check className="size-3" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-[var(--color-text)]">
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="block text-[11.5px] leading-snug text-[var(--color-text-muted)]">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <input
            type="text"
            value={typed[qi] ?? ''}
            onChange={(event) => setTyped((prev) => ({ ...prev, [qi]: event.target.value }))}
            placeholder={q.options?.length ? 'Or type your own answer…' : 'Type your answer…'}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
          />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        className="h-7 px-3 text-[12px]"
        disabled={!allAnswered}
        onClick={() =>
          onSubmit(questions.map((q, i) => ({ question: q.question, response: responseFor(i) })))
        }
      >
        Confirm
      </Button>
    </div>
  );
}
