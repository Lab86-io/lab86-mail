'use client';

import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { DeckTheme } from '@/lib/documents/model';
import { ART_STYLES, type ArtStyle } from '@/lib/mail/art-style';
import {
  ARTWORK_STYLES_FOR_DIRECTION,
  type DeckArtworkCandidate,
  type DeckArtworkQuery,
  hueFromHex,
  type ImportedDeckArtwork,
  importDeckArtwork,
  searchDeckArtworks,
} from './assets';

/**
 * Public-domain artwork for the active slide: a search field, one style at
 * a time, a museum toggle, and a small wall of results. A press on a result
 * selects it; the row under the wall places it on the slide or behind it.
 * Every import goes through the import route, so the deck keeps an owned
 * asset with its credit. Credits stay visible under each thumbnail.
 */

export const ARTWORK_PAGE_SIZE = 12;

const STYLE_LABELS: Record<ArtStyle, string> = {
  gothic: 'Gothic',
  'art-deco': 'Art deco',
  renaissance: 'Renaissance',
  'dutch-golden-age': 'Dutch golden age',
  baroque: 'Baroque',
  rococo: 'Rococo',
  neoclassical: 'Neoclassical',
  romantic: 'Romantic',
  american: 'American',
  impressionist: 'Impressionist',
  modern: 'Modern',
  'east-asian': 'East Asian',
};

export function directionForTheme(theme: DeckTheme): 'editorial' | 'signal' {
  return theme.name?.trim().toLowerCase() === 'signal' ? 'signal' : 'editorial';
}

/** The query the panel opens with: theme styles and hue, seeded by the slide. */
export function defaultArtworkQuery(theme: DeckTheme, slideId: string): DeckArtworkQuery {
  const styles = (theme.imagery?.styles?.length ? theme.imagery.styles : undefined) ?? [
    ...ARTWORK_STYLES_FOR_DIRECTION[directionForTheme(theme)],
  ];
  const hue = hueFromHex(theme.colors.accent);
  return {
    styles,
    ...(hue !== undefined ? { hue } : {}),
    count: ARTWORK_PAGE_SIZE,
    seed: slideId,
  };
}

export type ArtworkAction = 'place' | 'background';

export interface ArtworkPanelProps {
  theme: DeckTheme;
  slideId: string;
  readOnly?: boolean;
  /** Label of the first action; "Replace image" when an image element is the target. */
  placeLabel?: string;
  /** Bumps to move focus to the search field again. Negative leaves focus where it is. */
  focusKey?: number;
  onPlace: (asset: ImportedDeckArtwork, candidate: DeckArtworkCandidate) => void;
  onBackground: (asset: ImportedDeckArtwork, candidate: DeckArtworkCandidate) => void;
  onClose?: () => void;
  /** Search and import; the defaults call the artwork routes. */
  search?: (query: DeckArtworkQuery, signal?: AbortSignal) => Promise<DeckArtworkCandidate[]>;
  importArtwork?: (candidate: DeckArtworkCandidate) => Promise<ImportedDeckArtwork>;
}

export function ArtworkPanel({
  theme,
  slideId,
  readOnly = false,
  placeLabel = 'Place on slide',
  focusKey = 0,
  onPlace,
  onBackground,
  onClose,
  search = (query, signal) => searchDeckArtworks(query, undefined, signal),
  importArtwork = (candidate) => importDeckArtwork(candidate),
}: ArtworkPanelProps) {
  const base = defaultArtworkQuery(theme, slideId);
  const [text, setText] = useState('');
  const [style, setStyle] = useState<ArtStyle | ''>('');
  const [live, setLive] = useState(false);
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<DeckArtworkCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [importing, setImporting] = useState<ArtworkAction | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const liveId = useId();
  const searchRef = useRef(search);
  useLayoutEffect(() => {
    searchRef.current = search;
  });

  const styles = style ? [style] : base.styles;
  const hue = base.hue;
  const seed = page ? `${slideId}:${page}` : slideId;
  const styleKey = styles?.join(',') ?? '';

  useEffect(() => {
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);
    searchRef
      .current(
        {
          ...(submitted ? { text: submitted } : {}),
          styles: styleKey ? styleKey.split(',') : undefined,
          ...(hue !== undefined ? { hue } : {}),
          count: ARTWORK_PAGE_SIZE,
          seed,
          live,
        },
        controller.signal,
      )
      .then((found) => {
        if (controller.signal.aborted) return;
        setResults(found);
        setChosen((current) => (found.some((item) => item.key === current) ? current : null));
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setSearchError(cause instanceof Error ? cause.message : 'Search failed.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [submitted, styleKey, hue, seed, live]);

  useEffect(() => {
    if (focusKey < 0) return;
    field.current?.focus();
  }, [focusKey]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPage(0);
    setSubmitted(text.trim());
  };

  const selected = results.find((item) => item.key === chosen) ?? null;
  const busy = importing !== null;

  const run = async (action: ArtworkAction) => {
    if (!selected || busy) return;
    setImporting(action);
    setImportError(null);
    try {
      const asset = await importArtwork(selected);
      if (action === 'place') onPlace(asset, selected);
      else onBackground(asset, selected);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : 'Import failed.');
    } finally {
      setImporting(null);
    }
  };

  return (
    <section aria-labelledby={headingId} className="deck-artwork">
      <div className="deck-artwork-head">
        <h3 id={headingId} className="deck-inspector-heading">
          Artwork
        </h3>
        {onClose ? (
          <Button type="button" variant="ghost" size="xs" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
      <p className="deck-inspector-note">
        Public-domain paintings and prints from museum collections. The credit goes into the speaker notes.
      </p>
      <form className="deck-artwork-search" onSubmit={submit}>
        <input
          ref={field}
          type="search"
          aria-label="Search artwork"
          className="control-field h-8 w-full px-2 text-xs"
          placeholder="Harbor, garden, portrait"
          value={text}
          disabled={readOnly}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={readOnly || searching}>
          Search
        </Button>
      </form>
      <fieldset className="deck-artwork-styles" disabled={readOnly}>
        <legend className="sr-only">Style</legend>
        <button
          type="button"
          className="deck-artwork-chip"
          aria-pressed={style === ''}
          onClick={() => {
            setStyle('');
            setPage(0);
          }}
        >
          Any style
        </button>
        {ART_STYLES.map((option) => (
          <button
            key={option}
            type="button"
            className="deck-artwork-chip"
            aria-pressed={style === option}
            onClick={() => {
              setStyle(option);
              setPage(0);
            }}
          >
            {STYLE_LABELS[option]}
          </button>
        ))}
      </fieldset>
      <label className="deck-artwork-toggle" htmlFor={liveId}>
        <Switch
          id={liveId}
          size="sm"
          aria-label="Search museums too"
          checked={live}
          disabled={readOnly}
          onCheckedChange={(checked) => {
            setLive(checked);
            setPage(0);
          }}
        />
        <span>Search museums too</span>
      </label>
      {searchError ? (
        <p role="alert" className="deck-inspector-error">
          {searchError}
        </p>
      ) : null}
      {!searching && !searchError && results.length === 0 ? (
        <p className="deck-inspector-note">No artwork matched. Try other words or another style.</p>
      ) : null}
      <ul className="deck-artwork-grid" aria-label="Artwork results" aria-busy={searching}>
        {results.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="deck-artwork-item"
              aria-pressed={item.key === chosen}
              aria-label={item.credit}
              disabled={readOnly || busy}
              onClick={() => {
                setChosen(item.key);
                setImportError(null);
              }}
            >
              <span className="deck-artwork-thumb">
                {/* biome-ignore lint/performance/noImgElement: museum preview at its own size */}
                <img src={item.previewUrl} alt="" loading="lazy" draggable={false} />
              </span>
              <span className="deck-artwork-credit">{item.credit}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="deck-artwork-foot">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={readOnly || searching || busy}
          onClick={() => setPage((current) => current + 1)}
        >
          More
        </Button>
        {searching ? (
          <span role="status" className="deck-artwork-status">
            Searching
          </span>
        ) : null}
      </div>
      <div className="deck-artwork-actions" aria-live="polite">
        {selected ? (
          <p className="deck-artwork-selected">
            <span className="deck-artwork-selected-title">{selected.title}</span>
            <span className="deck-artwork-selected-meta">
              {[selected.artist, selected.date].filter(Boolean).join(', ')}
              {selected.source ? ` · ${selected.source}` : ''}
              {selected.license ? ` · ${selected.license}` : ''}
            </span>
          </p>
        ) : (
          <p className="deck-inspector-note">Select an artwork to place it.</p>
        )}
        <div className="deck-button-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly || !selected || busy}
            onClick={() => void run('place')}
          >
            {placeLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly || !selected || busy}
            onClick={() => void run('background')}
          >
            Use as background
          </Button>
        </div>
        {importing ? (
          <p role="status" className="deck-artwork-status">
            {importing === 'place' ? 'Importing the artwork' : 'Importing the background'}
          </p>
        ) : null}
        {importError ? (
          <p role="alert" className="deck-inspector-error">
            {importError}
          </p>
        ) : null}
      </div>
    </section>
  );
}
