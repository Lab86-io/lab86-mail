'use client';

import { useMemo, useState } from 'react';
import { type Model, ModelSelector, ModelSelectorPanel } from '@/components/odysseyui/model-selector';
import { ProviderGlyph } from '@/components/settings/ProviderGlyph';
import {
  type CatalogModel,
  type CatalogProvider,
  type CatalogSlot,
  findCatalogModel,
  formatContextTokens,
  formatPricing,
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  TIER_LABELS,
} from '@/lib/ai/model-catalog';

export type ModelPickerProps = {
  slot: CatalogSlot;
  value: string;
  onChange: (id: string) => void;
  catalog: CatalogModel[];
  disabled?: boolean;
  /** Id for the search input, so a Label can point at it. */
  id?: string;
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

export function ModelPicker({ slot, value, onChange, catalog, disabled = false, id }: ModelPickerProps) {
  const [showOlder, setShowOlder] = useState(false);
  const [showAllTiers, setShowAllTiers] = useState(slot === 'normal');
  const selected = findCatalogModel(catalog, value);
  const rows = useMemo(
    () => pickerRows(catalog, { slot, value, showOlder, showAllTiers }),
    [catalog, slot, value, showOlder, showAllTiers],
  );
  const providers = groupRows(rows).map((group) => ({
    id: group.provider,
    label: group.label,
    icon: <ProviderGlyph provider={group.provider} />,
  }));
  const models: Model[] = rows.map((model) => ({
    id: model.id,
    provider: model.provider,
    name: model.name,
    desc: model.note,
    cost: [formatContextTokens(model.contextTokens), formatPricing(model.pricing)]
      .filter(Boolean)
      .join(' · '),
    tag: model.status === 'legacy' ? 'Older' : TIER_LABELS[model.tier],
    caps: [
      'vision' as const,
      ...(model.capabilities.reasoning ? ['reasoning' as const] : []),
      ...(model.capabilities.tools ? ['tools' as const] : []),
    ],
    starred: false,
    keywords: `${model.id} ${model.providerLabel} ${TIER_LABELS[model.tier]}`,
  }));
  const hasOlder = catalog.some(
    (model) =>
      model.capabilities.vision && model.status === 'legacy' && (showAllTiers || FAST_TIERS.has(model.tier)),
  );
  const selectable = selected && rows.some((row) => row.id === selected.id);

  return (
    <ModelSelector
      providers={providers}
      models={models}
      value={selected?.id ?? value}
      onValueChange={onChange}
      disabled={disabled}
      label={slot === 'fast' ? 'Fast model' : 'Normal model'}
    >
      <ModelSelectorPanel id={id}>
        <div className="space-y-2 border-t border-[var(--color-border)] px-3 py-2.5 text-[11px] text-[var(--color-text-muted)]">
          <p aria-live="polite" data-slot="model-picker-selection" className="break-words">
            {selectable ? (
              <>
                Selected: <strong className="font-medium text-[var(--color-text)]">{selected.name}</strong>
              </>
            ) : value ? (
              <>Saved model unavailable. Choose a model with image support.</>
            ) : (
              'Choose a model above.'
            )}
          </p>
          <p>All models support images and slide review</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="mr-auto">Prices: USD / 1M tokens, input / output</span>
            {slot === 'fast' && (
              <button
                type="button"
                disabled={disabled}
                className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                onClick={() => setShowAllTiers((current) => !current)}
                aria-pressed={showAllTiers}
              >
                {showAllTiers ? 'Fast tiers only' : 'Show all tiers'}
              </button>
            )}
            {hasOlder && (
              <button
                type="button"
                disabled={disabled}
                className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                onClick={() => setShowOlder((current) => !current)}
                aria-pressed={showOlder}
              >
                {showOlder ? 'Hide older models' : 'Show older models'}
              </button>
            )}
          </div>
        </div>
      </ModelSelectorPanel>
    </ModelSelector>
  );
}
