import { ChevronDown } from 'lucide-react';
import Image from 'next/image';
import { formatUpdateDate, type ProductUpdate, shouldSummarizeUpdate } from '@/lib/updates/model';
import { UpdatePreview } from './UpdatePreview';

const KIND_LABELS = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

function UpdateFigure({
  preview,
  title,
  latest = false,
}: {
  preview: NonNullable<ProductUpdate['preview']>;
  title: string;
  latest?: boolean;
}) {
  return (
    <figure className="my-5 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
      {'html' in preview ? (
        <UpdatePreview html={preview.html} title={title} interactive={preview.interactive} />
      ) : (
        <Image
          src={preview.image}
          alt={preview.alt}
          width={preview.width}
          height={preview.height}
          sizes="(max-width: 672px) 100vw, 608px"
          loading={latest ? 'eager' : 'lazy'}
          unoptimized
          className="h-auto w-full"
        />
      )}
      <figcaption className="border-t border-[var(--color-border)] px-4 py-3 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
        {preview.caption}
      </figcaption>
    </figure>
  );
}

function ChangeList({ changes }: Pick<ProductUpdate, 'changes'>) {
  return (
    <ul className="space-y-4">
      {changes.map((change) => (
        <li key={change.id} className="flex items-start gap-3">
          <span className="mt-0.5 min-w-16 rounded-md bg-[var(--color-bg-subtle)] px-2 py-1 text-center text-[10px] font-medium text-[var(--color-text-muted)]">
            {KIND_LABELS[change.kind]}
          </span>
          <div className="min-w-0">
            <h3 className="text-[13px] font-medium">{change.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              {change.description}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function UpdateEntry({ update, latest = false }: { update: ProductUpdate; latest?: boolean }) {
  const summarized = shouldSummarizeUpdate(update);
  return (
    <article
      id={update.id}
      aria-labelledby={`${update.id}-title`}
      className="scroll-mt-8 border-t border-[var(--color-border)] py-7 first:border-t-0 first:pt-0"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <time dateTime={update.publishedAt}>{formatUpdateDate(update.publishedAt)}</time>
        {update.version ? <span>· v{update.version}</span> : null}
        {latest ? (
          <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 font-medium text-[var(--color-accent)]">
            Latest
          </span>
        ) : null}
        <span className="ml-auto">
          {update.changes.length} {update.changes.length === 1 ? 'change' : 'changes'}
        </span>
      </div>
      <h2 id={`${update.id}-title`} className="font-display text-[24px] leading-tight tracking-tight">
        {update.title}
      </h2>
      {update.summary ? (
        <section aria-label={`${update.title} summary`} data-slot="update-summary">
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            {update.summary.text}
          </p>
          <UpdateFigure
            preview={{ ...update.summary.demo, interactive: true }}
            title={`${update.title} summary demo`}
          />
        </section>
      ) : null}
      {!summarized && update.preview ? (
        <UpdateFigure preview={update.preview} title={update.title} latest={latest} />
      ) : null}
      {summarized ? (
        <details className="group mt-5">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 text-[12.5px] font-medium text-[var(--color-accent)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
            <span className="group-open:hidden">See all {update.changes.length} changes</span>
            <span className="hidden group-open:inline">Hide changes</span>
          </summary>
          <div className="pt-4">
            {update.preview ? <UpdateFigure preview={update.preview} title={update.title} /> : null}
            <ChangeList changes={update.changes} />
          </div>
        </details>
      ) : (
        <div className="mt-5">
          <ChangeList changes={update.changes} />
        </div>
      )}
    </article>
  );
}

export function UpdateFeed({ updates }: { updates: readonly ProductUpdate[] }) {
  if (!updates.length) {
    return <p className="text-[13px] text-[var(--color-text-muted)]">New updates will appear here.</p>;
  }
  return (
    <div>
      {updates.map((update, index) => (
        <UpdateEntry key={update.id} update={update} latest={index === 0} />
      ))}
    </div>
  );
}
