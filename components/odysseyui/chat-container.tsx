'use client';

// Adapted from Odyssey UI; see README.md for upstream source and local changes.

import { ChevronDown, MessageCircle } from 'lucide-react';
import { AnimatePresence, HTMLMotionProps, motion, useReducedMotion } from 'motion/react';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ChatContainerContextValue = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  isAtBottom: boolean;
  isEmpty: boolean;
  messageCount: number;
  registerMessage: () => () => void;
};

const ChatContainerContext = createContext<ChatContainerContextValue | null>(null);

const useChatContainer = () => {
  const ctx = useContext(ChatContainerContext);
  if (!ctx) throw new Error('useChatContainer must be used inside <ChatContainer />');
  return ctx;
};

export type ChatContainerProps = React.ComponentProps<'div'> & {
  bottomThreshold?: number;
  autoScroll?: boolean;
};

export function ChatContainer({
  children,
  className,
  bottomThreshold = 64,
  autoScroll = true,
  ...props
}: ChatContainerProps) {
  const reduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [messageCount, setMessageCount] = useState(0);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion ? 'instant' : behavior });
    },
    [reduceMotion],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const distFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      atBottomRef.current = distFromBottom <= bottomThreshold;
      setIsAtBottom(atBottomRef.current);
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [bottomThreshold]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (autoScroll && atBottomRef.current) scrollToBottom('instant');
    });
    observer.observe(content);
    if (autoScroll) scrollToBottom('instant');
    return () => observer.disconnect();
  }, [autoScroll, scrollToBottom]);

  const registerMessage = useCallback(() => {
    setMessageCount((c) => c + 1);
    return () => setMessageCount((c) => c - 1);
  }, []);

  const isEmpty = messageCount === 0;

  return (
    <ChatContainerContext.Provider
      value={{
        scrollToBottom,
        isAtBottom,
        isEmpty,
        messageCount,
        registerMessage,
      }}
    >
      <div
        data-slot="chat-container"
        className={cn('relative min-h-0 overflow-hidden rounded-ui', className)}
        {...props}
      >
        <div className={cn('relative flex h-full w-full flex-col', 'overflow-hidden')}>
          <div
            ref={viewportRef}
            className="min-h-0 flex-1 w-full overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
          >
            <div ref={contentRef} role="log" aria-label="Conversation">
              {children}
            </div>
          </div>
          <ChatContainerScrollButton />
        </div>
      </div>
    </ChatContainerContext.Provider>
  );
}

export type ChatContainerContentProps = React.ComponentProps<'div'>;

export const ChatContainerContent = ({ children, className, ...props }: ChatContainerContentProps) => (
  <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6', className)} {...props}>
    {children}
  </div>
);

export type ChatContainerEmptyStateProps = Omit<HTMLMotionProps<'div'>, 'children'> & {
  children?: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  description?: string;
};

export const ChatContainerEmptyState = ({
  className,
  icon,
  title = 'No messages yet',
  description = 'Start a conversation to see messages here.',
  children,
  ...props
}: ChatContainerEmptyStateProps) => {
  const { isEmpty } = useChatContainer();
  const reduceMotion = useReducedMotion();
  if (!isEmpty) return null;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: 'easeOut' }}
      className={cn('flex flex-col items-center justify-center gap-3 py-20 text-center', className)}
      {...props}
    >
      <div className="text-muted-foreground/40">
        {icon ?? <MessageCircle className="size-10" strokeWidth={1.25} />}
      </div>
      <div className="space-y-1">
        <p className="text-foreground/80 text-sm font-medium">{title}</p>
        <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">{description}</p>
      </div>
      {children}
    </motion.div>
  );
};

export type ChatContainerScrollButtonProps = React.ComponentProps<typeof Button> & {
  icon?: React.ReactNode;
};

export const ChatContainerScrollButton = ({
  className,
  icon,
  onClick,
  ...props
}: ChatContainerScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useChatContainer();
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {!isAtBottom && (
        <motion.div
          key="scroll-btn"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.85, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.85, y: 8 }}
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2"
        >
          <Button
            size="icon"
            variant="secondary"
            className={cn(
              'hover:bg-background size-8 rounded-full border shadow-md backdrop-blur-sm',
              className,
            )}
            onClick={(e) => {
              scrollToBottom('smooth');
              onClick?.(e);
            }}
            aria-label="Scroll to bottom"
            {...props}
          >
            {icon ?? <ChevronDown className="size-4" />}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export type ChatContainerMessageProps = Omit<HTMLMotionProps<'div'>, 'children'> & {
  children?: React.ReactNode;
};

export const ChatContainerMessage = ({ children, className, ...props }: ChatContainerMessageProps) => {
  const { registerMessage } = useChatContainer();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    return registerMessage();
  }, [registerMessage]);

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: 'easeOut' }}
      className={cn('w-full', className)}
      {...props}
    >
      {children}
    </motion.div>
  );
};

export { useChatContainer };
