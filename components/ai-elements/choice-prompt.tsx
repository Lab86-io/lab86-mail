'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ChoiceOption {
  label: string;
  description?: string;
}

// The agent's in-chat multiple-choice question (rendered for the `ask_user`
// human-in-the-loop tool). Single-select submits on click; multi-select
// accumulates and confirms. Once answered it collapses to a compact summary.
export function ChoicePrompt({
  question,
  options,
  multiSelect = false,
  answered = false,
  selected = [],
  onSubmit,
}: {
  question: string;
  options: ChoiceOption[];
  multiSelect?: boolean;
  answered?: boolean;
  selected?: string[];
  onSubmit: (labels: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);

  if (answered) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px]">
        <div className="text-[var(--color-text-muted)]">{question}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {(selected.length ? selected : ['(no answer)']).map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]"
            >
              <Check className="size-3" />
              {label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const toggle = (label: string) => {
    if (!multiSelect) {
      onSubmit([label]);
      return;
    }
    setPicked((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  };

  return (
    <div className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-elevated)] px-3 py-2.5">
      <div className="mb-2 text-[12.5px] font-medium text-[var(--color-text)]">{question}</div>
      <div className="grid gap-1.5">
        {options.map((option) => {
          const isPicked = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => toggle(option.label)}
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
      {multiSelect ? (
        <Button
          type="button"
          size="sm"
          className="mt-2 h-7 px-3 text-[12px]"
          disabled={!picked.length}
          onClick={() => onSubmit(picked)}
        >
          Confirm{picked.length ? ` (${picked.length})` : ''}
        </Button>
      ) : null}
    </div>
  );
}
