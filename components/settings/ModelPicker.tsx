'use client';

// The model picker for the AI section: one trigger per slot (Normal, Fast), a
// command-palette popover grouped by vendor. Research (Mobbin): Relevance AI's
// model chooser (mobbin.com/screens/94a61b0c-d8b5-4254-8147-426391e60452) puts
// name and vendor left, context and cost right, with a detail panel for the
// highlighted row; Langdock's model catalog
// (mobbin.com/screens/4513a553-1cfa-4f66-949e-a7047ba11af3) groups by vendor.
// Vercel's AI Gateway table (mobbin.com/screens/43b56b19-c2f2-4adf-acdc-445c98112c87)
// carries context and price as muted columns. The same shape here, in one
// popover, so the section stays a form and not a catalog page.

import { Check, ChevronDown, Eye } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { ProviderGlyph } from '@/components/settings/ProviderGlyph';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  type CatalogModel,
  type CatalogProvider,
  type CatalogSlot,
  findCatalogModel,
  formatContextTokens,
  formatPricing,
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  providerForModelId,
  TIER_LABELS,
} from '@/lib/ai/model-catalog';
import { cn } from '@/lib/utils';

export type ModelPickerProps = {
  slot: CatalogSlot;
  value: string;
  onChange: (id: string) => void;
  catalog: CatalogModel[];
  disabled?: boolean;
  /** Id for the trigger, so a Label can point at it. */
  id?: string;
  /** Test hook: start with the popover open. */
  defaultOpen?: boolean;
};

const FAST_TIERS = new Set(['fast', 'nano']);

type Group = { provider: CatalogProvider; label: string; models: CatalogModel[] };

/** Rows the list may show for a slot: no retired or unavailable models. */
export function pickerRows(
  catalog: CatalogModel[],
  input: { slot: CatalogSlot; value: string; showOlder: boolean; showAllTiers: boolean },
): CatalogModel[] {
  const selected = findCatalogModel(catalog, input.value);
  return catalog.filter((model) => {
    if (!model.capabilities.vision) return false;
    if (model === selected) return model.status !== 'deprecated' && model.status !== 'unavailable';
    if (model.status === 'deprecated' || model.status === 'unavailable') return false;
    if (model.status === 'legacy' && !input.showOlder) return false;
    if (input.slot === 'fast' && !input.showAllTiers && !FAST_TIERS.has(model.tier)) return false;
    return true;
  });
}

/** Case-insensitive match on id, name, vendor, tier, or note. */
export function matchesQuery(model: CatalogModel, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [model.id, model.name, model.providerLabel, TIER_LABELS[model.tier], model.note]
    .join(' ')
    .toLowerCase();
  return needle.split(/\s+/).every((token) => haystack.includes(token));
}

export function groupRows(rows: CatalogModel[]): Group[] {
  const groups = new Map<CatalogProvider, CatalogModel[]>();
  for (const model of rows) {
    const list = groups.get(model.provider) || [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return PROVIDER_ORDER.filter((provider) => groups.has(provider)).map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider],
    models: groups.get(provider)!,
  }));
}

function Chip({ children, tone = 'muted' }: { children: string; tone?: 'muted' | 'tier' | 'warn' }) {
  return (
    <span
      className={cn(
        'inline-flex h-[17px] shrink-0 items-center rounded-ui border px-1.5 text-[10.5px] leading-none whitespace-nowrap',
        tone === 'tier' &&
          'border-[var(--color-border)] bg-[var(--color-bg-muted)] text-[var(--color-text)] font-medium',
        tone === 'muted' && 'border-[var(--color-border)] text-[var(--color-text-muted)]',
        tone === 'warn' && 'border-[var(--color-danger)] text-[var(--color-danger)]',
      )}
    >
      {children}
    </span>
  );
}

function capabilityChips(model: CatalogModel) {
  const chips: string[] = [];
  if (model.capabilities.reasoning) chips.push('Reasoning');
  if (model.capabilities.tools) chips.push('Tools');
  if (model.capabilities.vision) chips.push('Vision');
  if (model.capabilities.pdf) chips.push('PDF');
  return chips;
}

function RightMeta({ model }: { model: CatalogModel }) {
  const context = formatContextTokens(model.contextTokens);
  const price = formatPricing(model.pricing);
  if (!context && !price) return null;
  return (
    <span className="ml-auto shrink-0 pl-3 text-right hidden sm:inline text-[11px] tabular-nums text-[var(--color-text-muted)]">
      {context ? <span>{context}</span> : null}
      {context && price ? <span className="px-1 text-[var(--color-text-faint)]">·</span> : null}
      {price ? <span title="USD per million tokens, input / output">{price}</span> : null}
    </span>
  );
}

export function ModelPicker({
  slot,
  value,
  onChange,
  catalog,
  disabled = false,
  id,
  defaultOpen = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [showOlder, setShowOlder] = useState(false);
  const [showAllTiers, setShowAllTiers] = useState(slot === 'normal');
  const [highlighted, setHighlighted] = useState('');
  const [providerFilter, setProviderFilter] = useState<CatalogProvider | null>(null);
  const noteId = useId();

  const selected = findCatalogModel(catalog, value);
  const rows = useMemo(
    () => pickerRows(catalog, { slot, value, showOlder, showAllTiers }),
    [catalog, slot, value, showOlder, showAllTiers],
  );
  const visible = useMemo(() => rows.filter((model) => matchesQuery(model, query)), [rows, query]);
  const providers = useMemo(() => groupRows(rows), [rows]);
  const groups = useMemo(
    () => groupRows(visible.filter((model) => !providerFilter || model.provider === providerFilter)),
    [visible, providerFilter],
  );
  const hiddenOlder =
    rows.length !== pickerRows(catalog, { slot, value, showOlder: true, showAllTiers }).length;
  const hasOlder =
    hiddenOlder ||
    catalog.some(
      (model) =>
        model.capabilities.vision &&
        model.status === 'legacy' &&
        (showAllTiers || FAST_TIERS.has(model.tier)),
    );
  const highlightedModel = groups.flatMap((group) => group.models).find((model) => model.id === highlighted);

  const triggerProvider: CatalogProvider = selected ? selected.provider : providerForModelId(value);
  const triggerName = selected ? selected.name : value || 'Choose a model';
  const triggerTier = selected
    ? selected.status === 'deprecated'
      ? 'Retired'
      : TIER_LABELS[selected.tier]
    : value
      ? 'Unavailable'
      : null;

  function choose(nextId: string) {
    onChange(nextId);
    setOpen(false);
    setQuery('');
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={slot === 'fast' ? 'Fast model' : 'Normal model'}
          disabled={disabled}
          data-slot="model-picker-trigger"
          className={cn(
            'corner-smooth flex h-9 w-full items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-left text-[13px] shadow-[var(--shadow-soft)] transition-colors',
            'hover:border-[var(--color-text-faint)] focus-visible:border-[var(--color-accent)] focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            selected?.status === 'deprecated' && 'border-[var(--color-danger)]',
          )}
        >
          <ProviderGlyph
            provider={triggerProvider}
            title={PROVIDER_LABELS[triggerProvider]}
            className="text-[var(--color-text-muted)]"
          />
          <span className="min-w-0 flex-1 truncate font-medium">{triggerName}</span>
          {triggerTier ? <Chip tone={triggerTier === 'Retired' ? 'warn' : 'tier'}>{triggerTier}</Chip> : null}
          <ChevronDown className="size-3.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        </button>
      </PopoverTrigger>
      {value && !selected?.capabilities.vision ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          Choose a model with image support. The app uses its default until you save a new choice.
        </p>
      ) : null}
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(600px,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(event) => {
          // cmdk focuses its input; keep Radix from moving focus elsewhere.
          event.preventDefault();
          (document.querySelector(`[data-slot="model-picker-input"]`) as HTMLInputElement | null)?.focus();
        }}
      >
        <Command
          shouldFilter={false}
          value={highlighted}
          onValueChange={setHighlighted}
          loop
          label={slot === 'fast' ? 'Fast model' : 'Normal model'}
          className="bg-[var(--color-transparent)]"
        >
          <CommandInput
            data-slot="model-picker-input"
            value={query}
            onValueChange={setQuery}
            placeholder="Search vision models"
            aria-describedby={noteId}
            className="text-[13px]"
          />
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <Eye className="size-3.5" aria-hidden /> All models support images and slide review
            </p>
            <fieldset
              className="mt-2 flex min-w-0 gap-1 overflow-x-auto border-0 pb-1"
              aria-label="Filter models by provider"
            >
              {[{ provider: null, label: 'All providers' }, ...providers].map((group) => (
                <button
                  key={group.provider ?? 'all'}
                  type="button"
                  aria-pressed={providerFilter === group.provider}
                  onClick={() => setProviderFilter(group.provider)}
                  className={cn(
                    'shrink-0 rounded-ui border px-2 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
                    providerFilter === group.provider
                      ? 'border-[var(--color-accent)] bg-[var(--color-bg-muted)] text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
                  )}
                >
                  {group.label}
                </button>
              ))}
            </fieldset>
          </div>
          <CommandList className="max-h-[320px]">
            {groups.length === 0 ? (
              <CommandEmpty className="py-8 text-[12.5px] text-[var(--color-text-muted)]">
                No vision models match. Try another search or provider.
              </CommandEmpty>
            ) : null}
            {groups.map((group) => (
              <CommandGroup
                key={group.provider}
                heading={
                  <span className="flex items-center gap-1.5">
                    <ProviderGlyph provider={group.provider} title={group.label} className="size-3.5" />
                    <span>{group.label}</span>
                    <span className="text-[var(--color-text-faint)]">{group.models.length}</span>
                  </span>
                }
                className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-[var(--color-text-muted)]"
              >
                {group.models.map((model) => {
                  const isSelected = selected?.id === model.id;
                  const legacy = model.status === 'legacy';
                  return (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      onSelect={() => choose(model.id)}
                      data-model-id={model.id}
                      data-status={model.status}
                      aria-selected={isSelected}
                      className={cn(
                        'flex items-center gap-1.5 rounded-ui px-2 py-1.5 text-[13px]',
                        'data-[selected=true]:bg-[var(--color-bg-muted)] data-[selected=true]:text-[var(--color-text)]',
                        legacy && 'text-[var(--color-text-muted)]',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={cn('truncate', !legacy && 'font-medium')}>{model.name}</span>
                          <Chip tone="tier">{TIER_LABELS[model.tier]}</Chip>
                          {legacy ? <Chip>Older</Chip> : null}
                          <span className="hidden items-center gap-1 md:flex">
                            {capabilityChips(model).map((chip) => (
                              <Chip key={chip}>{chip}</Chip>
                            ))}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] font-normal text-[var(--color-text-muted)]">
                          {model.note}
                        </span>
                      </span>
                      <RightMeta model={model} />
                      <span className="w-4 shrink-0 text-[var(--color-accent)]">
                        {isSelected ? <Check className="size-3.5" aria-label="Current choice" /> : null}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="flex min-h-[38px] items-center gap-3 border-t border-[var(--color-border)] px-3 py-1.5 text-[11.5px] text-[var(--color-text-muted)]">
            <p
              id={noteId}
              className="min-w-0 flex-1 truncate"
              data-slot="model-picker-note"
              aria-live="polite"
            >
              {highlightedModel ? (
                <>
                  <span className="font-medium text-[var(--color-text)]">{highlightedModel.name}</span>
                  <span> — {highlightedModel.note}</span>
                </>
              ) : (
                'Arrow keys move, Enter chooses.'
              )}
            </p>
            {slot === 'fast' ? (
              <button
                type="button"
                className="shrink-0 underline-offset-2 hover:text-[var(--color-text)] hover:underline"
                onClick={() => setShowAllTiers((current) => !current)}
                aria-pressed={showAllTiers}
              >
                {showAllTiers ? 'Fast tiers only' : 'Show all tiers'}
              </button>
            ) : null}
            {hasOlder ? (
              <button
                type="button"
                className="shrink-0 underline-offset-2 hover:text-[var(--color-text)] hover:underline"
                onClick={() => setShowOlder((current) => !current)}
                aria-pressed={showOlder}
              >
                {showOlder ? 'Hide older models' : 'Show older models'}
              </button>
            ) : null}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
