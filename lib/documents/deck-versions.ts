import type {
  AlbatrossDocumentModel,
  DeckElement,
  DeckElementV2,
  DeckModelV2,
  DeckSlideV2,
  DeckTheme,
} from './model';

/** Either deck version as stored. Editors and exporters lift to version 2 first. */
export type AnyDeckModel = Extract<AlbatrossDocumentModel, { kind: 'deck' }>;
export type DeckModelV1 = Extract<AnyDeckModel, { version: 1 }>;

/**
 * Fonts a deck may name. `css` is the canvas stack; `exportFamily` is the
 * PowerPoint face when the web family is not shipped with Office. Export
 * substitution is by design, not an accident: every pairing keeps metrics
 * close enough that wrapping survives.
 */
export const DECK_FONTS: Record<
  string,
  { css: string; exportFamily: string; fallback: 'serif' | 'sans-serif' | 'monospace' }
> = {
  Fraunces: {
    css: 'var(--font-fraunces), "Fraunces", Georgia, "Times New Roman", serif',
    exportFamily: 'Georgia',
    fallback: 'serif',
  },
  'Instrument Serif': {
    css: 'var(--font-instrument), "Instrument Serif", "Times New Roman", serif',
    exportFamily: 'Georgia',
    fallback: 'serif',
  },
  Manrope: { css: '"Manrope", Arial, sans-serif', exportFamily: 'Aptos', fallback: 'sans-serif' },
  'Space Grotesk': {
    css: '"Space Grotesk", Arial, sans-serif',
    exportFamily: 'Aptos Display',
    fallback: 'sans-serif',
  },
  Geist: {
    css: 'var(--font-geist-sans), "Geist", "Helvetica Neue", Arial, sans-serif',
    exportFamily: 'Aptos',
    fallback: 'sans-serif',
  },
  'Geist Mono': {
    css: 'var(--font-geist-mono), "Geist Mono", Consolas, "Courier New", monospace',
    exportFamily: 'Consolas',
    fallback: 'monospace',
  },
  Georgia: { css: 'Georgia, "Times New Roman", serif', exportFamily: 'Georgia', fallback: 'serif' },
  Aptos: {
    css: 'Aptos, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    exportFamily: 'Aptos',
    fallback: 'sans-serif',
  },
};

/** CSS font stack for a theme slot. Unknown families fall back by their declared class. */
export function deckFontStack(theme: DeckTheme, slot: 'display' | 'body' | 'mono'): string {
  const font = theme.fonts[slot] ?? theme.fonts.body;
  const known = DECK_FONTS[font.family];
  if (known) return known.css;
  const generic = font.fallback ?? (slot === 'mono' ? 'monospace' : 'sans-serif');
  return `"${font.family.replace(/"/g, '')}", ${generic}`;
}

/** PowerPoint face for a theme slot. */
export function deckExportFace(theme: DeckTheme, slot: 'display' | 'body' | 'mono'): string {
  const font = theme.fonts[slot] ?? theme.fonts.body;
  return font.exportFamily ?? DECK_FONTS[font.family]?.exportFamily ?? font.family;
}

/** Font slot for a text element: explicit, else by role. */
export function deckTextSlot(element: Extract<DeckElementV2, { type: 'text' }>): 'display' | 'body' | 'mono' {
  if (element.font) return element.font;
  return element.role === 'title' || element.role === 'number' ? 'display' : 'body';
}

/**
 * The look a version 1 deck had: the app sans, ink on white, slate shapes.
 * Lifting a version 1 deck with this theme renders exactly as before.
 */
export const LEGACY_DECK_THEME: DeckTheme = {
  name: 'legacy',
  colors: {
    background: '#FFFFFF',
    surface: '#DCE6F2',
    ink: '#17202A',
    muted: '#94A3B8',
    accent: '#17202A',
    accentInk: '#FFFFFF',
  },
  fonts: {
    display: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
    body: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
  },
};

function upgradeElement(element: DeckElement): DeckElementV2 {
  const base = {
    id: element.id,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  };
  if (element.type === 'shape') {
    return {
      ...base,
      type: 'shape',
      shape: 'rect',
      ...(element.fill ? { fill: element.fill } : {}),
      stroke: { color: element.color ?? LEGACY_DECK_THEME.colors.muted, width: 0.75 },
    };
  }
  const role = element.role && element.role !== 'shape' ? element.role : undefined;
  return {
    ...base,
    type: 'text',
    text: element.text ?? '',
    ...(role ? { role } : {}),
    ...(element.fontSize !== undefined ? { fontSize: element.fontSize } : {}),
    ...(element.color ? { color: element.color } : {}),
    // Version 1 titles rendered at weight 650; keep that so old decks do not shift.
    ...(role === 'title' ? { fontWeight: 650 } : {}),
  };
}

/** Lift any stored deck to version 2 without loss. Version 2 input is returned as is. */
export function upgradeDeckModel(model: AnyDeckModel): DeckModelV2 {
  if (model.version === 2) return model;
  return {
    kind: 'deck',
    version: 2,
    activeSlideId: model.activeSlideId,
    theme: LEGACY_DECK_THEME,
    slides: model.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
      ...(slide.background !== undefined ? { background: slide.background } : {}),
      elements: slide.elements.map(upgradeElement),
    })),
  };
}

const V1_TEXT_KEYS = new Set([
  'id',
  'x',
  'y',
  'width',
  'height',
  'type',
  'text',
  'role',
  'fontSize',
  'color',
  'fontWeight',
]);
const V1_SHAPE_KEYS = new Set(['id', 'x', 'y', 'width', 'height', 'type', 'shape', 'fill', 'stroke']);

function downgradeElement(element: DeckElementV2): DeckElement | null {
  const keys = Object.keys(element).filter((key) => (element as Record<string, unknown>)[key] !== undefined);
  if (element.type === 'text') {
    if (!keys.every((key) => V1_TEXT_KEYS.has(key))) return null;
    if (element.role === 'kicker' || element.role === 'number') return null;
    if (element.fontSize !== undefined && element.fontSize > 160) return null;
    if (element.fontWeight !== undefined && element.fontWeight !== (element.role === 'title' ? 650 : 400))
      return null;
    return {
      id: element.id,
      type: 'text',
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      text: element.text,
      ...(element.role ? { role: element.role } : {}),
      ...(element.fontSize !== undefined ? { fontSize: element.fontSize } : {}),
      ...(element.color ? { color: element.color } : {}),
    };
  }
  if (element.type === 'shape') {
    if (!keys.every((key) => V1_SHAPE_KEYS.has(key))) return null;
    if (element.shape && element.shape !== 'rect') return null;
    if (element.stroke && (element.stroke.width !== 0.75 || element.stroke.dash)) return null;
    return {
      id: element.id,
      type: 'shape',
      role: 'shape',
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      ...(element.fill ? { fill: element.fill } : {}),
      ...(element.stroke ? { color: element.stroke.color } : {}),
    };
  }
  return null;
}

/**
 * Version 1 form of a version 2 deck when nothing would be lost, else null.
 * Used so a deck that never needed version 2 keeps its old shape on save.
 */
export function downgradeDeckModel(model: DeckModelV2): DeckModelV1 | null {
  if (!deckThemesEqual(model.theme, LEGACY_DECK_THEME)) return null;
  const slides: DeckModelV1['slides'] = [];
  for (const slide of model.slides) {
    if (slide.backgroundImage) return null;
    const elements: DeckElement[] = [];
    for (const element of slide.elements) {
      const downgraded = downgradeElement(element);
      if (!downgraded) return null;
      elements.push(downgraded);
    }
    slides.push({
      id: slide.id,
      title: slide.title,
      ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
      ...(slide.background !== undefined ? { background: slide.background } : {}),
      elements,
    });
  }
  return { kind: 'deck', version: 1, activeSlideId: model.activeSlideId, slides };
}

/**
 * The model to persist after an edit. A deck stored as version 1 stays
 * version 1 while it can; version 2 is written once it needs it, and never
 * goes back.
 */
export function deckModelForSave(next: DeckModelV2, storedVersion: 1 | 2): AnyDeckModel {
  if (storedVersion === 2) return next;
  return downgradeDeckModel(next) ?? next;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** Structural equality that ignores key order, undefined fields and the stored version. */
export function deckModelsEqual(
  left: AnyDeckModel | null | undefined,
  right: AnyDeckModel | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    JSON.stringify(canonical(upgradeDeckModel(left))) === JSON.stringify(canonical(upgradeDeckModel(right)))
  );
}

export function deckThemesEqual(left: DeckTheme, right: DeckTheme) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function deckSlidesEqual(left: DeckSlideV2, right: DeckSlideV2) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
