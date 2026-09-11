'use client';

import { useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';
import { useMeteredText } from '@/components/ui/metered-text';
import { cn } from '@/lib/utils';

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: StreamdownProps['components'];
  /** True while the stream still writes into `children`. */
  streaming?: boolean;
};

// The word motion is the route chip flip (components/shell/RouteChip.tsx):
// rise from 6px below with opacity 0, 150ms, the same curve. Streamdown writes
// `--sd-animation: sd-rise`; the keyframe lives in app/globals.css. Stagger is
// zero because the metered reveal already spaces the words.
export const STREAMING_WORD_RISE = {
  animation: 'rise' as const,
  duration: 150,
  easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
  sep: 'word' as const,
  stagger: 0,
};

function MarkdownComponent({ children, id, className, components, streaming = false }: MarkdownProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const metered = useMeteredText(children, streaming, reduceMotion);
  // Stay in streaming mode until the metered cursor has drained, so the switch
  // to static happens on text that no longer changes and nothing reflows.
  const live = streaming || !metered.settled;
  const streamProps = live
    ? ({
        mode: 'streaming',
        animated: reduceMotion ? false : STREAMING_WORD_RISE,
        isAnimating: true,
      } as const)
    : ({ mode: 'static' } as const);
  // `.chat-reveal` draws the leading dot after the last revealed word.
  const revealClass = live && !reduceMotion ? 'chat-reveal' : undefined;
  if (id) {
    return (
      <div id={id} className={className}>
        <Streamdown className={revealClass} components={components} {...streamProps}>
          {metered.text}
        </Streamdown>
      </div>
    );
  }

  return (
    <Streamdown className={cn(className, revealClass)} components={components} {...streamProps}>
      {metered.text}
    </Streamdown>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = 'Markdown';

export { Markdown };
