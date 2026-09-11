import type { CatalogProvider } from '@/lib/ai/model-catalog';
import { cn } from '@/lib/utils';

// One small monochrome mark per vendor, drawn in currentColor so it follows
// the text tone of its row. These are abstract marks, not brand logos: the
// picker needs a stable visual anchor per group, not a trademark.

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function paths(provider: CatalogProvider) {
  switch (provider) {
    case 'openai':
      return (
        <>
          <circle cx="12" cy="12" r="7.5" {...STROKE} />
          <path d="M12 4.5v15M5.5 8.25l13 7.5M5.5 15.75l13-7.5" {...STROKE} strokeWidth={1.2} />
        </>
      );
    case 'anthropic':
      return (
        <path
          d="M5 18.5 10.4 5.5h3.2L19 18.5h-2.9l-1.3-3.4H9.2l-1.3 3.4Zm5.1-5.8h3.8L12 7.6Z"
          fill="currentColor"
        />
      );
    case 'google':
      return (
        <>
          <path d="M18.2 8.2A7 7 0 1 0 19 12" {...STROKE} />
          <path d="M12 12h7" {...STROKE} />
        </>
      );
    case 'xai':
      return <path d="M6 5.5 18 18.5M18 5.5l-4.6 5M6 18.5l4.6-5" {...STROKE} />;
    case 'deepseek':
      return (
        <>
          <path d="M4.5 14.5c2.5 0 3.5-5 7-5s3.5 5 7 5" {...STROKE} />
          <path d="M4.5 9.5c2-2 5-2.5 7.5-1" {...STROKE} />
        </>
      );
    case 'moonshotai':
      return <path d="M14.5 4.5a8 8 0 1 0 5 13.6A7 7 0 0 1 14.5 4.5Z" {...STROKE} />;
    case 'qwen':
      return (
        <>
          <circle cx="11.5" cy="11.5" r="6.5" {...STROKE} />
          <path d="m15 15 4.5 4.5" {...STROKE} />
        </>
      );
    case 'meta':
      return (
        <path
          d="M4.5 12c0-3 1.5-5 3.4-5 3 0 5.2 10 8.2 10 1.9 0 3.4-2 3.4-5s-1.5-5-3.4-5c-3 0-5.2 10-8.2 10-1.9 0-3.4-2-3.4-5Z"
          {...STROKE}
        />
      );
    case 'mistral':
      return (
        <>
          <path d="M5 7h14" {...STROKE} strokeWidth={2.2} />
          <path d="M7 12h10" {...STROKE} strokeWidth={2.2} />
          <path d="M9 17h6" {...STROKE} strokeWidth={2.2} />
        </>
      );
    default:
      return (
        <>
          <circle cx="12" cy="12" r="7.5" {...STROKE} />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        </>
      );
  }
}

export function ProviderGlyph({
  provider,
  className,
  title,
}: {
  provider: CatalogProvider;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={title ?? provider}
      data-provider={provider}
      className={cn('size-4 shrink-0', className)}
    >
      <title>{title ?? provider}</title>
      {paths(provider)}
    </svg>
  );
}
