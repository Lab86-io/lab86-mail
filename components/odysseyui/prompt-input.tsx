'use client';

// Odyssey UI's layered prompt card, wired to Albatross's controlled composer.
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export type PromptInputProps = Omit<ComponentProps<'div'>, 'onChange' | 'onKeyDown'> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: () => void;
  onKeyDown?: ComponentProps<'textarea'>['onKeyDown'];
  placeholder?: string;
  maxHeight?: number;
  disabled?: boolean;
  before?: ReactNode;
  field?: ReactNode;
};

export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  onKeyDown,
  placeholder = 'Ask anything…',
  maxHeight = 176,
  disabled,
  before,
  field,
  children,
  className,
  ...props
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize after text changes or the landing returns the textarea.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight, field]);

  return (
    <div
      data-slot="prompt-input"
      className={cn(
        'rounded-3xl border border-[var(--color-control-border)] bg-[var(--color-control)]/50 p-1.5 backdrop-blur-sm',
        className,
      )}
      {...props}
    >
      <div className="relative flex w-full min-w-0 flex-col rounded-[20px] border border-[var(--color-control-border)] bg-[var(--color-field)] pt-1 shadow-xs focus-within:border-[var(--color-accent)]">
        {before}
        {field ?? (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              onKeyDown?.(event);
              if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (!disabled) onSubmit?.();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={disabled}
            rows={1}
            className="min-h-11 w-full resize-none border-none bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
            style={{ maxHeight }}
          />
        )}
        {children}
      </div>
    </div>
  );
}

export function PromptInputActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex w-full items-center justify-between gap-2 px-2 pb-2 pt-1', className)}
      {...props}
    />
  );
}
