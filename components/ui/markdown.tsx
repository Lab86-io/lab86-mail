import { memo } from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: StreamdownProps['components'];
};

function MarkdownComponent({ children, id, className, components }: MarkdownProps) {
  if (id) {
    return (
      <div id={id} className={className}>
        <Streamdown components={components} mode="static">
          {children}
        </Streamdown>
      </div>
    );
  }

  return (
    <Streamdown className={className} components={components} mode="static">
      {children}
    </Streamdown>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = 'Markdown';

export { Markdown };
