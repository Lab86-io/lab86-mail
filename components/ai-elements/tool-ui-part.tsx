'use client';

// Rich renderings for the agent's show_* display tools (lib/tools/display.ts),
// built on the tool-ui component library (components/tool-ui). Success states
// render the designed component; running/failed states stay on the shared
// quiet ToolActivityRow — callers only reach for this on
// state === 'output-available' with output.ok === true.
//
// Components are dynamically imported (ssr off) so heavy dependencies —
// shiki, leaflet, recharts, the weather effect runtime — never weigh down the
// shell bundle until a card actually renders.

import { ExternalLink, FileSpreadsheet, FileText, Mail, Paperclip, Presentation } from 'lucide-react';
import dynamic from 'next/dynamic';
import { Loader } from '@/components/ui/loader';
import { emailPreviewThreadTarget } from '@/lib/ai/email-preview-routing';

function LoadingCard() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5 text-[12px] text-[var(--color-text-muted)]">
      <Loader variant="typing" />
    </div>
  );
}

const WeatherWidget = dynamic(
  () => import('@/components/tool-ui/weather-widget/runtime').then((m) => m.WeatherWidget),
  { loading: LoadingCard, ssr: false },
);
const Chart = dynamic(() => import('@/components/tool-ui/chart').then((m) => m.Chart), {
  loading: LoadingCard,
  ssr: false,
});
const StatsDisplay = dynamic(() => import('@/components/tool-ui/stats-display').then((m) => m.StatsDisplay), {
  loading: LoadingCard,
  ssr: false,
});
const DataTable = dynamic(() => import('@/components/tool-ui/data-table').then((m) => m.DataTable), {
  loading: LoadingCard,
  ssr: false,
});
const CodeBlock = dynamic(() => import('@/components/tool-ui/code-block').then((m) => m.CodeBlock), {
  loading: LoadingCard,
  ssr: false,
});
const CodeDiff = dynamic(() => import('@/components/tool-ui/code-diff').then((m) => m.CodeDiff), {
  loading: LoadingCard,
  ssr: false,
});
const Terminal = dynamic(() => import('@/components/tool-ui/terminal').then((m) => m.Terminal), {
  loading: LoadingCard,
  ssr: false,
});
const Plan = dynamic(() => import('@/components/tool-ui/plan').then((m) => m.Plan), {
  loading: LoadingCard,
  ssr: false,
});
const ProgressTracker = dynamic(
  () => import('@/components/tool-ui/progress-tracker').then((m) => m.ProgressTracker),
  { loading: LoadingCard, ssr: false },
);
const CitationList = dynamic(() => import('@/components/tool-ui/citation').then((m) => m.CitationList), {
  loading: LoadingCard,
  ssr: false,
});
const LinkPreview = dynamic(() => import('@/components/tool-ui/link-preview').then((m) => m.LinkPreview), {
  loading: LoadingCard,
  ssr: false,
});
const ToolUiImage = dynamic(() => import('@/components/tool-ui/image').then((m) => m.Image), {
  loading: LoadingCard,
  ssr: false,
});
const ImageGallery = dynamic(() => import('@/components/tool-ui/image-gallery').then((m) => m.ImageGallery), {
  loading: LoadingCard,
  ssr: false,
});
const Video = dynamic(() => import('@/components/tool-ui/video').then((m) => m.Video), {
  loading: LoadingCard,
  ssr: false,
});
const ToolUiAudio = dynamic(() => import('@/components/tool-ui/audio').then((m) => m.Audio), {
  loading: LoadingCard,
  ssr: false,
});
const GeoMap = dynamic(() => import('@/components/ai-elements/geo-map-lazy').then((m) => m.GeoMap), {
  loading: LoadingCard,
  ssr: false,
});
const ItemCarousel = dynamic(() => import('@/components/tool-ui/item-carousel').then((m) => m.ItemCarousel), {
  loading: LoadingCard,
  ssr: false,
});
const OrderSummary = dynamic(() => import('@/components/tool-ui/order-summary').then((m) => m.OrderSummary), {
  loading: LoadingCard,
  ssr: false,
});
const XPost = dynamic(() => import('@/components/tool-ui/x-post').then((m) => m.XPost), {
  loading: LoadingCard,
  ssr: false,
});
const LinkedInPost = dynamic(() => import('@/components/tool-ui/linkedin-post').then((m) => m.LinkedInPost), {
  loading: LoadingCard,
  ssr: false,
});
const InstagramPost = dynamic(
  () => import('@/components/tool-ui/instagram-post').then((m) => m.InstagramPost),
  { loading: LoadingCard, ssr: false },
);
const MessageDraft = dynamic(() => import('@/components/tool-ui/message-draft').then((m) => m.MessageDraft), {
  loading: LoadingCard,
  ssr: false,
});

// Everything the dispatcher can render. Kept in sync with DISPLAY_TOOL_NAMES
// (lib/tools/display.ts) — tested in tests/tools-display.test.ts.
export const TOOL_UI_RENDERED_TOOLS: ReadonlySet<string> = new Set([
  'document_create',
  'document_suggest_changes',
  'document_apply_instruction',
  'document_publish_google',
  'google_file_import',
  'show_weather',
  'show_chart',
  'show_stats',
  'show_table',
  'show_code',
  'show_code_diff',
  'show_terminal',
  'show_plan',
  'show_progress',
  'show_citations',
  'show_link_preview',
  'show_image',
  'show_image_gallery',
  'show_video',
  'show_audio',
  'show_map',
  'show_carousel',
  'show_order_summary',
  'show_social_post',
  'show_message_draft',
  'show_email_preview',
]);

export interface DraftOpenRequest {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

export function resolveInternalOpenPath(
  value: unknown,
  origin = typeof window === 'undefined' ? 'https://albatross.invalid' : window.location.origin,
) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  try {
    const resolved = new URL(value, origin);
    if (resolved.origin !== origin) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}

// Renders one successful display-tool output. Returns null for anything it
// cannot render — the caller falls back to the quiet activity row.
export function ToolUiDisplayPart({
  toolName,
  output,
  onOpenDraft,
  onOpenThread,
}: {
  toolName: string;
  output: any;
  onOpenDraft?: (draft: DraftOpenRequest) => void;
  onOpenThread?: (target: { account: string; threadId: string }) => void;
}) {
  const internalOpenPath = resolveInternalOpenPath(output?.openPath);
  if (
    output?.ok &&
    [
      'document_create',
      'document_suggest_changes',
      'document_apply_instruction',
      'google_file_import',
    ].includes(toolName) &&
    internalOpenPath
  ) {
    const kind = String(output.kind || '');
    const Icon = kind === 'sheet' ? FileSpreadsheet : kind === 'deck' ? Presentation : FileText;
    const title = String(
      output.title || (toolName === 'document_suggest_changes' ? 'Suggested changes' : 'File'),
    );
    return (
      <a
        href={internalOpenPath}
        className="group flex w-full max-w-[460px] items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-left shadow-[var(--shadow-soft)] transition hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-pop)]"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-[var(--color-text)]">{title}</span>
          <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
            {toolName === 'document_suggest_changes'
              ? 'Review the suggestion in the editor'
              : 'Open the editable file'}
          </span>
        </span>
        <ExternalLink className="size-3.5 text-[var(--color-text-faint)] transition group-hover:text-[var(--color-text)]" />
      </a>
    );
  }
  if (toolName === 'document_publish_google' && output?.ok && typeof output.webUrl === 'string') {
    return (
      <a
        href={output.webUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full max-w-[460px] items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-[13px] font-medium text-[var(--color-text)]"
      >
        <ExternalLink className="size-4 text-[var(--color-accent)]" />
        Open the synced Google file
      </a>
    );
  }
  const payload = output?.payload;
  if (!output?.ok || !payload || typeof payload !== 'object') return null;

  try {
    switch (toolName) {
      case 'show_weather':
        return (
          <div className="max-w-[380px] overflow-hidden rounded-2xl">
            <WeatherWidget {...payload} />
          </div>
        );
      case 'show_chart':
        return <Chart {...payload} />;
      case 'show_stats':
        return <StatsDisplay {...payload} />;
      case 'show_table':
        return <DataTable {...payload} />;
      case 'show_code':
        return <CodeBlock {...payload} />;
      case 'show_code_diff':
        return <CodeDiff {...payload} />;
      case 'show_terminal':
        return <Terminal {...payload} />;
      case 'show_plan':
        return <Plan {...payload} />;
      case 'show_progress':
        return <ProgressTracker {...payload} />;
      case 'show_citations':
        return Array.isArray(payload) && payload.length ? (
          <CitationList id={payload[0].id} citations={payload} />
        ) : null;
      case 'show_link_preview':
        return <LinkPreview {...payload} />;
      case 'show_image':
        return <ToolUiImage {...payload} />;
      case 'show_image_gallery':
        return <ImageGallery {...payload} />;
      case 'show_video':
        return <Video {...payload} />;
      case 'show_audio':
        return <ToolUiAudio {...payload} />;
      case 'show_map':
        return <GeoMap {...payload} />;
      case 'show_carousel':
        return <ItemCarousel {...payload} />;
      case 'show_order_summary':
        return <OrderSummary {...payload} />;
      case 'show_social_post': {
        if (payload.network === 'x') return <XPost {...payload.post} />;
        if (payload.network === 'linkedin') return <LinkedInPost {...payload.post} />;
        if (payload.network === 'instagram') return <InstagramPost {...payload.post} />;
        return null;
      }
      case 'show_message_draft':
        return (
          <MessageDraft
            {...payload}
            undoGracePeriod={0}
            onSend={
              onOpenDraft
                ? () =>
                    onOpenDraft({
                      to: (payload.to || []).join(', '),
                      cc: payload.cc?.join(', '),
                      bcc: payload.bcc?.join(', '),
                      subject: payload.subject,
                      body: payload.body,
                    })
                : undefined
            }
          />
        );
      case 'show_email_preview': {
        const target = emailPreviewThreadTarget(payload);
        if (!target) return null;
        return (
          <button
            type="button"
            onClick={() => onOpenThread?.(target)}
            disabled={!onOpenThread}
            className="group w-full max-w-[520px] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-left shadow-[var(--shadow-soft)] transition hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-pop)] disabled:cursor-default"
          >
            <div className="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Mail className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-semibold text-[var(--color-text)]">
                    {payload.from}
                  </span>
                  {payload.date ? (
                    <time className="shrink-0 text-[10px] text-[var(--color-text-faint)]">
                      {new Intl.DateTimeFormat(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      }).format(new Date(payload.date))}
                    </time>
                  ) : null}
                </span>
                <span className="mt-0.5 block line-clamp-2 font-display text-base font-semibold leading-tight text-[var(--color-text)]">
                  {payload.subject}
                </span>
              </span>
            </div>
            <span className="block px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              <span className="line-clamp-4">{payload.snippet}</span>
              <span className="mt-3 flex items-center gap-3 text-[10px] font-medium text-[var(--color-text-faint)]">
                {payload.messageCount ? <span>{payload.messageCount} messages</span> : null}
                {payload.attachmentCount ? (
                  <span className="inline-flex items-center gap-1">
                    <Paperclip className="size-3" />
                    {payload.attachmentCount}
                  </span>
                ) : null}
                <span className="ml-auto text-[var(--color-accent)] group-hover:underline">Open email</span>
              </span>
            </span>
          </button>
        );
      }
      default:
        return null;
    }
  } catch {
    // A malformed payload must never take the chat down — quiet fallback.
    return null;
  }
}
