'use client';

// To, Cc, and Bcc with chips and people search. Research: Superhuman's
// compact list under the field with the matched letters in bold
// (mobbin.com/screens/dbdfb907-cdd7-4082-aa11-504dfee55ba8), Notion Mail's
// quiet name chips (mobbin.com/screens/cde16684-ed81-44c7-b66a-985b435b23ff),
// and the Threads suggestion list with initials and a second line
// (mobbin.com/screens/cf78b839-3af2-47f8-9bac-ec008fdd53a8). The field keeps
// the composer contract: one header string, "Name <a@b.io>, c@d.io".

import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import {
  addChips,
  formatRecipients,
  highlightParts,
  isCompleteAddress,
  parseRecipientText,
  type RecipientChip,
} from '@/lib/contacts/address-field';
import type { Highlight, RecipientSuggestion } from '@/lib/contacts/recipients';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 80;
const PICK_WAIT_MS = 700;

async function fetchRecipients(
  query: string,
  fromAccount: string | undefined,
  exclude: string[],
  signal?: AbortSignal,
): Promise<RecipientSuggestion[]> {
  const params = new URLSearchParams({ q: query, limit: '8' });
  if (fromAccount) params.set('from', fromAccount);
  for (const email of exclude.slice(0, 50)) params.append('exclude', email);
  const response = await fetch(`/api/contacts/recipients?${params.toString()}`, { signal });
  if (!response.ok) return [];
  const body = (await response.json().catch(() => null)) as { items?: RecipientSuggestion[] } | null;
  return body?.items ?? [];
}

function Highlighted({ text, ranges }: { text: string; ranges: Highlight[] }) {
  return (
    <>
      {highlightParts(text, ranges).map((part, index) =>
        part.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder.
          <span key={index} className="font-semibold text-[var(--color-text)]">
            {part.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder.
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function RecipientInput({
  label,
  value,
  onChange,
  fromAccount,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  // The selected From mailbox; people seen on it rank higher.
  fromAccount?: string;
  placeholder?: string;
}) {
  const id = useId();
  const listId = `${id}-people`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [chips, setChips] = useState<RecipientChip[]>(() => parseRecipientText(value));
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Enter with nothing typed picks a row only after the arrow keys moved to it.
  const [navigated, setNavigated] = useState(false);
  const [query, setQuery] = useState('');
  const lastEmitted = useRef(value);
  // Enter or Tab before the rows for the typed text arrive waits for them. The
  // wait belongs to the text that started it; any other change cancels it.
  const awaitingPick = useRef<{ timer: ReturnType<typeof setTimeout>; draft: string } | null>(null);
  const stopAwaiting = () => {
    if (awaitingPick.current) clearTimeout(awaitingPick.current.timer);
    awaitingPick.current = null;
  };

  // A new value from outside (a prefill, a reset after send) replaces the chips.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the value change is the trigger.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    stopAwaiting();
    lastEmitted.current = value;
    setChips(parseRecipientText(value));
    setDraft('');
  }, [value]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft change is the trigger.
  useEffect(() => {
    if (awaitingPick.current && awaitingPick.current.draft !== draft.trim()) stopAwaiting();
    const timer = setTimeout(() => setQuery(draft.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const exclude = useMemo(() => chips.filter((chip) => chip.valid).map((chip) => chip.email), [chips]);
  const people = useQuery({
    queryKey: ['recipients', query, fromAccount || '', exclude.join(',')],
    queryFn: ({ signal }) => fetchRecipients(query, fromAccount, exclude, signal),
    enabled: focused && open,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  const items = open ? people.data || [] : [];
  // The list shows the previous query's rows while a new one loads. Only rows
  // for the text now in the field may be picked by Enter or Tab.
  const fresh = people.isSuccess && !people.isPlaceholderData && query === draft.trim();

  // A new query starts at the first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query change is the trigger.
  useEffect(() => {
    setActive(0);
    setNavigated(false);
  }, [query]);

  const emit = (nextChips: RecipientChip[], nextDraft: string) => {
    const out = formatRecipients(nextChips, nextDraft);
    lastEmitted.current = out;
    onChange(out);
  };

  const commitDraft = (text = draft) => {
    const added = parseRecipientText(text);
    if (!added.length) return false;
    const next = addChips(chips, added);
    setChips(next);
    setDraft('');
    emit(next, '');
    return true;
  };

  const pick = (item: RecipientSuggestion) => {
    stopAwaiting();
    const next = addChips(chips, [{ email: item.email, name: item.name, valid: true }]);
    setChips(next);
    setDraft('');
    setQuery('');
    emit(next, '');
    inputRef.current?.focus();
  };

  // The timer runs after later renders, so it calls the newest commitDraft.
  const commitLatest = useRef(commitDraft);
  commitLatest.current = commitDraft;

  const pickWhenFresh = () => {
    stopAwaiting();
    // After 0.7 s with no rows, the typed text becomes a chip as it is.
    const timer = setTimeout(() => {
      awaitingPick.current = null;
      commitLatest.current();
    }, PICK_WAIT_MS);
    awaitingPick.current = { timer, draft: draft.trim() };
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh rows are the trigger.
  useEffect(() => {
    if (!awaitingPick.current || !fresh) return;
    stopAwaiting();
    if (items.length) pick(items[0]);
    else commitDraft();
  }, [fresh, items]);

  // A wait still open when the field unmounts must not commit later.
  useEffect(
    () => () => {
      if (awaitingPick.current) clearTimeout(awaitingPick.current.timer);
    },
    [],
  );

  const remove = (index: number) => {
    const next = chips.filter((_, position) => position !== index);
    setChips(next);
    emit(next, draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const hasItems = open && items.length > 0;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      if (hasItems && navigated) setActive((index) => Math.min(index + 1, items.length - 1));
      setNavigated(true);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (hasItems) setActive((index) => Math.max(index - 1, 0));
      setNavigated(true);
      return;
    }
    // A row the arrow keys moved to is a choice the user can see. Without
    // one, Enter and Tab pick only rows for the text now in the field.
    // A complete address typed in full is the user's choice: it commits as
    // typed unless the arrow keys moved to a row.
    const typedAddress = !navigated && isCompleteAddress(draft);
    const choice = hasItems && !typedAddress && (navigated || (draft.trim() && fresh));
    const waits = open && !fresh && Boolean(draft.trim()) && !isCompleteAddress(draft);
    if (event.key === 'Enter') {
      if (choice) {
        event.preventDefault();
        pick(items[Math.min(active, items.length - 1)]);
        return;
      }
      if (draft.trim()) {
        event.preventDefault();
        if (waits) pickWhenFresh();
        else commitDraft();
      }
      return;
    }
    if (event.key === 'Tab' && draft.trim()) {
      if (choice) {
        event.preventDefault();
        pick(items[Math.min(active, items.length - 1)]);
      } else if (waits) {
        event.preventDefault();
        pickWhenFresh();
      } else {
        commitDraft();
      }
      return;
    }
    if ((event.key === ',' || event.key === ';') && draft.trim()) {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === ' ' && isCompleteAddress(draft)) {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === 'Backspace' && !draft && chips.length) {
      event.preventDefault();
      remove(chips.length - 1);
      return;
    }
    if (event.key === 'Escape' && open) {
      // Close the list only; the composer stays open.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[,;\n<]/.test(text) && !isCompleteAddress(text)) return;
    event.preventDefault();
    commitDraft(`${draft} ${text}`.trim());
  };

  const activeId = items.length ? `${listId}-${Math.min(active, items.length - 1)}` : undefined;

  return (
    <div className="relative grid grid-cols-[60px_1fr] items-start gap-2 border-b border-[var(--color-border)] px-4 py-1.5 last:border-b-0">
      <label htmlFor={id} className="pt-1.5 text-[11px] text-[var(--color-text-faint)]">
        {label}
      </label>
      <div className="flex min-h-7 flex-wrap items-center gap-1">
        {chips.map((chip, index) => {
          const shown = chip.valid ? chip.name || chip.email : chip.raw || '';
          const detail = chip.valid
            ? chip.name
              ? `${chip.name} <${chip.email}>`
              : chip.email
            : 'This address is not valid.';
          return (
            <span
              key={chip.valid ? chip.email : `typed:${chip.raw}`}
              title={detail}
              className={cn(
                'inline-flex h-6 max-w-[240px] items-center gap-1 rounded-md border px-1.5 text-[12.5px]',
                chip.valid
                  ? 'border-[var(--color-control-border)] bg-[var(--color-control)] text-[var(--color-text)]'
                  : 'border-[var(--color-danger)] text-[var(--color-danger)]',
              )}
            >
              <span className="truncate">{shown}</span>
              <button
                type="button"
                aria-label={`Remove ${shown}`}
                onClick={(event) => {
                  event.stopPropagation();
                  remove(index);
                }}
                className="grid size-4 shrink-0 place-items-center rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={id}
          value={draft}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setOpen(true);
            emit(chips, event.target.value);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => {
            stopAwaiting();
            setFocused(false);
            setOpen(false);
            if (draft.trim()) commitDraft();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={chips.length ? undefined : placeholder}
          className="h-7 min-w-[120px] flex-1 bg-[var(--color-transparent)] text-[13px] outline-none placeholder:text-[var(--color-text-faint)]"
        />
      </div>
      {items.length ? (
        <div
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute top-full left-[76px] z-50 mt-1 w-[min(420px,calc(100%-92px))] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-1 shadow-[var(--shadow-soft)]"
        >
          {items.map((item, index) => {
            const nameRanges = item.highlights.filter((entry) => entry.field === 'name');
            const emailRanges = item.highlights.filter((entry) => entry.field === 'email');
            return (
              <div
                key={item.email}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                // Keep focus in the input so the pick does not blur the field.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(item)}
                onKeyDown={() => undefined}
                className={cn(
                  'flex cursor-default items-center gap-2.5 px-2.5 py-1.5',
                  index === active && 'bg-[var(--color-control-hover)]',
                )}
              >
                <Avatar name={item.name || item.email} src={item.photoUrl} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-[var(--color-text)]">
                    {item.name ? (
                      <Highlighted text={item.name} ranges={nameRanges} />
                    ) : (
                      <Highlighted text={item.email} ranges={emailRanges} />
                    )}
                  </div>
                  {item.name ? (
                    <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">
                      <Highlighted text={item.email} ranges={emailRanges} />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
