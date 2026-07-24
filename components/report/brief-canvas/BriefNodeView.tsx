'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Circle, CircleCheck, Clock3, ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { Chart } from '@/components/tool-ui/chart';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { briefQueryKeys, briefRefKey } from '@/lib/brief/hydration';
import type {
  BriefActionV2,
  BriefContentLeaf,
  BriefEntityHandoffV1,
  BriefNode,
  BriefQuery,
  BriefSourceRefV2,
} from '@/lib/shared/brief-document';
import type { BriefHydratedEntity } from '@/lib/shared/brief-hydration';
import { cn } from '@/lib/utils';
import { BriefActions } from './BriefActions';
import { BriefCanvasLeaf } from './BriefCanvasLeaf';
import type { BriefActionPayload } from './brief-action-runtime';

export interface BriefNodeContext {
  entities: Map<string, BriefHydratedEntity>;
  hiddenRefs: Set<string>;
  completedRefs: Map<string, boolean>;
  onAction: (
    action: BriefActionV2,
    payload: BriefActionPayload,
    sourceRef?: BriefSourceRefV2,
  ) => Promise<void> | void;
  onCanvasAction: (action: string, payload: BriefActionPayload) => void;
}

export function BriefNodeView({
  node,
  context,
  regionSummary,
}: {
  node: BriefNode;
  context: BriefNodeContext;
  regionSummary: string;
}) {
  const common = nodeClass(node);
  switch (node.kind) {
    case 'stack':
      return (
        <div
          className={cn(
            'flex flex-col',
            node.density === 'airy' ? 'gap-6' : node.density === 'dense' ? 'gap-2.5' : 'gap-4',
            common,
          )}
        >
          {node.children.map((child, index) => (
            <BriefNodeView
              key={child.id ?? `${child.kind}-${index}`}
              node={child}
              context={context}
              regionSummary={regionSummary}
            />
          ))}
        </div>
      );
    case 'grid':
      return (
        <div
          className={cn(
            'grid grid-cols-1 gap-3 @[560px]:grid-cols-2',
            node.columns === 3 && '@[860px]:grid-cols-3',
            common,
          )}
        >
          {node.children.map((child, index) => (
            <BriefNodeView
              key={child.id ?? `${child.kind}-${index}`}
              node={child}
              context={context}
              regionSummary={regionSummary}
            />
          ))}
        </div>
      );
    case 'split':
      return (
        <div
          className={cn(
            'grid grid-cols-1 gap-4 @[720px]:grid-cols-2',
            node.ratio === 'lead' && '@[720px]:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]',
            common,
          )}
        >
          {node.children.map((child, index) => (
            <BriefNodeView
              key={child.id ?? `${child.kind}-${index}`}
              node={child}
              context={context}
              regionSummary={regionSummary}
            />
          ))}
        </div>
      );
    case 'hero':
      return (
        <section
          className={cn(
            'overflow-hidden rounded-2xl border px-5 py-6 @[620px]:px-7 @[620px]:py-8',
            heroSurfaceClass(node.surface),
            common,
          )}
        >
          <div className="flex flex-col gap-4">
            {node.children.map((child, index) => (
              <BriefNodeView
                key={child.id ?? `${child.kind}-${index}`}
                node={child}
                context={context}
                regionSummary={regionSummary}
              />
            ))}
          </div>
        </section>
      );
    case 'group':
      return <BriefGroup node={node} context={context} regionSummary={regionSummary} />;
    default:
      return <BriefLeaf node={node} context={context} regionSummary={regionSummary} />;
  }
}

function BriefGroup({
  node,
  context,
  regionSummary,
}: {
  node: Extract<BriefNode, { kind: 'group' }>;
  context: BriefNodeContext;
  regionSummary: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section
      className={cn('rounded-xl border px-4 py-4 @[520px]:px-5', surfaceClass(node.surface), nodeClass(node))}
    >
      <button
        type="button"
        disabled={!node.collapsible}
        className="mb-3 flex w-full items-start justify-between gap-3 text-left disabled:cursor-default"
        onClick={() => node.collapsible && setOpen((value) => !value)}
      >
        <span>
          {node.kicker ? (
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-accent-2)]">
              {node.kicker}
            </span>
          ) : null}
          <span className="font-display text-lg font-semibold leading-tight">{node.title}</span>
        </span>
        {node.collapsible ? (
          <ChevronDown className={cn('mt-1 size-4 transition-transform', !open && '-rotate-90')} />
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-3">
          {node.children.map((child, index) => (
            <BriefNodeView
              key={child.id ?? `${child.kind}-${index}`}
              node={child}
              context={context}
              regionSummary={regionSummary}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BriefLeaf({
  node,
  context,
  regionSummary,
}: {
  node: BriefContentLeaf;
  context: BriefNodeContext;
  regionSummary: string;
}) {
  switch (node.kind) {
    case 'text':
      return (
        <Markdown
          className={cn(
            'max-w-none text-pretty [&_p]:my-0',
            node.role === 'lede' && 'font-display text-xl leading-relaxed @[600px]:text-2xl',
            node.role === 'kicker' &&
              'text-[11px] font-semibold uppercase tracking-[0.17em] text-[var(--color-accent-2)]',
            node.role === 'body' && 'text-sm leading-relaxed @[600px]:text-[15px]',
            node.role === 'aside' && 'border-l-2 border-[var(--color-accent-2)] pl-3 text-sm italic',
            node.role === 'caption' && 'text-xs text-[var(--color-text-muted)]',
            nodeClass(node),
          )}
        >
          {node.text}
        </Markdown>
      );
    case 'actions':
      return (
        <BriefActions
          actions={node.actions}
          onAction={(action, payload) => context.onAction(action, payload)}
        />
      );
    case 'prompt':
      return <BriefPrompt node={node} context={context} />;
    case 'divider':
      if (node.variant === 'space') return <div aria-hidden className="h-3" />;
      if (node.variant === 'flourish')
        return (
          <div aria-hidden className="text-center font-display text-[var(--color-text-faint)]">
            ✦
          </div>
        );
      return <hr className="border-[var(--color-border)]" />;
    case 'entity_list':
      return (
        <BriefEntityList
          title={node.title}
          items={node.items.map((item) => ({
            ref: item.ref,
            reason: item.framing.reason,
            lane: item.framing.lane,
            prep: item.framing.prep,
            handoff: item.handoff,
            actions: item.actions,
          }))}
          emptyText={node.emptyText}
          variant={node.variant}
          context={context}
        />
      );
    case 'query_list':
      return <BriefQueryList node={node} context={context} />;
    case 'stat':
      return <BriefStat node={node} />;
    case 'chart':
      return (
        <Chart
          id={node.id ?? `brief-chart-${node.title}`}
          type={node.variant === 'line' ? 'line' : 'bar'}
          title={node.title}
          description={node.description}
          data={node.data.map((point) => ({ label: point.label, value: point.value }))}
          xKey="label"
          series={[{ key: 'value', label: node.title }]}
          showGrid={node.variant !== 'donut'}
          className="min-w-0 gap-3 py-4 shadow-none [&_[data-slot=card-content]]:px-4 [&_[data-slot=card-header]]:px-4"
        />
      );
    case 'timeline':
      return (
        <section className={cn('space-y-3', nodeClass(node))}>
          <h3 className="font-display text-lg font-semibold">{node.title}</h3>
          <ol className="space-y-1">
            {node.items.map((item, index) => (
              <li
                key={`${item.ref ? briefRefKey(item.ref) : item.label}:${item.at ?? ''}`}
                className="grid grid-cols-[18px_1fr] gap-2 py-2"
              >
                <div className="flex flex-col items-center">
                  <Clock3 className="size-3.5 text-[var(--color-accent-2)]" />
                  {index < node.items.length - 1 ? (
                    <span className="mt-1 w-px flex-1 bg-[var(--color-border)]" />
                  ) : null}
                </div>
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm font-medium">
                    <span>{item.label}</span>
                    {item.at ? (
                      <time className="text-xs font-normal text-[var(--color-text-muted)]">
                        {formatBriefTime(item.at)}
                      </time>
                    ) : null}
                  </div>
                  {item.detail ? (
                    <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
                      {item.detail}
                    </p>
                  ) : null}
                  <BriefActions
                    actions={item.actions}
                    sourceRef={item.ref}
                    compact
                    onAction={(action, payload) => context.onAction(action, payload, item.ref)}
                  />
                </div>
              </li>
            ))}
          </ol>
        </section>
      );
    case 'checklist':
      return (
        <section className={cn('space-y-3', nodeClass(node))}>
          <h3 className="font-display text-lg font-semibold">{node.title}</h3>
          <div className="divide-y divide-[var(--color-border)]">
            {node.items.map((item) => {
              const refKey = item.ref ? briefRefKey(item.ref) : '';
              const checked = context.completedRefs.get(refKey) ?? item.checked;
              return (
                <div
                  key={`${refKey || item.label}:${item.action?.action ?? ''}:${item.detail ?? ''}`}
                  className="flex items-start gap-2.5 py-2.5"
                >
                  <button
                    type="button"
                    aria-label={checked ? `Reopen ${item.label}` : `Complete ${item.label}`}
                    disabled={!item.action}
                    onClick={() =>
                      item.action &&
                      context.onAction(item.action, { ...item.action.payload, completed: !checked }, item.ref)
                    }
                    className="mt-0.5 text-[var(--color-accent)] disabled:text-[var(--color-text-faint)]"
                  >
                    {checked ? <CircleCheck className="size-4" /> : <Circle className="size-4" />}
                  </button>
                  <div className="min-w-0">
                    <p className={cn('text-sm font-medium', checked && 'line-through opacity-60')}>
                      {item.label}
                    </p>
                    {item.detail ? (
                      <p className="text-xs text-[var(--color-text-muted)]">{item.detail}</p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      );
    case 'collection':
      if (!node.items.length) return node.emptyText ? <BriefEmpty text={node.emptyText} /> : null;
      return (
        <section className={cn('space-y-3', nodeClass(node))}>
          {node.title ? <h3 className="font-display text-lg font-semibold">{node.title}</h3> : null}
          <div
            className={cn(
              node.variant === 'shelf' && 'scrollbar-none flex snap-x gap-3 overflow-x-auto pb-2',
              node.variant === 'grid' && 'grid grid-cols-1 gap-3 @[520px]:grid-cols-2',
              node.variant === 'list' && 'divide-y divide-[var(--color-border)]',
            )}
          >
            {node.items.map((item) => (
              <article
                key={`${item.ref ? briefRefKey(item.ref) : item.image || item.title}:${item.meta ?? ''}`}
                className={cn(
                  'min-w-0',
                  node.variant === 'shelf' &&
                    'w-[min(78%,260px)] shrink-0 snap-start overflow-hidden rounded-xl border bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
                  node.variant === 'grid' &&
                    'overflow-hidden rounded-xl border bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
                  node.variant === 'list' && 'flex gap-3 py-3',
                )}
              >
                {item.image ? (
                  // biome-ignore lint/performance/noImgElement: model-authored external media is intentionally unoptimized.
                  <img
                    src={item.image}
                    alt=""
                    loading="lazy"
                    className={cn(
                      'object-cover',
                      node.variant === 'list' ? 'size-14 rounded-lg' : 'aspect-[16/9] w-full',
                    )}
                  />
                ) : node.variant !== 'list' ? (
                  <div className="grid aspect-[16/9] place-items-center bg-[var(--color-bg-muted)]">
                    <ImageIcon className="size-5 text-[var(--color-text-faint)]" />
                  </div>
                ) : null}
                <div className={cn('min-w-0', node.variant === 'list' ? 'flex-1' : 'p-3')}>
                  {item.badge ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent-3)]">
                      {item.badge}
                    </span>
                  ) : null}
                  <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
                  {item.meta ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-muted)]">{item.meta}</p>
                  ) : null}
                  <BriefActions
                    actions={item.actions}
                    sourceRef={item.ref}
                    compact
                    onAction={(action, payload) => context.onAction(action, payload, item.ref)}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      );
    case 'canvas':
      return (
        <BriefCanvasLeaf
          title={node.title}
          html={node.html}
          fallbackText={node.fallbackText || regionSummary}
          height={node.height}
          allowedActions={node.allowedActions}
          onAction={context.onCanvasAction}
        />
      );
  }
}

type EntityRow = {
  ref: BriefSourceRefV2;
  reason?: string;
  lane?: string;
  prep?: string;
  handoff?: BriefEntityHandoffV1;
  actions: BriefActionV2[];
};

function BriefEntityList({
  title,
  items,
  emptyText,
  variant,
  context,
}: {
  title?: string;
  items: EntityRow[];
  emptyText?: string;
  variant: 'rows' | 'cards' | 'compact';
  context: BriefNodeContext;
}) {
  const visible = items.filter((item) => !context.hiddenRefs.has(briefRefKey(item.ref)));
  if (!visible.length) return emptyText ? <BriefEmpty text={emptyText} /> : null;
  return (
    <section className="space-y-2.5">
      {title ? <h3 className="font-display text-lg font-semibold">{title}</h3> : null}
      <div
        className={cn(
          variant === 'cards' && 'grid grid-cols-1 gap-2.5 @[600px]:grid-cols-2',
          variant !== 'cards' && 'divide-y divide-[var(--color-border)]',
        )}
      >
        {visible.map((item) => (
          <BriefEntityRow key={briefRefKey(item.ref)} item={item} variant={variant} context={context} />
        ))}
      </div>
    </section>
  );
}

function BriefEntityRow({
  item,
  variant,
  context,
}: {
  item: EntityRow;
  variant: 'rows' | 'cards' | 'compact';
  context: BriefNodeContext;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const entity = context.entities.get(briefRefKey(item.ref));
  const title = entity?.title || item.ref.label || 'Unavailable item';
  const completed = context.completedRefs.get(briefRefKey(item.ref)) ?? entity?.completed ?? false;
  const gone = entity?.gone === true;
  const detail =
    [item.reason, item.prep, entity?.subtitle].filter(Boolean).join(' · ') ||
    (gone ? 'This item is no longer available.' : entity?.status);

  return (
    <article
      className={cn(
        variant === 'cards'
          ? 'rounded-xl border bg-[var(--color-bg-elevated)] p-3.5 shadow-[var(--shadow-soft)]'
          : variant === 'compact'
            ? 'py-2'
            : 'py-3',
        gone && 'opacity-55',
      )}
    >
      <div className="flex flex-col gap-3 @[520px]:flex-row @[520px]:items-start @[520px]:justify-between">
        <div className="min-w-0 flex-1">
          {item.lane ? (
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent-3)]">
              {item.lane.replaceAll('_', ' ')}
            </span>
          ) : null}
          <p className={cn('truncate text-sm font-medium', (gone || completed) && 'line-through')}>{title}</p>
          {item.handoff && !gone ? (
            <>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text)]">My read: </span>
                {item.handoff.assessment}
              </p>
              <div className="mt-2 rounded-lg bg-[var(--color-bg-muted)] px-3 py-2">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                  {item.handoff.recommendations.length > 1 ? 'Your moves' : 'Your move'}
                </span>
                {item.handoff.recommendations.length > 1 ? (
                  <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm font-medium leading-snug text-[var(--color-text)]">
                    {item.handoff.recommendations.map((move) => (
                      <li key={`${move.label}:${move.ref?.kind ?? ''}:${move.ref?.id ?? ''}`}>
                        {move.label}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-0.5 text-sm font-medium leading-snug text-[var(--color-text)]">
                    {item.handoff.recommendation}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-expanded={whyOpen}
                onClick={() => setWhyOpen((value) => !value)}
                className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              >
                Why this?
                <ChevronDown
                  aria-hidden
                  className={cn('size-3.5 transition-transform', whyOpen && 'rotate-180')}
                />
              </button>
              {whyOpen ? <BriefHandoffTrail handoff={item.handoff} /> : null}
            </>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {detail}
            </p>
          )}
          {entity?.startAt ? (
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {formatBriefTime(entity.startAt)}
            </p>
          ) : null}
        </div>
        {item.actions.length ? (
          <BriefActions
            actions={item.actions}
            sourceRef={item.ref}
            compact
            onAction={(action, payload) =>
              context.onAction(
                action,
                payload,
                item.handoff?.itemCount && item.handoff.itemCount > 1 && item.handoff.handoffId
                  ? {
                      kind: 'derived',
                      id: `${item.handoff.handoffId}:${action.action}`,
                      label: item.handoff.situation,
                    }
                  : item.ref,
              )
            }
          />
        ) : null}
      </div>
    </article>
  );
}

function BriefHandoffTrail({ handoff }: { handoff: BriefEntityHandoffV1 }) {
  return (
    <div className="mt-1.5 space-y-2 border-l border-[var(--color-border-strong)] pl-3 text-xs leading-relaxed">
      <div>
        <span className="font-medium text-[var(--color-text)]">Why now: </span>
        <span className="text-[var(--color-text-muted)]">{handoff.situation}</span>
      </div>
      {handoff.background.length ? (
        <div>
          <span className="font-medium text-[var(--color-text)]">Relevant trail</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[var(--color-text-muted)]">
            {handoff.background.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {handoff.evidence.length ? (
        <div>
          <span className="font-medium text-[var(--color-text)]">Evidence</span>
          <ul className="mt-1 space-y-0.5 text-[var(--color-text-muted)]">
            {handoff.evidence.map((entry, index) => (
              <li key={`${entry.label}:${entry.ref?.kind || ''}:${entry.ref?.id || index}`}>{entry.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function BriefQueryList({
  node,
  context,
}: {
  node: Extract<BriefContentLeaf, { kind: 'query_list' }>;
  context: BriefNodeContext;
}) {
  const query = useBriefQuery(node.query, node.limit);
  if (query.isLoading) return <div className="h-20 animate-pulse rounded-xl bg-[var(--color-bg-muted)]" />;
  const items: EntityRow[] = (query.data?.items ?? []).map((entity) => ({
    ref: { kind: entity.kind, id: entity.id, account: entity.account },
    actions: defaultActionsForEntity(entity),
  }));
  const entities = new Map(context.entities);
  for (const entity of query.data?.items ?? []) entities.set(briefRefKey(entity), entity);
  return (
    <BriefEntityList
      title={node.title}
      items={items}
      emptyText={node.emptyText}
      variant={node.variant}
      context={{ ...context, entities }}
    />
  );
}

function BriefStat({ node }: { node: Extract<BriefContentLeaf, { kind: 'stat' }> }) {
  const query = useBriefQuery(node.queryValue, 48);
  const value = node.queryValue ? (query.data?.count ?? '—') : node.value;
  return (
    <div
      className={cn(
        'rounded-xl border bg-[var(--color-bg-elevated)] p-4 shadow-[var(--shadow-soft)]',
        nodeClass(node),
      )}
    >
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        {node.label}
      </p>
      <div className="mt-2 flex items-baseline gap-2">
        <strong className="font-display text-3xl font-semibold">{value}</strong>
        {node.unit ? <span className="text-sm text-[var(--color-text-muted)]">{node.unit}</span> : null}
      </div>
      {node.delta ? <p className="mt-1 text-xs text-[var(--color-accent-3)]">{node.delta}</p> : null}
    </div>
  );
}

function BriefPrompt({
  node,
  context,
}: {
  node: Extract<BriefContentLeaf, { kind: 'prompt' }>;
  context: BriefNodeContext;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async () => {
    const text = value.trim();
    if (!text) return;
    setPending(true);
    try {
      await context.onAction(
        {
          action: node.variant === 'question' ? 'answer_question' : 'capture_intent',
          label: node.variant === 'question' ? 'Submit answer' : 'Capture',
          payload: {},
          style: 'primary',
        },
        { text, ...(node.questionId ? { questionId: node.questionId } : {}) },
      );
      setValue('');
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="flex items-center gap-2 rounded-xl border bg-[var(--color-surface-well)] p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor={node.id ?? `brief-prompt-${node.questionId ?? 'capture'}`}>
        {node.placeholder}
      </label>
      <input
        id={node.id ?? `brief-prompt-${node.questionId ?? 'capture'}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={node.placeholder}
        className="h-9 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-[var(--color-text-faint)]"
      />
      <Button type="submit" size="sm" disabled={pending || !value.trim()}>
        {node.variant === 'question' ? 'Answer' : 'Capture'}
      </Button>
    </form>
  );
}

function useBriefQuery(query: BriefQuery | undefined, limit: number) {
  return useQuery({
    queryKey: query
      ? briefQueryKeys.query(query.name, query.areaId, limit)
      : ['brief-v2', 'query', 'disabled'],
    enabled: Boolean(query),
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch('/api/mobile/briefs/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || 'Brief query failed.');
      return body as { items: BriefHydratedEntity[]; count: number };
    },
  });
}

function defaultActionsForEntity(entity: BriefHydratedEntity): BriefActionV2[] {
  if (entity.kind === 'task' || entity.kind === 'card') {
    return [
      {
        action: 'toggle_task',
        label: entity.completed ? 'Reopen' : 'Complete',
        payload: { completed: !entity.completed },
        style: 'quiet',
      },
    ];
  }
  if (entity.kind === 'thread') {
    return [{ action: 'open_thread', label: 'Open', payload: {}, style: 'quiet' }];
  }
  if (entity.kind === 'event') {
    return [{ action: 'open_event', label: 'Open', payload: {}, style: 'quiet' }];
  }
  if (entity.kind === 'work') {
    return [{ action: 'open_work', label: 'Open', payload: {}, style: 'quiet' }];
  }
  return [];
}

function BriefEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-5 text-center text-sm text-[var(--color-text-muted)]">
      {text}
    </div>
  );
}

/* Depth ladder mapping (well < paper < card < float, see globals.css):
 * elevated blocks sit on the card rung; heroes climb to float so the lead
 * story visibly leaves the paper. */
function surfaceClass(surface: 'plain' | 'elevated' | 'glass') {
  if (surface === 'elevated')
    return 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]';
  if (surface === 'glass')
    return 'border-white/20 bg-[var(--color-bg-elevated)]/75 shadow-[var(--shadow-soft)] backdrop-blur-xl';
  return 'border-[var(--color-border)] bg-transparent';
}

function heroSurfaceClass(surface: 'plain' | 'elevated' | 'glass') {
  if (surface === 'elevated')
    return 'border-[var(--color-border)] bg-[var(--color-surface-float)] shadow-[var(--shadow-soft)]';
  if (surface === 'glass')
    return 'border-white/20 bg-[var(--color-surface-float)]/80 shadow-[var(--shadow-soft)] backdrop-blur-xl';
  return 'border-[var(--color-border)] bg-transparent';
}

function nodeClass(node: { emphasis: string; tone: string }) {
  return cn(
    node.emphasis === 'primary' && 'brief-emphasis-primary',
    node.emphasis === 'muted' && 'opacity-75',
    node.tone === 'warning' && 'border-amber-500/30',
    node.tone === 'urgent' && 'border-destructive/35',
    node.tone === 'positive' && 'border-emerald-500/30',
  );
}

function formatBriefTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
