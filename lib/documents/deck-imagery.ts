import { envFlag } from '@/lib/hosted/controls';
import { pickAccent } from '@/lib/mail/art-palette';
import { ART_STYLES, type ArtStyle } from '@/lib/mail/art-style';
import {
  type ArtworkCandidate,
  type ArtworkQuery,
  type ImportedArtwork,
  importArtwork,
  searchArtworks,
  stylesForDirection,
} from './deck-art';
import { type AnyDeckModel, upgradeDeckModel } from './deck-versions';
import type { DeckModelV2, DeckTheme } from './model';
import {
  type CompositionArtwork,
  type CompositionAsset,
  type CompositionRole,
  isHexColor,
  resolvePalette,
} from './presentation-compositions';
import {
  ARTWORK_ROLES,
  briefToContents,
  extractSlideContent,
  type PresentationBriefV2,
} from './presentation-design';

/**
 * Imagery for a presentation: which slides hang a public-domain painting, and
 * which painting. The plan is pure and deterministic from the brief and the
 * theme. Resolving the plan searches the curated pool (and the museums when
 * `DECK_ART_LIVE` is set), imports at most `budget` paintings as owned assets,
 * and never repeats one. Search and import are injected so tests stay offline.
 */

export const DEFAULT_ARTWORK_BUDGET = 4;
const CANDIDATES_PER_SLOT = 6;
const IMPORT_ATTEMPTS_PER_SLOT = 2;
const MAX_QUERY_WORDS = 12;

/** Slot order: the cover first, then image slides, statements, the close, then quotes. */
const ROLE_PRIORITY: Partial<Record<CompositionRole, number>> = {
  cover: 0,
  'image-left': 1,
  'image-right': 1,
  statement: 2,
  close: 3,
  quote: 4,
};

const STOPWORDS = new Set(
  'a an and are as at be by for from how in into is it its no not of on one or our the their this to we what when where which with your none supplied typographic slides slide image images imagery painted painting paintings picture pictures art artwork deck presentation'.split(
    ' ',
  ),
);

export interface ImagerySlotQuery {
  text: string;
  styles: ArtStyle[];
  accentHue?: number;
  count: number;
}

export interface ImagerySlot {
  slotId: string;
  slideIndex: number;
  slideId: string;
  role: CompositionRole;
  query: ImagerySlotQuery;
}

export interface DeckImageryPlan {
  subject: string;
  styles: ArtStyle[];
  accentHue?: number;
  slots: ImagerySlot[];
}

export interface ImageryPlanSlide {
  slideId: string;
  role: CompositionRole;
  title: string;
  kicker?: string;
  /** Specific image subject takes priority over broad deck context. */
  subject?: string;
  /** The slide already shows an owned image; artwork never displaces it. */
  hasImage: boolean;
}

export interface ImageryPlanInput {
  /** Free text that guides the subject of every search; "none" asks for no artwork. */
  imagery: string;
  slides: ImageryPlanSlide[];
}

function words(text: string | undefined): string[] {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function unique(list: string[]) {
  return [...new Set(list)];
}

/** OKLCH hue of a hex color, as the art pool records it. */
export function hueOfHex(color: string): number | undefined {
  if (!isHexColor(color)) return undefined;
  const hex = color.slice(1);
  const rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const accent = pickAccent([{ rgb, share: 1 }]);
  return accent.chroma < 0.045 ? undefined : Math.round(accent.hue);
}

/** The imagery guidance asks for no artwork at all. */
export function imageryDeclined(imagery: string | undefined) {
  return /^\s*(none|no artwork|no paintings|no images|typographic only)\b/i.test(imagery ?? '');
}

function stylesFor(theme: DeckTheme): ArtStyle[] {
  const named = (theme.imagery?.styles ?? []).filter((style): style is ArtStyle =>
    ART_STYLES.includes(style as ArtStyle),
  );
  if (named.length) return named;
  const palette = resolvePalette(theme.colors);
  return stylesForDirection(palette.name === 'signal' ? 'signal' : 'editorial');
}

/** The pure plan: every slide that may hang a painting, in priority order, with its search request. */
export function planImagerySlots(input: ImageryPlanInput, theme: DeckTheme): DeckImageryPlan {
  const styles = stylesFor(theme);
  const accentHue = hueOfHex(theme.colors.accent);
  const subjectWords = unique(words(theme.imagery?.subject || input.imagery));
  const subject = subjectWords.join(' ');
  if (imageryDeclined(input.imagery))
    return { subject, styles, ...(accentHue !== undefined ? { accentHue } : {}), slots: [] };
  const slots: ImagerySlot[] = [];
  input.slides.forEach((slide, slideIndex) => {
    if (slide.hasImage || !ARTWORK_ROLES.includes(slide.role)) return;
    const text = unique([
      ...words(slide.subject),
      ...subjectWords,
      ...words(slide.title),
      ...words(slide.kicker),
    ])
      .slice(0, MAX_QUERY_WORDS)
      .join(' ');
    slots.push({
      slotId: `slot-${slideIndex + 1}`,
      slideIndex,
      slideId: slide.slideId,
      role: slide.role,
      query: { text, styles, ...(accentHue !== undefined ? { accentHue } : {}), count: CANDIDATES_PER_SLOT },
    });
  });
  slots.sort(
    (a, b) => (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9) || a.slideIndex - b.slideIndex,
  );
  return { subject, styles, ...(accentHue !== undefined ? { accentHue } : {}), slots };
}

export interface PlanDeckImageryOptions {
  /** Owned assets the brief's image requests take first; artwork fills what remains. */
  assets?: CompositionAsset[];
  slideIds?: string[];
}

/** The plan for a new deck: the brief's imagery guidance, its slide titles and kickers. */
export function planDeckImagery(
  brief: PresentationBriefV2,
  theme: DeckTheme,
  options: PlanDeckImageryOptions = {},
): DeckImageryPlan {
  const contents = briefToContents(brief, { assets: options.assets });
  return planImagerySlots(
    {
      imagery: brief.imagery,
      slides: contents.map((content, index) => ({
        slideId: options.slideIds?.[index] ?? `slide-${index + 1}`,
        role: content.role,
        title: content.title,
        subject: brief.slides[index].image?.subject,
        ...(content.kicker ? { kicker: content.kicker } : {}),
        hasImage: Boolean(content.image?.asset || content.artwork),
      })),
    },
    theme,
  );
}

/** The plan for an existing deck, from the content each slide already carries. */
export function planDeckImageryForDeck(model: DeckModelV2): DeckImageryPlan {
  const total = model.slides.length;
  const slides: ImageryPlanSlide[] = [];
  model.slides.forEach((slide, index) => {
    const extracted = extractSlideContent(slide, index, total, model.theme);
    // A slide the compositions cannot carry keeps its layout, so it takes no painting.
    if (!extracted) {
      slides.push({ slideId: slide.id, role: 'list', title: slide.title, hasImage: true });
      return;
    }
    slides.push({
      slideId: slide.id,
      role: extracted.content.role,
      title: extracted.content.title,
      ...(extracted.content.kicker ? { kicker: extracted.content.kicker } : {}),
      hasImage: Boolean(extracted.content.image?.asset || extracted.content.artwork || slide.backgroundImage),
    });
  });
  // The theme's subject guides the search; a deck without one leans on its cover title.
  const imagery = model.theme.imagery?.subject || model.slides[0].title;
  return planImagerySlots({ imagery, slides }, model.theme);
}

export type ArtworkSearch = (query: ArtworkQuery & { live?: boolean }) => Promise<ArtworkCandidate[]>;
export type ArtworkImport = (userId: string, candidate: ArtworkCandidate) => Promise<ImportedArtwork>;

export interface ResolveDeckImageryOptions {
  userId: string;
  search?: ArtworkSearch;
  importOne?: ArtworkImport;
  /** Most paintings imported for one deck. */
  budget?: number;
  /** Live museum search; defaults to the DECK_ART_LIVE flag. */
  live?: boolean;
}

export interface ResolvedDeckImagery {
  assets: ImportedArtwork[];
  bySlot: Record<string, ImportedArtwork>;
  /** Plain notes on slots that got no painting. */
  notes: string[];
}

/** Run the plan: one painting per slot, no repeats, at most `budget` imports. A failed slot is a note. */
export async function resolveDeckImagery(
  plan: DeckImageryPlan,
  options: ResolveDeckImageryOptions,
): Promise<ResolvedDeckImagery> {
  const search = options.search ?? ((query) => searchArtworks(query));
  const importOne = options.importOne ?? importArtwork;
  const budget = Math.max(0, options.budget ?? DEFAULT_ARTWORK_BUDGET);
  const live = options.live ?? envFlag('DECK_ART_LIVE');
  const usedKeys = new Set<string>();
  const usedSources = new Set<string>();
  const result: ResolvedDeckImagery = { assets: [], bySlot: {}, notes: [] };
  for (const slot of plan.slots) {
    if (result.assets.length >= budget) break;
    let candidates: ArtworkCandidate[];
    try {
      candidates = await search({ ...slot.query, seed: slot.slotId, exclude: [...usedKeys], live });
    } catch {
      result.notes.push(`No artwork search result for slide ${slot.slideIndex + 1}.`);
      continue;
    }
    const fresh = candidates.filter(
      (candidate) => !usedKeys.has(candidate.key) && !usedSources.has(candidate.sourceUrl),
    );
    let imported: ImportedArtwork | null = null;
    for (const candidate of fresh.slice(0, IMPORT_ATTEMPTS_PER_SLOT)) {
      try {
        imported = await importOne(options.userId, candidate);
        usedKeys.add(candidate.key);
        usedSources.add(candidate.sourceUrl);
        break;
      } catch {
        usedKeys.add(candidate.key);
      }
    }
    if (!imported) {
      result.notes.push(`No artwork was imported for slide ${slot.slideIndex + 1}.`);
      continue;
    }
    result.assets.push(imported);
    result.bySlot[slot.slotId] = imported;
  }
  return result;
}

/** An imported painting as the compositions place it, credit included. */
export function compositionArtwork(asset: ImportedArtwork): CompositionArtwork {
  const credit = [asset.attribution.credit, asset.attribution.source].filter(Boolean).join(', ');
  return {
    asset: {
      assetId: asset.assetId,
      src: asset.src,
      alt: asset.attribution.title,
      ...(asset.aspect ? { aspect: asset.aspect } : {}),
    },
    credit,
  };
}

export function artworksBySlideIndex(
  plan: DeckImageryPlan,
  resolved: ResolvedDeckImagery,
): Partial<Record<number, CompositionArtwork>> {
  const map: Partial<Record<number, CompositionArtwork>> = {};
  for (const slot of plan.slots) {
    const asset = resolved.bySlot[slot.slotId];
    if (asset) map[slot.slideIndex] = compositionArtwork(asset);
  }
  return map;
}

export function artworksBySlideId(
  plan: DeckImageryPlan,
  resolved: ResolvedDeckImagery,
): Partial<Record<string, CompositionArtwork>> {
  const map: Partial<Record<string, CompositionArtwork>> = {};
  for (const slot of plan.slots) {
    const asset = resolved.bySlot[slot.slotId];
    if (asset) map[slot.slideId] = compositionArtwork(asset);
  }
  return map;
}

/** The theme record for a deck that hangs paintings from this plan. */
export function imageryTheme(plan: DeckImageryPlan): NonNullable<DeckTheme['imagery']> {
  return {
    mode: 'paintings',
    styles: plan.styles.slice(0, 6),
    ...(plan.subject ? { subject: plan.subject.slice(0, 200) } : {}),
  };
}

export interface DeckArtworks {
  artworks: Partial<Record<string, CompositionArtwork>>;
  imagery: NonNullable<DeckTheme['imagery']>;
  notes: string[];
}

/** Paintings for an existing deck, keyed by slide id, ready for a restyle. */
export async function artworksForDeck(
  model: AnyDeckModel,
  options: ResolveDeckImageryOptions,
): Promise<DeckArtworks> {
  const deck = upgradeDeckModel(model);
  const plan = planDeckImageryForDeck(deck);
  const resolved = plan.slots.length
    ? await resolveDeckImagery(plan, options)
    : { assets: [], bySlot: {}, notes: [] };
  return { artworks: artworksBySlideId(plan, resolved), imagery: imageryTheme(plan), notes: resolved.notes };
}
