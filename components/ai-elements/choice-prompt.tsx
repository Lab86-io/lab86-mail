'use client';

import { Check } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { OptionList } from '@/components/tool-ui/option-list';
import { Button } from '@/components/ui/button';
import { canonicalQuestionPrompt } from '@/lib/albatross/question-dedupe';
import { rangeSelection, toggledOptionId } from '@/lib/albatross/teach-ui';

export interface ChoiceOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  options?: ChoiceOption[];
  multiSelect?: boolean;
  minSelections?: number;
  maxSelections?: number;
}

export interface AskAnswer {
  question: string;
  response: string;
}

// The agent's in-chat questionnaire (the `ask_user` human-in-the-loop tool).
// Renders up to four questions at once; choice questions use the tool-ui
// OptionList (single or multi select — multi supports shift-click range
// selection) and every question always accepts a free-text answer too. One
// Confirm submits them all. Once answered it collapses to a compact summary,
// which also keeps old transcripts rendering unchanged.
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
  // Shift-click range selection: a live shift flag plus a per-question anchor
  // (the last plainly-toggled option).
  const shiftHeld = useRef(false);
  const anchors = useRef<Record<number, string | null>>({});

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftHeld.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftHeld.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const visibleQuestions = useMemo(() => {
    const seen = new Set<string>();
    return questions.filter((question) => {
      const key = canonicalQuestionPrompt(question.question);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [questions]);

  // Stable option ids per question ("q0-opt-1") with a map back to labels.
  const optionModel = useMemo(
    () =>
      visibleQuestions.map((q, qi) => {
        const options = (q.options ?? []).map((option, i) => ({
          id: `q${qi}-opt-${i}`,
          label: option.label,
          description: option.description,
        }));
        const labelById = new Map(options.map((option) => [option.id, option.label]));
        return { options, ids: options.map((option) => option.id), labelById };
      }),
    [visibleQuestions],
  );

  if (answered) {
    return (
      <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-[12px]">
        {(answers.length
          ? answers
          : visibleQuestions.map((q) => ({ question: q.question, response: '—' }))
        ).map((a, idx) => (
          <div key={idx}>
            <div className="text-[var(--color-text-muted)]">{a.question}</div>
            <div className="mt-0.5 flex items-center gap-1 font-medium text-[var(--color-accent)]">
              <Check className="size-3 shrink-0" />
              <span>{a.response || '—'}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const labelsFor = (qi: number): string[] => {
    const model = optionModel[qi];
    if (!model) return [];
    return (picked[qi] ?? []).map((id) => model.labelById.get(id) ?? id);
  };

  const responseFor = (qi: number): string => {
    const labels = labelsFor(qi);
    const text = (typed[qi] ?? '').trim();
    if (labels.length && text) return `${labels.join(', ')} — ${text}`;
    if (labels.length) return labels.join(', ');
    return text;
  };

  const questionReady = (q: AskQuestion, qi: number): boolean => {
    const count = (picked[qi] ?? []).length;
    const text = (typed[qi] ?? '').trim();
    if (q.multiSelect && q.minSelections && count > 0 && count < q.minSelections) return false;
    return count > 0 || text.length > 0;
  };
  const allAnswered = visibleQuestions.every((q, qi) => questionReady(q, qi));

  const handleChange = (qi: number, q: AskQuestion, next: string[] | string | null) => {
    const model = optionModel[qi];
    const nextIds = next == null ? [] : typeof next === 'string' ? [next] : next;
    setPicked((prev) => {
      const prevIds = prev[qi] ?? [];
      const clicked = toggledOptionId(prevIds, nextIds);
      let resolved = nextIds;
      if (q.multiSelect && shiftHeld.current && clicked && anchors.current[qi]) {
        resolved = rangeSelection(model.ids, prevIds, clicked, anchors.current[qi]);
        if (q.maxSelections && resolved.length > q.maxSelections) {
          resolved = resolved.slice(0, q.maxSelections);
        }
      } else if (clicked && nextIds.includes(clicked)) {
        anchors.current[qi] = clicked;
      }
      return { ...prev, [qi]: resolved };
    });
  };

  return (
    <div className="space-y-3 rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3 shadow-[var(--shadow-soft)]">
      {visibleQuestions.map((q, qi) => {
        const model = optionModel[qi];
        return (
          <div key={qi} className="space-y-2">
            <div className="text-[12.5px] font-medium text-[var(--color-text)]">{q.question}</div>
            {model.options.length ? (
              <OptionList
                id={`ask-user-q${qi}`}
                options={model.options}
                selectionMode={q.multiSelect ? 'multi' : 'single'}
                minSelections={q.multiSelect ? q.minSelections : undefined}
                maxSelections={q.multiSelect ? q.maxSelections : undefined}
                value={q.multiSelect ? (picked[qi] ?? []) : ((picked[qi] ?? [])[0] ?? null)}
                onChange={(next) => handleChange(qi, q, next)}
                density="compact"
                hideActions
                className="!min-w-0 !max-w-none"
              />
            ) : null}
            <input
              type="text"
              value={typed[qi] ?? ''}
              onChange={(event) => setTyped((prev) => ({ ...prev, [qi]: event.target.value }))}
              placeholder={model.options.length ? 'Or type your own answer…' : 'Type your answer…'}
              className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
            />
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        className="h-8 w-full rounded-lg px-3 text-[12px]"
        disabled={!allAnswered}
        onClick={() =>
          onSubmit(visibleQuestions.map((q, i) => ({ question: q.question, response: responseFor(i) })))
        }
      >
        Confirm
      </Button>
    </div>
  );
}
