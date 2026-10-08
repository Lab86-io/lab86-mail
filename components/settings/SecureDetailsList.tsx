'use client';

// Settings, Passwords and IDs: the list and the expanded item, with every
// state in props so the dev harness and the tests render it without a
// server (docs/albatross-secure-store.md, V1 to V4, V8). Three groups in a
// fixed order; a row opens in place to its fields (each with "Replace"), its
// sites (add with the identity check, remove without), its recent uses, and
// "Rename" and "Delete". No value appears anywhere here.

import { Fragment, type ReactNode, useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  deleteDialogCopy,
  SECURE_COPY,
  secureCountLine,
  secureFieldRows,
  secureGroups,
  secureItemHint,
  secureItemLine,
  secureUseLine,
  secureUseTimeLine,
  secureUseTone,
} from '@/lib/albatross/secure-view';
import {
  SECURE_FIELD_LABELS,
  type SecureItemKind,
  type SecureItemView,
  type SecureUseView,
} from '@/lib/secure/contract';
import { cn } from '@/lib/utils';
import { MANAGER_IGNORE_ATTRIBUTES, MaskedInput } from './MaskedInput';
import { SectionHeading, SettingsCard, SettingsGroupTitle, SettingsNote, SettingsRow } from './primitives';

export type SecureUsesState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; uses: SecureUseView[] };

export type SecureItemAction = 'replace' | 'rename' | 'remove_site' | 'add_site' | 'delete';

export interface SecureItemNote {
  text: string;
  tone: 'quiet' | 'danger';
}

export interface SecureDetailsListProps {
  items: readonly SecureItemView[];
  loading?: boolean;
  loadError?: string | null;
  now?: number;
  timeZone?: string;
  /** The open row. */
  openId: string | null;
  onToggle: (id: string | null) => void;
  /** The use history of each opened row. */
  uses: Record<string, SecureUsesState | undefined>;
  busy: { id: string; action: SecureItemAction } | null;
  /** A line under the item's controls: an error, or the cancelled check. */
  notes?: Record<string, SecureItemNote | undefined>;
  onReplace: (item: SecureItemView, field: string, value: string) => Promise<boolean>;
  onRename: (item: SecureItemView, label: string) => Promise<boolean>;
  onRemoveSite: (item: SecureItemView, site: string) => void;
  onAddSite: (item: SecureItemView, raw: string) => Promise<boolean>;
  onDelete: (item: SecureItemView) => void;
  onAdd: (kind: SecureItemKind) => void;
  /** The "In the shared browser" group, after the list. */
  browser?: ReactNode;
}

/** Bullets read as "saved", not as eight bullets. */
function MaskedText({ text }: { text: string }) {
  const parts = text.split(/(•{4,})/);
  return (
    <>
      {parts.map((part, index) =>
        /^•{4,}$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional.
          <Fragment key={index}>
            <span aria-hidden className="tracking-[0.08em]">
              {part}
            </span>
            <span className="sr-only">{SECURE_COPY.saved.toLowerCase()}</span>
          </Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional.
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function SecureDetailsList(props: SecureDetailsListProps) {
  const { items, loading, loadError, now = Date.now(), timeZone, openId, onToggle, onAdd, browser } = props;
  const groups = secureGroups(items);
  const hasDateOfBirth = items.some((item) => item.kind === 'date_of_birth');
  return (
    <section data-slot="secure-details">
      <SectionHeading
        title={SECURE_COPY.title}
        blurb={SECURE_COPY.blurb}
        aside={loading ? undefined : secureCountLine(items)}
      />
      {loading ? (
        <p className="px-4 py-3 text-[12.5px] text-[var(--color-text-muted)]">{SECURE_COPY.loading}</p>
      ) : loadError ? (
        <p className="px-4 py-3 text-[12.5px] text-[var(--color-danger)]">{loadError}</p>
      ) : null}
      {groups.map((group) => (
        <Fragment key={group.kind}>
          <SettingsGroupTitle>{group.title}</SettingsGroupTitle>
          <SettingsCard>
            {group.items.map((item) => (
              <SecureItemRow
                key={item.id}
                item={item}
                open={openId === item.id}
                now={now}
                timeZone={timeZone}
                onToggle={() => onToggle(openId === item.id ? null : item.id)}
                detail={props}
              />
            ))}
            {group.kind === 'id_number' ? (
              group.dateOfBirth ? (
                <SecureItemRow
                  item={group.dateOfBirth}
                  open={openId === group.dateOfBirth.id}
                  now={now}
                  timeZone={timeZone}
                  onToggle={() =>
                    onToggle(openId === group.dateOfBirth?.id ? null : (group.dateOfBirth?.id ?? null))
                  }
                  detail={props}
                />
              ) : (
                <SettingsRow
                  label={SECURE_COPY.dateOfBirth}
                  description={<span className="text-[var(--color-text-faint)]">{SECURE_COPY.notSaved}</span>}
                  control={
                    <Button type="button" size="xs" variant="outline" onClick={() => onAdd('date_of_birth')}>
                      {SECURE_COPY.add}
                    </Button>
                  }
                />
              )
            ) : null}
          </SettingsCard>
        </Fragment>
      ))}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline">
              {SECURE_COPY.add}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            {(['sign_in', 'id_number', 'date_of_birth', 'api_key'] as const)
              .filter((kind) => kind !== 'date_of_birth' || !hasDateOfBirth)
              .map((kind) => (
                <DropdownMenuItem key={kind} className="text-[12.5px]" onSelect={() => onAdd(kind)}>
                  {SECURE_COPY.addMenu[kind]}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-[12px] text-[var(--color-text-muted)]">{SECURE_COPY.addHint}</span>
      </div>
      <SettingsNote>{SECURE_COPY.note}</SettingsNote>
      {browser}
    </section>
  );
}

function SecureItemRow({
  item,
  open,
  now,
  timeZone,
  onToggle,
  detail,
}: {
  item: SecureItemView;
  open: boolean;
  now: number;
  timeZone?: string;
  onToggle: () => void;
  detail: SecureDetailsListProps;
}) {
  const id = useId();
  const line = secureItemLine(item);
  const hint = secureItemHint(item, now, { timeZone });
  return (
    <div
      data-slot="secure-item"
      data-open={open ? '' : undefined}
      className={cn(open && 'bg-[var(--color-bg)]')}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-6 px-4 py-3 text-left transition-colors hover:bg-[var(--color-hover-soft)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{item.label}</span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
            <MaskedText text={line} />
          </span>
          <span className="mt-1 block text-[11px] text-[var(--color-text-faint)]">{hint}</span>
        </span>
        <span
          aria-hidden
          className={cn(
            'inline-block size-[7px] shrink-0 border-r border-b border-[var(--color-text-faint)] transition-transform',
            open ? 'rotate-45 -translate-y-px' : 'rotate-[-45deg] translate-y-px',
          )}
        />
      </button>
      {open ? (
        <div id={`${id}-detail`} className="px-4 pt-1 pb-4">
          <SecureItemDetail item={item} now={now} timeZone={timeZone} {...detail} />
        </div>
      ) : null}
    </div>
  );
}

function SecureItemDetail({
  item,
  now,
  timeZone,
  uses,
  busy,
  notes,
  onReplace,
  onRename,
  onRemoveSite,
  onAddSite,
  onDelete,
}: SecureDetailsListProps & { item: SecureItemView; now: number }) {
  const id = useId();
  const [replacing, setReplacing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(item.label);
  const [site, setSite] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const own = busy?.id === item.id ? busy.action : null;
  const note = notes?.[item.id];
  const history = uses[item.id];
  const fixedSite = item.kind === 'sign_in' || item.kind === 'api_key';
  const copy = deleteDialogCopy(item);
  const fields = secureFieldRows(item);

  const replaceEditor = (field: string) => {
    const dateField = field === 'expires' || field === 'date';
    const plain = field === 'name_on_id' || field === 'username';
    const fieldInputId = `${id}-replace-${field}`;
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim() || own) return;
          void onReplace(item, field, draft.trim()).then((ok) => {
            if (ok) {
              setReplacing(null);
              setDraft('');
            }
          });
        }}
      >
        {dateField ? (
          <Input
            id={fieldInputId}
            type="date"
            value={draft}
            autoFocus
            aria-label={SECURE_FIELD_LABELS[field] ?? field}
            disabled={own === 'replace'}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 max-w-[200px] text-[12.5px]"
          />
        ) : plain ? (
          <Input
            id={fieldInputId}
            value={draft}
            autoFocus
            autoComplete="off"
            aria-label={SECURE_FIELD_LABELS[field] ?? field}
            disabled={own === 'replace'}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-60 text-[12.5px]"
            {...MANAGER_IGNORE_ATTRIBUTES}
          />
        ) : (
          <MaskedInput
            id={fieldInputId}
            value={draft}
            autoFocus
            disabled={own === 'replace'}
            onChange={setDraft}
            className="w-60"
          />
        )}
        <Button type="submit" size="xs" disabled={own === 'replace' || !draft.trim()}>
          {own === 'replace' ? SECURE_COPY.saving : SECURE_COPY.save}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={own === 'replace'}
          onClick={() => {
            setReplacing(null);
            setDraft('');
          }}
        >
          {SECURE_COPY.cancel}
        </Button>
      </form>
    );
  };

  return (
    <div data-slot="secure-item-detail" className="flex flex-col gap-4">
      <div>
        {fields.map((row) => (
          <div
            key={row.field}
            className="grid grid-cols-[136px_1fr_auto] items-baseline gap-x-4 border-t border-[var(--color-list-divider)] py-1.5 last:border-b"
          >
            <span className="text-[12px] text-[var(--color-text-muted)]">{row.label}</span>
            {replacing === row.field ? (
              <div className="col-span-2">{replaceEditor(row.field)}</div>
            ) : (
              <>
                <span className="text-[12.5px]">
                  <MaskedText text={row.hint} />
                </span>
                <button
                  type="button"
                  className="text-[11.5px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50"
                  disabled={Boolean(own)}
                  onClick={() => {
                    setReplacing(row.field);
                    setDraft('');
                  }}
                >
                  {SECURE_COPY.replace}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div>
        <p className="mb-1 text-[11.5px] font-medium text-[var(--color-text-muted)]">
          {SECURE_COPY.sitesTitle}
        </p>
        {item.sites.length ? (
          item.sites.map((entry) => (
            <div
              key={entry}
              className="grid grid-cols-[136px_1fr_auto] items-baseline gap-x-4 border-t border-[var(--color-list-divider)] py-1.5"
            >
              <span className="text-[12px]">{entry}</span>
              <span className="text-[12.5px] text-[var(--color-text-muted)]">{SECURE_COPY.always}</span>
              {fixedSite && item.sites.length === 1 ? (
                <span />
              ) : (
                <button
                  type="button"
                  className="text-[11.5px] font-medium text-[var(--color-text-muted)] hover:underline disabled:opacity-50"
                  disabled={Boolean(own)}
                  onClick={() => onRemoveSite(item, entry)}
                >
                  {own === 'remove_site' ? SECURE_COPY.saving : SECURE_COPY.remove}
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="border-t border-[var(--color-list-divider)] py-1.5 text-[12px] text-[var(--color-text-faint)]">
            {SECURE_COPY.noSites}
          </p>
        )}
        <form
          className="flex flex-wrap items-center gap-2 border-t border-b border-[var(--color-list-divider)] py-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!site.trim() || own) return;
            void onAddSite(item, site.trim()).then((ok) => {
              if (ok) setSite('');
            });
          }}
        >
          <Input
            value={site}
            inputMode="url"
            autoComplete="off"
            aria-label={SECURE_COPY.sitesTitle}
            placeholder={SECURE_COPY.addSitePlaceholder}
            disabled={own === 'add_site'}
            onChange={(event) => setSite(event.target.value)}
            className="h-7 w-60 text-[12px]"
          />
          <Button type="submit" size="xs" variant="outline" disabled={own === 'add_site' || !site.trim()}>
            {own === 'add_site' ? SECURE_COPY.checking : SECURE_COPY.addSite}
          </Button>
          <span
            aria-live="polite"
            className={cn(
              'text-[11px]',
              note?.tone === 'danger'
                ? 'text-[var(--color-danger)]'
                : note
                  ? 'text-[var(--color-text-muted)]'
                  : 'text-[var(--color-text-faint)]',
            )}
          >
            {note?.text ?? SECURE_COPY.addSiteHint}
          </span>
        </form>
      </div>

      <div>
        <p className="mb-1 text-[11.5px] font-medium text-[var(--color-text-muted)]">
          {SECURE_COPY.usesTitle}
        </p>
        {!history || history.status === 'loading' ? (
          <p className="border-t border-[var(--color-list-divider)] py-1.5 text-[12px] text-[var(--color-text-faint)]">
            {SECURE_COPY.usesLoading}
          </p>
        ) : history.status === 'error' ? (
          <p className="border-t border-[var(--color-list-divider)] py-1.5 text-[12px] text-[var(--color-danger)]">
            {SECURE_COPY.usesError}
          </p>
        ) : history.uses.length ? (
          <>
            {history.uses.slice(0, 10).map((use) => {
              const tone = secureUseTone(use.outcome);
              return (
                <div
                  key={use.id}
                  className="grid grid-cols-[124px_minmax(0,160px)_1fr_auto] items-baseline gap-x-4 border-t border-[var(--color-list-divider)] py-1.5 text-[12px] last:border-b"
                >
                  <span className="tabular-nums text-[var(--color-text-muted)]">
                    {secureUseTimeLine(use.at, now, { timeZone })}
                  </span>
                  <span className="truncate text-[var(--color-text-muted)]">{use.site ?? '—'}</span>
                  <span className="truncate">{use.workTitle ?? '—'}</span>
                  <span
                    className={cn(
                      tone === 'did' && 'font-medium text-[var(--color-accent-3)]',
                      tone === 'warn' && 'font-medium text-[var(--color-warning)]',
                      tone === 'quiet' && 'text-[var(--color-text-muted)]',
                    )}
                  >
                    {secureUseLine(use, item.kind)}
                  </span>
                </div>
              );
            })}
            <p className="mt-1.5 text-[11px] text-[var(--color-text-faint)]">{SECURE_COPY.usesKept}</p>
          </>
        ) : (
          <p className="border-t border-b border-[var(--color-list-divider)] py-1.5 text-[12px] text-[var(--color-text-faint)]">
            {SECURE_COPY.usesEmpty}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {renaming ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!label.trim() || own) return;
              void onRename(item, label.trim()).then((ok) => {
                if (ok) setRenaming(false);
              });
            }}
          >
            <Input
              value={label}
              autoFocus
              autoComplete="off"
              aria-label={SECURE_COPY.rename}
              disabled={own === 'rename'}
              onChange={(event) => setLabel(event.target.value)}
              className="h-7 w-52 text-[12px]"
            />
            <Button type="submit" size="xs" disabled={own === 'rename' || !label.trim()}>
              {own === 'rename' ? SECURE_COPY.saving : SECURE_COPY.save}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={own === 'rename'}
              onClick={() => {
                setRenaming(false);
                setLabel(item.label);
              }}
            >
              {SECURE_COPY.cancel}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="text-[11.5px] font-medium text-[var(--color-text-muted)] hover:underline disabled:opacity-50"
            disabled={Boolean(own)}
            onClick={() => setRenaming(true)}
          >
            {SECURE_COPY.rename}
          </button>
        )}
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <button
            type="button"
            className="text-[11.5px] font-medium text-[var(--color-danger)] hover:underline disabled:opacity-50"
            disabled={Boolean(own)}
            onClick={() => setConfirmDelete(true)}
          >
            {own === 'delete' ? SECURE_COPY.saving : SECURE_COPY.delete}
          </button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{SECURE_COPY.cancel}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-[var(--color-danger)] text-[var(--color-danger-foreground)] hover:bg-[var(--color-danger)]/90"
                onClick={() => onDelete(item)}
              >
                {SECURE_COPY.delete}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
