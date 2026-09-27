'use client';

// Adapted from Odyssey UI's model-selector registry component:
// https://www.odysseyui.com/r/components-ai-model-selector.json
// The provider rail, animated rows, capability badges and pins come
// from that component. Its modal/trigger are replaced with a permanent panel;
// selection is controlled, and pin buttons are siblings of selection buttons.
// Pins are saved for the user on the server (lib/shell/pinned-models).

import { Brain, Check, Eye, LayoutGrid, Pin, Search, Wrench, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  createContext,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  useContext,
  useId,
  useMemo,
  useState,
} from 'react';
import { usePinnedModels } from '@/lib/shell/pinned-models';
import { cn } from '@/lib/utils';

export interface Provider {
  id: string;
  icon: ReactNode;
  label: string;
}

export interface Model {
  id: string;
  provider: string;
  name: string;
  desc: string;
  cost: string;
  tag: string | null;
  caps: ('vision' | 'reasoning' | 'tools')[];
  starred: boolean;
  keywords: string;
}

interface ModelSelectorCtxValue {
  providers: Provider[];
  selectedId: string;
  select: (id: string) => void;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  activeProvider: string | null;
  setActiveProvider: Dispatch<SetStateAction<string | null>>;
  filtered: Model[];
  starred: Set<string>;
  toggleStar: (id: string) => void;
  starredOnly: boolean;
  setStarredOnly: Dispatch<SetStateAction<boolean>>;
  disabled: boolean;
  reducedMotion: boolean;
  instanceId: string;
  label: string;
}

const ModelSelectorCtx = createContext<ModelSelectorCtxValue | null>(null);

function useModelSelector() {
  const ctx = useContext(ModelSelectorCtx);
  if (!ctx) throw new Error('Must be used inside <ModelSelector>');
  return ctx;
}

const CAP_ICONS = {
  vision: { icon: Eye, label: 'Vision' },
  reasoning: { icon: Brain, label: 'Reasoning' },
  tools: { icon: Wrench, label: 'Tools' },
};

export function ModelSelector({
  children,
  providers,
  models,
  value,
  onValueChange,
  label,
  disabled = false,
}: {
  children: ReactNode;
  providers: Provider[];
  models: Model[];
  value: string;
  onValueChange: (id: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const instanceId = useId();
  const reducedMotion = Boolean(useReducedMotion());
  const [search, setSearch] = useState('');
  const [providerFilter, setActiveProvider] = useState<string | null>(null);
  // Switching API providers can remove the active provider from this catalog.
  const activeProvider = providers.some((p) => p.id === providerFilter) ? providerFilter : null;
  const [starredOnly, setStarredOnly] = useState(false);
  const { pins, toggle } = usePinnedModels();
  const starred = useMemo(
    () => new Set([...models.filter((m) => m.starred).map((m) => m.id), ...pins]),
    [models, pins],
  );

  const toggleStar = (id: string) => {
    if (disabled) return;
    void toggle(id);
  };

  const filtered = models.filter((model) => {
    const matchProvider = !activeProvider || model.provider === activeProvider;
    const tokens = search.trim().toLowerCase().split(/\s+/);
    const haystack = `${model.name} ${model.desc} ${model.keywords}`.toLowerCase();
    return (
      matchProvider &&
      tokens.every((token) => haystack.includes(token)) &&
      (!starredOnly || starred.has(model.id))
    );
  });

  return (
    <ModelSelectorCtx.Provider
      value={{
        providers,
        selectedId: value,
        select: (id) => {
          if (!disabled && models.some((model) => model.id === id)) onValueChange(id);
        },
        search,
        setSearch,
        activeProvider,
        setActiveProvider,
        filtered,
        starred,
        toggleStar,
        starredOnly,
        setStarredOnly,
        disabled,
        reducedMotion,
        instanceId,
        label,
      }}
    >
      {children}
    </ModelSelectorCtx.Provider>
  );
}

export function ModelSelectorPanel({ id, children }: { id?: string; children?: ReactNode }) {
  const { label, disabled } = useModelSelector();
  return (
    <section
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="model-selector-panel"
      className={cn(
        'min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)]',
        disabled && 'opacity-50',
      )}
    >
      <ModelSelectorHeader id={id} />
      <div className="flex h-[340px] min-h-0">
        <ModelSelectorProviderSidebar />
        <ModelSelectorModelList />
      </div>
      {children}
    </section>
  );
}

function ModelSelectorHeader({ id }: { id?: string }) {
  const { search, setSearch, label, disabled, instanceId } = useModelSelector();
  return (
    <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3 py-2.5">
      <Search className="size-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
      <input
        id={id}
        type="search"
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          document
            .getElementById(`${instanceId}-list`)
            ?.querySelector<HTMLButtonElement>('[data-model-id]')
            ?.focus();
        }}
        placeholder="Search vision models"
        aria-label={`Search ${label.toLowerCase()}s`}
        aria-controls={`${instanceId}-list`}
        data-slot="model-picker-input"
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-text-muted)] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed"
      />
      {search && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setSearch('')}
          aria-label="Clear search"
          className="flex size-7 shrink-0 items-center justify-center rounded-ui text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function ModelSelectorProviderSidebar() {
  const { providers, activeProvider, setActiveProvider, starredOnly, setStarredOnly } = useModelSelector();
  return (
    <fieldset
      className="flex min-w-0 w-14 shrink-0 flex-col gap-1 overflow-y-auto border-0 border-r border-solid border-[var(--color-border)] px-2 py-2"
      aria-label="Filter models"
    >
      <SidebarBtn
        active={!activeProvider && !starredOnly}
        onClick={() => {
          setActiveProvider(null);
          setStarredOnly(false);
        }}
        title="All providers"
      >
        <LayoutGrid className="size-4" aria-hidden />
      </SidebarBtn>
      <SidebarBtn active={starredOnly} onClick={() => setStarredOnly((prev) => !prev)} title="Pinned models">
        <Pin className="size-4" aria-hidden />
      </SidebarBtn>
      <div className="my-1 border-t border-[var(--color-border)]" />
      {providers.map((provider) => (
        <SidebarBtn
          key={provider.id}
          active={activeProvider === provider.id}
          onClick={() => setActiveProvider(activeProvider === provider.id ? null : provider.id)}
          title={provider.label}
        >
          <span className="flex size-4 items-center justify-center [&>svg]:size-full">{provider.icon}</span>
        </SidebarBtn>
      ))}
    </fieldset>
  );
}

function SidebarBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  const { disabled, reducedMotion, instanceId } = useModelSelector();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={reducedMotion || disabled ? undefined : { scale: 1.08 }}
      whileTap={reducedMotion || disabled ? undefined : { scale: 0.92 }}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'relative mx-auto flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed',
        active
          ? 'bg-[var(--color-bg-muted)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text)]',
      )}
    >
      {active && (
        <motion.span
          layoutId={`${instanceId}-${title === 'Pinned models' ? 'stars' : 'provider'}-indicator`}
          className="absolute inset-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]"
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 350, damping: 30 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </motion.button>
  );
}

function ModelSelectorModelList() {
  const { filtered, instanceId, label } = useModelSelector();
  function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-model-id]:not(:disabled)'),
    ];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    // Star controls use their native button keyboard behavior.
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  return (
    <ul
      id={`${instanceId}-list`}
      aria-label={`${label} choices`}
      onKeyDown={moveFocus}
      className="min-w-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5"
    >
      {filtered.length === 0 && (
        <li className="px-3 py-12 text-center text-[12px] text-[var(--color-text-muted)]" role="status">
          No vision models match. Try another search or filter.
        </li>
      )}
      {filtered.map((model, index) => (
        <ModelSelectorModelRow key={model.id} model={model} index={index} />
      ))}
    </ul>
  );
}

function ModelSelectorModelRow({ model, index }: { model: Model; index: number }) {
  const { providers, selectedId, select, starred, toggleStar, disabled, reducedMotion } = useModelSelector();
  const isSelected = selectedId === model.id;
  const isStarred = starred.has(model.id);
  return (
    <motion.li
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        delay: reducedMotion ? 0 : Math.min(index, 8) * 0.025,
        duration: reducedMotion ? 0 : 0.2,
      }}
      className={cn(
        'flex items-center rounded-xl border transition-colors',
        isSelected
          ? 'border-[var(--color-border)] bg-[var(--color-bg-muted)]'
          : 'border-transparent hover:bg-[var(--color-bg-muted)]',
      )}
    >
      <button
        type="button"
        onClick={() => select(model.id)}
        disabled={disabled}
        data-model-id={model.id}
        aria-label={`Select ${model.name}`}
        aria-pressed={isSelected}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]">
          <span className="flex size-4 items-center justify-center [&>svg]:size-full">
            {providers.find((provider) => provider.id === model.provider)?.icon ?? '◈'}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="min-w-0 break-words text-[13px] font-semibold tracking-tight">{model.name}</span>
            {model.tag && (
              <span className="rounded border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-muted)]">
                {model.tag}
              </span>
            )}
            {isSelected && <Check className="size-3.5 shrink-0 text-[var(--color-accent)]" aria-hidden />}
          </span>
          <span
            className="mt-0.5 block truncate text-[11px] leading-snug text-[var(--color-text-muted)]"
            title={model.desc}
          >
            {model.desc}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-1 py-0.5">
              {model.caps.map((cap) => {
                const { icon: Icon, label } = CAP_ICONS[cap];
                return (
                  <span key={cap} title={label}>
                    <Icon className="size-3" aria-label={label} />
                  </span>
                );
              })}
            </span>
            <span className="tabular-nums">{model.cost}</span>
          </span>
        </span>
      </button>
      <motion.button
        type="button"
        disabled={disabled}
        aria-label={`${isStarred ? 'Unpin' : 'Pin'} ${model.name}`}
        aria-pressed={isStarred}
        onClick={() => toggleStar(model.id)}
        whileHover={reducedMotion || disabled ? undefined : { scale: 1.2 }}
        whileTap={reducedMotion || disabled ? undefined : { scale: 0.85 }}
        className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed"
      >
        <Pin className={cn('size-3.5', isStarred && 'fill-current text-[var(--color-accent)]')} aria-hidden />
      </motion.button>
    </motion.li>
  );
}
