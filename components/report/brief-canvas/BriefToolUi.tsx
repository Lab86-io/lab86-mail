'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { Component, type ComponentType, type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { type BriefComponentName, interactiveBriefComponents } from '@/lib/brief/component-catalog';
import type { BriefComponentState, BriefToolUiNode } from '@/lib/brief/component-state';
import { briefRefKey } from '@/lib/brief/hydration';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import { BriefActions } from './BriefActions';
import type { BriefNodeContext } from './BriefNodeView';

function LoadingComponent() {
  return (
    <p className="text-xs text-[var(--color-text-muted)]" role="status">
      Loading…
    </p>
  );
}

function EditorialText({ title, text, role }: { title?: string; text: string; role?: string }) {
  return (
    <article className="min-w-0 max-w-[72ch]">
      {title ? (
        <h2
          className={cn(
            'mb-3 font-display font-semibold tracking-tight text-[var(--color-text)]',
            role === 'lede' ? 'text-3xl leading-tight @[600px]:text-4xl' : 'text-xl leading-snug',
          )}
        >
          {title}
        </h2>
      ) : null}
      <Markdown
        className={cn(
          'max-w-none text-pretty text-[15px] leading-relaxed [&_p]:mb-3 [&_p:last-child]:mb-0',
          role === 'lede' && 'text-base @[600px]:text-lg',
          role === 'aside' && 'border-l-2 border-[var(--color-accent-2)] pl-4 text-[var(--color-text-muted)]',
        )}
      >
        {text}
      </Markdown>
    </article>
  );
}

// Every entry is checked against the authoring catalogue in contract tests.
// Payloads have already passed the component's own serializable schema.
export const briefComponentRenderers: Record<BriefComponentName, ComponentType<any>> = {
  'approval-card': dynamic(() => import('@/components/tool-ui/approval-card').then((m) => m.ApprovalCard), {
    loading: LoadingComponent,
    ssr: false,
  }),
  audio: dynamic(() => import('@/components/tool-ui/audio').then((m) => m.Audio), {
    loading: LoadingComponent,
    ssr: false,
  }),
  chart: dynamic(() => import('@/components/tool-ui/chart').then((m) => m.Chart), {
    loading: LoadingComponent,
    ssr: false,
  }),
  citation: dynamic(() => import('@/components/tool-ui/citation').then((m) => m.Citation), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'code-block': dynamic(() => import('@/components/tool-ui/code-block').then((m) => m.CodeBlock), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'code-diff': dynamic(() => import('@/components/tool-ui/code-diff').then((m) => m.CodeDiff), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'data-table': dynamic(() => import('@/components/tool-ui/data-table').then((m) => m.DataTable), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'geo-map': dynamic(() => import('@/components/ai-elements/geo-map-lazy').then((m) => m.GeoMap), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'image-gallery': dynamic(() => import('@/components/tool-ui/image-gallery').then((m) => m.ImageGallery), {
    loading: LoadingComponent,
    ssr: false,
  }),
  image: dynamic(() => import('@/components/tool-ui/image').then((m) => m.Image), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'instagram-post': dynamic(
    () => import('@/components/tool-ui/instagram-post').then((m) => m.InstagramPost),
    { loading: LoadingComponent, ssr: false },
  ),
  'item-carousel': dynamic(() => import('@/components/tool-ui/item-carousel').then((m) => m.ItemCarousel), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'link-preview': dynamic(() => import('@/components/tool-ui/link-preview').then((m) => m.LinkPreview), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'linkedin-post': dynamic(() => import('@/components/tool-ui/linkedin-post').then((m) => m.LinkedInPost), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'message-draft': dynamic(() => import('@/components/tool-ui/message-draft').then((m) => m.MessageDraft), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'option-list': dynamic(() => import('@/components/tool-ui/option-list').then((m) => m.OptionList), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'order-summary': dynamic(() => import('@/components/tool-ui/order-summary').then((m) => m.OrderSummary), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'parameter-slider': dynamic(
    () => import('@/components/tool-ui/parameter-slider').then((m) => m.ParameterSlider),
    { loading: LoadingComponent, ssr: false },
  ),
  plan: dynamic(() => import('@/components/tool-ui/plan').then((m) => m.Plan), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'preferences-panel': dynamic(
    () => import('@/components/tool-ui/preferences-panel').then((m) => m.PreferencesPanel),
    { loading: LoadingComponent, ssr: false },
  ),
  'progress-tracker': dynamic(
    () => import('@/components/tool-ui/progress-tracker').then((m) => m.ProgressTracker),
    { loading: LoadingComponent, ssr: false },
  ),
  'question-flow': dynamic(() => import('@/components/tool-ui/question-flow').then((m) => m.QuestionFlow), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'stats-display': dynamic(() => import('@/components/tool-ui/stats-display').then((m) => m.StatsDisplay), {
    loading: LoadingComponent,
    ssr: false,
  }),
  terminal: dynamic(() => import('@/components/tool-ui/terminal').then((m) => m.Terminal), {
    loading: LoadingComponent,
    ssr: false,
  }),
  video: dynamic(() => import('@/components/tool-ui/video').then((m) => m.Video), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'x-post': dynamic(() => import('@/components/tool-ui/x-post').then((m) => m.XPost), {
    loading: LoadingComponent,
    ssr: false,
  }),
  'weather-widget': dynamic(
    () => import('@/components/tool-ui/weather-widget/runtime').then((m) => m.WeatherWidget),
    { loading: LoadingComponent, ssr: false },
  ),
  'editorial-text': EditorialText,
};

class ComponentBoundary extends Component<{ children: ReactNode; summary: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="text-sm text-[var(--color-text-muted)]">{this.props.summary}</p>
    ) : (
      this.props.children
    );
  }
}

async function stateRequest(url: string, init?: RequestInit): Promise<BriefComponentState> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Your answer could not be saved.');
  return body;
}

export function BriefToolUi({ node, context }: { node: BriefToolUiNode; context: BriefNodeContext }) {
  const client = useQueryClient();
  const interactive = interactiveBriefComponents.has(node.component);
  const reportId = context.reportId;
  const identity = { reportId, componentId: node.id };
  const queryKey = ['brief-component', reportId, node.id, JSON.stringify(node.props)];
  const state = useQuery({
    queryKey,
    queryFn: () =>
      stateRequest(
        `/api/briefs/components?${new URLSearchParams({ reportId: reportId!, componentId: node.id })}`,
      ),
    enabled: interactive && !!reportId,
    staleTime: 30_000,
    retry: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const save = async (value: unknown) => {
    if (!reportId || !state.data || pending) return;
    setPending(true);
    setError('');
    try {
      const next = await stateRequest('/api/briefs/components', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...identity, stamp: state.data.stamp, revision: state.data.revision, value }),
      });
      client.setQueryData(queryKey, next);
      setEditing(false);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your answer could not be saved.');
    } finally {
      setPending(false);
    }
  };
  const continueInAssistant = () => {
    const saved = state.data;
    if (!reportId || !saved?.revision || saved.value === null || dirty) return;
    const queued = useClientStore.getState().queueBriefResponse({
      id: crypto.randomUUID(),
      title: node.summary,
      reference: {
        kind: 'component',
        reportId,
        componentId: node.id,
        stamp: saved.stamp,
        revision: saved.revision,
      },
      response:
        'Use my saved answers to help me with this. Read the sources and prepare the next useful step. Show me any proposed external action for review.',
    });
    if (!queued) setError('The assistant is handling another brief response. Try again when it finishes.');
  };
  const value = state.data?.value;
  const hasAnswer = value !== undefined && value !== null;
  const Renderer = briefComponentRenderers[node.component];
  let props: Record<string, any> = { ...node.props };
  const changed = () => setDirty(true);
  switch (node.component) {
    case 'option-list':
      props = {
        ...props,
        defaultValue: value ?? props.defaultValue,
        hideActions: false,
        actions: [{ id: 'save', label: 'Save choice' }],
        onChange: changed,
        onAction: (_: string, selected: unknown) =>
          save(typeof selected === 'string' ? [selected] : (selected ?? [])),
      };
      break;
    case 'parameter-slider':
      props = {
        ...props,
        sliders: props.sliders.map((s: any) => ({
          ...s,
          value: hasAnswer ? ((value as Record<string, number>)[s.id] ?? s.value) : s.value,
        })),
        actions: [{ id: 'save', label: 'Save values' }],
        onChange: changed,
        onAction: (_: string, values: Array<{ id: string; value: number }>) =>
          save(Object.fromEntries(values.map((v) => [v.id, v.value]))),
      };
      break;
    case 'preferences-panel':
      props = {
        ...props,
        sections: props.sections.map((section: any) => ({
          ...section,
          items: section.items.map((item: any) =>
            hasAnswer
              ? {
                  ...item,
                  defaultChecked: (value as any)[item.id],
                  defaultValue: (value as any)[item.id],
                  defaultSelected: (value as any)[item.id],
                }
              : item,
          ),
        })),
        actions: [{ id: 'save', label: 'Save preferences' }],
        onChange: changed,
        onAction: (_: string, values: unknown) => save(values),
      };
      break;
    case 'approval-card':
      props = {
        ...props,
        confirmLabel: 'Save approval',
        cancelLabel: 'Decline',
        choice: hasAnswer && !editing ? value : undefined,
        onConfirm: () => save('approved'),
        onCancel: () => save('denied'),
      };
      break;
    case 'question-flow':
      props =
        hasAnswer && !editing
          ? {
              id: node.id,
              choice: {
                title: 'Your saved answers',
                summary: props.steps.map((step: any) => ({
                  label: step.title,
                  value: step.options
                    .filter((o: any) => (value as Record<string, string[]>)[step.id]?.includes(o.id))
                    .map((o: any) => o.label)
                    .join(', '),
                })),
              },
            }
          : { ...props, onStepChange: changed, onComplete: (answers: unknown) => save(answers) };
      break;
    case 'item-carousel':
      props = {
        ...props,
        items: props.items.map((item: any) => ({
          ...item,
          actions: [
            { id: 'select', label: Array.isArray(value) && value.includes(item.id) ? 'Selected' : 'Select' },
          ],
        })),
        onItemClick: (id: string) => save([id]),
        onItemAction: (id: string) => save([id]),
      };
      break;
    case 'message-draft':
      props = {
        ...props,
        body: hasAnswer ? (value as { body: string }).body : props.body,
        outcome: hasAnswer && (value as { cancelled?: boolean }).cancelled ? 'cancelled' : undefined,
        onCancel: () =>
          save({
            body: hasAnswer ? (value as { body: string }).body : String(node.props.body),
            cancelled: true,
          }),
        onEdit: () => {
          setEditing(true);
          setDirty(true);
        },
      };
      break;
  }
  const sources = node.sources.filter((source) => !context.hiddenRefs.has(briefRefKey(source.ref)));
  return (
    <section
      data-brief-component={node.component}
      data-brief-component-id={node.id}
      className="min-w-0 space-y-3"
    >
      {interactive && !props.title ? (
        <h3 className="font-display text-lg font-semibold leading-snug">{node.summary}</h3>
      ) : null}
      <ComponentBoundary key={JSON.stringify(node.props)} summary={node.summary}>
        <fieldset
          disabled={interactive && (pending || !reportId || !state.data || state.isError)}
          className="min-w-0 border-0 p-0 m-0"
        >
          <Renderer key={`${state.data?.revision ?? 'initial'}:${editing}:${resetKey}`} {...props} />
          {node.component === 'message-draft' && editing ? (
            <DraftEditor initial={String(props.body)} onSave={(body) => save({ body })} />
          ) : null}
        </fieldset>
      </ComponentBoundary>
      {interactive ? (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]"
          aria-live="polite"
        >
          {pending ? <span>Saving…</span> : hasAnswer && !dirty ? <span>Saved to this brief</span> : null}
          {hasAnswer && ['approval-card', 'question-flow'].includes(node.component) && !editing ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setEditing(true);
                setDirty(true);
              }}
            >
              Edit answers
            </Button>
          ) : null}
          {hasAnswer &&
          !(node.component === 'message-draft' && (value as { cancelled?: boolean }).cancelled) ? (
            <Button size="xs" variant="outline" disabled={pending || dirty} onClick={continueInAssistant}>
              Continue in assistant
            </Button>
          ) : null}
          {node.component === 'message-draft' && hasAnswer && (value as { cancelled?: boolean }).cancelled ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => save({ body: (value as { body: string }).body })}
            >
              Restore draft
            </Button>
          ) : null}
          {!reportId ? (
            <span>Save this edition to use its inputs.</span>
          ) : state.isPending ? (
            <span>Loading saved answers…</span>
          ) : null}
          {dirty && hasAnswer ? <span>Save your changes to continue.</span> : null}
          {error || state.error ? (
            <>
              <span role="alert">{error || state.error?.message}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setError('');
                  void state.refetch().then((result) => {
                    if (!result.isError) {
                      setResetKey((key) => key + 1);
                      setEditing(false);
                      setDirty(false);
                    }
                  });
                }}
              >
                Reload saved answer
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {sources.length ? (
        <details
          className="text-xs text-[var(--color-text-muted)]"
          open={sources.some((source) => source.actions.some((action) => !action.action.startsWith('open_')))}
        >
          <summary className="mb-2 cursor-pointer select-none">
            {sources.length === 1 ? 'Source and actions' : `${sources.length} sources and actions`}
          </summary>
          <div className="space-y-2">
            {sources.map((source) => (
              <div key={briefRefKey(source.ref)} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words">{source.ref.label || source.ref.id}</span>
                <BriefActions
                  actions={source.actions}
                  sourceRef={source.ref}
                  compact
                  onAction={(action, payload) => context.onAction(action, payload, source.ref)}
                />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DraftEditor({ initial, onSave }: { initial: string; onSave: (body: string) => Promise<void> }) {
  const [body, setBody] = useState(initial);
  return (
    <div className="mt-3 space-y-2">
      <label className="block text-xs font-medium">
        Edit draft
        <textarea
          className="mt-1 min-h-40 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-base sm:text-sm"
          value={body}
          maxLength={20000}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <Button size="sm" variant="outline" disabled={!body.trim()} onClick={() => onSave(body)}>
        Save draft
      </Button>
    </div>
  );
}
