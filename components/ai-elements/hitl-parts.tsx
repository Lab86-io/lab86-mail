'use client';

// Human-in-the-loop tool renderings beyond ask_user: approval cards, numeric
// parameter sliders, preference panels, and guided question flows. Each pauses
// the agent stream (the tools have no execute) until the user acts; the answer
// goes back through addToolResult and the run auto-continues.
//
// All four render tool-ui components (components/tool-ui) so the question
// surfaces share one modern design system with the display tools.

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { Loader } from '@/components/ui/loader';

function LoadingCard() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-[12px] text-[var(--color-text-muted)]">
      <Loader variant="typing" />
    </div>
  );
}
const ApprovalCard = dynamic(() => import('@/components/tool-ui/approval-card').then((m) => m.ApprovalCard), {
  loading: LoadingCard,
  ssr: false,
});
const ParameterSlider = dynamic(
  () => import('@/components/tool-ui/parameter-slider').then((m) => m.ParameterSlider),
  { loading: LoadingCard, ssr: false },
);
const PreferencesPanel = dynamic(
  () => import('@/components/tool-ui/preferences-panel').then((m) => m.PreferencesPanel),
  { loading: LoadingCard, ssr: false },
);
const PreferencesPanelReceipt = dynamic(
  () => import('@/components/tool-ui/preferences-panel').then((m) => m.PreferencesPanelReceipt),
  { loading: LoadingCard, ssr: false },
);
const QuestionFlow = dynamic(() => import('@/components/tool-ui/question-flow').then((m) => m.QuestionFlow), {
  loading: LoadingCard,
  ssr: false,
});

export type HitlResult = (output: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// ask_approval — binary go/no-go on one consequential action
// ---------------------------------------------------------------------------

export function ApprovalPart({ part, onResult }: { part: any; onResult: HitlResult }) {
  const input = part.input || {};
  if (!input.title) return null;
  const answered = part.state === 'output-available';
  const decision = answered ? part.output?.decision : undefined;
  return (
    <div className="max-w-[420px]">
      <ApprovalCard
        id={part.toolCallId || 'approval'}
        title={String(input.title)}
        description={input.description ? String(input.description) : undefined}
        metadata={
          Array.isArray(input.metadata)
            ? input.metadata
                .filter((row: any) => row?.label && row?.value !== undefined)
                .map((row: any) => ({ key: String(row.label), value: String(row.value) }))
            : undefined
        }
        variant={input.intent === 'destructive' ? 'destructive' : 'default'}
        confirmLabel={input.confirmLabel ? String(input.confirmLabel) : 'Approve'}
        cancelLabel={input.denyLabel ? String(input.denyLabel) : 'Cancel'}
        choice={decision === 'approved' || decision === 'denied' ? decision : undefined}
        onConfirm={answered ? undefined : () => onResult({ decision: 'approved' })}
        onCancel={answered ? undefined : () => onResult({ decision: 'denied' })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ask_parameters — numeric tuning via sliders
// ---------------------------------------------------------------------------

export function ParametersPart({ part, onResult }: { part: any; onResult: HitlResult }) {
  const input = part.input || {};
  const sliders = Array.isArray(input.sliders) ? input.sliders : [];
  if (!sliders.length) return null;
  const answered = part.state === 'output-available';

  if (answered) {
    const values = (part.output?.values ?? {}) as Record<string, number>;
    return (
      <div className="space-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-[12px]">
        {sliders.map((slider: any) => (
          <div key={slider.id} className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--color-text-muted)]">{slider.label}</span>
            <span className="font-medium tabular-nums text-[var(--color-accent)]">
              {values[slider.id] ?? slider.value}
              {slider.unit ? ` ${slider.unit}` : ''}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-[420px]">
      <ParameterSlider
        id={part.toolCallId || 'parameters'}
        sliders={sliders.map((slider: any) => ({
          id: String(slider.id),
          label: String(slider.label || slider.id),
          min: Number(slider.min),
          max: Number(slider.max),
          step: slider.step !== undefined ? Number(slider.step) : undefined,
          value: Number(slider.value),
          unit: slider.unit ? String(slider.unit) : undefined,
        }))}
        actions={[{ id: 'confirm', label: 'Use these values' }]}
        onAction={(_, values) => {
          const record: Record<string, number> = {};
          for (const entry of values ?? []) record[entry.id] = entry.value;
          onResult({ values: record });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ask_preferences — a compact settings batch
// ---------------------------------------------------------------------------

export function PreferencesPart({ part, onResult }: { part: any; onResult: HitlResult }) {
  const input = part.input || {};
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) return null;
  const answered = part.state === 'output-available';
  const sections = [{ items }];

  if (answered) {
    const choice = (part.output?.values ?? {}) as Record<string, string | boolean>;
    return (
      <div className="max-w-[420px]">
        <PreferencesPanelReceipt
          id={part.toolCallId || 'preferences'}
          title={input.title ? String(input.title) : undefined}
          sections={sections}
          choice={choice}
        />
      </div>
    );
  }

  return (
    <div className="max-w-[420px]">
      <PreferencesPanel
        id={part.toolCallId || 'preferences'}
        title={input.title ? String(input.title) : undefined}
        sections={sections}
        actions={[{ id: 'save', label: 'Save' }]}
        onAction={(_, values) => onResult({ values: values ?? {} })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ask_question_flow — guided multi-step choices
// ---------------------------------------------------------------------------

export function QuestionFlowPart({ part, onResult }: { part: any; onResult: HitlResult }) {
  const input = part.input || {};
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const answered = part.state === 'output-available';

  const steps = useMemo(
    () =>
      rawSteps.map((step: any, si: number) => ({
        id: `step-${si}`,
        title: String(step.title || `Step ${si + 1}`),
        description: step.description ? String(step.description) : undefined,
        selectionMode: step.multiSelect ? ('multi' as const) : ('single' as const),
        options: (Array.isArray(step.options) ? step.options : []).map((option: any, oi: number) => ({
          id: `step-${si}-opt-${oi}`,
          label: String(option.label || `Option ${oi + 1}`),
          description: option.description ? String(option.description) : undefined,
        })),
      })),
    [rawSteps],
  );
  if (!steps.length || steps.some((step: any) => step.options.length < 2)) return null;

  if (answered) {
    const answers = Array.isArray(part.output?.answers) ? part.output.answers : [];
    const summary = answers
      .filter((a: any) => a?.question && a?.response)
      .map((a: any) => ({ label: String(a.question), value: String(a.response) }));
    if (!summary.length) return null;
    return (
      <div className="max-w-[420px]">
        <QuestionFlow id={part.toolCallId || 'flow'} choice={{ title: 'Your choices', summary }} />
      </div>
    );
  }

  return (
    <div className="max-w-[420px]">
      <QuestionFlow
        id={part.toolCallId || 'flow'}
        steps={steps}
        onComplete={(byStep: Record<string, string[]>) => {
          const answers = steps.map((step: any) => {
            const pickedIds = byStep[step.id] ?? [];
            const labels = step.options
              .filter((option: any) => pickedIds.includes(option.id))
              .map((option: any) => option.label);
            return { question: step.title, response: labels.join(', ') };
          });
          onResult({ answers });
        }}
      />
    </div>
  );
}

// One dispatcher for every non-ask_user HITL tool. Returns null when the part
// carries nothing renderable (the caller falls back to the activity row).
export function HitlPart({
  toolName,
  part,
  onResult,
}: {
  toolName: string;
  part: any;
  onResult: HitlResult;
}) {
  if (part.state === 'input-streaming') return null;
  switch (toolName) {
    case 'ask_approval':
      return <ApprovalPart part={part} onResult={onResult} />;
    case 'ask_parameters':
      return <ParametersPart part={part} onResult={onResult} />;
    case 'ask_preferences':
      return <PreferencesPart part={part} onResult={onResult} />;
    case 'ask_question_flow':
      return <QuestionFlowPart part={part} onResult={onResult} />;
    default:
      return null;
  }
}
