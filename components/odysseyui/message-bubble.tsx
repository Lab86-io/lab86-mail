'use client';

// Adapted from Odyssey UI; see README.md for upstream source and local changes.

import { createContext, useContext } from 'react';
import { cn } from '@/lib/utils';

type Role = 'user' | 'assistant';

type MessageBubbleContextValue = { isUser: boolean };

const MessageBubbleContext = createContext<MessageBubbleContextValue | null>(null);

function useMessageBubble() {
  const ctx = useContext(MessageBubbleContext);
  if (!ctx) throw new Error('useMessageBubble must be used inside <MessageBubble />');
  return ctx;
}

export type MessageBubbleProps = React.ComponentProps<'div'> & { from: Role };

export function MessageBubble({ from, children, className, ...props }: MessageBubbleProps) {
  const isUser = from === 'user';
  return (
    <MessageBubbleContext.Provider value={{ isUser }}>
      <div
        data-slot="message-bubble"
        data-message-role={from}
        className={cn('flex w-full items-end gap-2', isUser ? 'flex-row-reverse' : 'flex-row', className)}
        {...props}
      >
        {children}
      </div>
    </MessageBubbleContext.Provider>
  );
}

export type MessageBubbleContentProps = React.ComponentProps<'div'>;

export function MessageBubbleContent({ children, className, ...props }: MessageBubbleContentProps) {
  const { isUser } = useMessageBubble();
  return (
    <div
      data-slot="message-bubble-content"
      className={cn(
        'min-w-0 max-w-[88%] break-words rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed',
        isUser
          ? 'bg-[var(--color-accent-soft)] text-foreground rounded-br-sm'
          : 'bg-muted text-foreground rounded-bl-sm',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageBubbleTimestampProps = React.ComponentProps<'p'>;

export function MessageBubbleTimestamp({ children, className, ...props }: MessageBubbleTimestampProps) {
  const { isUser } = useMessageBubble();
  return (
    <p
      className={cn(
        'mt-1 text-right text-[10px]',
        isUser ? 'text-primary-foreground/60' : 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </p>
  );
}

export { useMessageBubble };
