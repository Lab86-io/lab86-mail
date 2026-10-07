'use client';

// From the @ai-elements registry (task). Restyled to the app tokens: no icon
// before the trigger text, the chevron stays as the only control glyph.

import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type TaskItemFileProps = ComponentProps<'div'>;

export const TaskItemFile = ({ children, className, ...props }: TaskItemFileProps) => (
  <div
    className={cn(
      'inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)]',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<'div'>;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn('text-[12px] leading-snug text-[var(--color-text-muted)]', className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible data-slot="task" className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn('group', className)} {...props}>
    {children ?? (
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
      >
        <span>{title}</span>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
        />
      </button>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  >
    <div className="mt-2 space-y-1.5 border-l border-[var(--color-border)] pl-3">{children}</div>
  </CollapsibleContent>
);
