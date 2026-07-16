import { memo } from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: StreamdownProps['components'];
  streaming?: boolean;
};

export const STREAMING_WORD_FADE = {
  animation: 'fadeIn' as const,
  duration: 180,
  sep: 'word' as const,
  stagger: 24,
};

function MarkdownComponent({ children, id, className, components, streaming = false }: MarkdownProps) {
  const streamProps = streaming
    ? ({ mode: 'streaming', animated: STREAMING_WORD_FADE, isAnimating: true } as const)
    : ({ mode: 'static' } as const);
  if (id) {
    return (
      <div id={id} className={className}>
        <Streamdown components={components} {...streamProps}>
          {children}
        </Streamdown>
      </div>
    );
  }

  return (
    <Streamdown className={className} components={components} {...streamProps}>
      {children}
    </Streamdown>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = 'Markdown';

export { Markdown };
