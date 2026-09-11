'use client';

// @ai-elements/tool (registry.ai-sdk.dev), restyled to the app tokens. The
// structure is the registry's: a collapsible per tool call with a header that
// reads the part state and a content area. Changes are style only: the
// wrench icon and the status badge are gone (the state is a small glyph and
// the text tone), the raw JSON code block is a plain <pre>, and the headings
// are sentence case. Running rows use @ai-elements/loader; done and failed
// rows draw a 10px check or cross in code.

import type { ToolUIPart } from 'ai';
import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { isValidElement } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { RevealDot } from './reveal-dot';

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn('not-prose group/tool w-full min-w-0', className)} {...props} />
);

export type ToolTone = 'running' | 'done' | 'failed';

/** Map a tool part state (and its output) to the three tones the row renders. */
export function toolTone(state: ToolUIPart['state'] | string | undefined, output?: unknown): ToolTone {
  if (state === 'output-error') return 'failed';
  if (state === 'output-available') {
    if (output && typeof output === 'object' && (output as { ok?: unknown }).ok === false) return 'failed';
    return 'done';
  }
  return 'running';
}

export const RunningGlyph = ({ className }: { className?: string }) => <RevealDot className={className} />;

export const DoneGlyph = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 10 10"
    width={10}
    height={10}
    className={cn('mt-[3px] text-[var(--color-text-faint)]', className)}
  >
    <path
      d="M1.5 5.2 4 7.6 8.6 2.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

export const FailedGlyph = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 10 10"
    width={10}
    height={10}
    className={cn('mt-[3px] text-[var(--color-danger)]', className)}
  >
    <path
      d="M2.2 2.2l5.6 5.6M7.8 2.2 2.2 7.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

export const toolGlyph = (tone: ToolTone) =>
  tone === 'running' ? RunningGlyph : tone === 'failed' ? FailedGlyph : DoneGlyph;

const TONE_TEXT: Record<ToolTone, string> = {
  running: 'text-[var(--color-text-muted)]',
  done: 'text-[var(--color-text-faint)]',
  failed: 'text-[var(--color-danger)]',
};

const TONE_LABEL: Record<ToolTone, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart['type'] | string;
  state: ToolUIPart['state'] | string;
  output?: unknown;
  /** The header opens the content. Off when the row has none. */
  expandable?: boolean;
  className?: string;
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  output,
  expandable = true,
  ...props
}: ToolHeaderProps) => {
  const tone = toolTone(state, output);
  return (
    <CollapsibleTrigger
      disabled={!expandable}
      className={cn(
        'flex w-full min-w-0 items-start justify-between gap-2 text-left text-[12px] leading-relaxed',
        TONE_TEXT[tone],
        expandable && 'cursor-pointer',
        className,
      )}
      {...props}
    >
      <span className={cn('min-w-0 flex-1', tone === 'failed' ? 'break-words' : 'truncate')}>
        {title ?? String(type).split('-').slice(1).join('-')}
      </span>
      <span className="sr-only">{TONE_LABEL[tone]}</span>
      {expandable ? (
        <ChevronDownIcon
          aria-hidden="true"
          className="mt-[3px] size-3.5 shrink-0 text-[var(--color-text-faint)] transition-transform group-data-[state=open]/tool:rotate-180"
        />
      ) : null}
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
);

const Pre = ({ children }: { children: string }) => (
  <pre className="corner-smooth max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-bg-subtle)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--color-text)]">
    {children}
  </pre>
);

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolUIPart['input'];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-1.5 overflow-hidden py-2', className)} {...props}>
    <h4 className="text-[11.5px] font-medium text-[var(--color-text-muted)]">Parameters</h4>
    <Pre>{JSON.stringify(input, null, 2)}</Pre>
  </div>
);

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolUIPart['output'];
  errorText: ToolUIPart['errorText'];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output: ReactNode = <div>{output as ReactNode}</div>;

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = <Pre>{JSON.stringify(output, null, 2)}</Pre>;
  } else if (typeof output === 'string') {
    Output = <Pre>{output}</Pre>;
  }

  return (
    <div className={cn('space-y-1.5 py-2', className)} {...props}>
      <h4 className="text-[11.5px] font-medium text-[var(--color-text-muted)]">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div
        className={cn(
          'overflow-x-auto text-[11.5px] [&_table]:w-full',
          errorText ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]',
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
