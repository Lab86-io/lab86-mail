/**
 * Pure presentation-model helpers: slide identity, bounded element layout
 * and a small coalescing undo history. No React/DOM. Every helper works on
 * the version 2 deck; a stored version 1 deck is lifted on entry.
 * All geometry is percent of the slide; fonts are sized against a 960-wide
 * reference so text scales with the canvas, never the viewport.
 */
import { type AnyDeckModel, deckModelsEqual, upgradeDeckModel } from '@/lib/documents/deck-versions';
import type { DeckElementV2, DeckModelV2, DeckSlideV2 } from '@/lib/documents/model';

export type DeckModel = DeckModelV2;
export type DeckSlide = DeckSlideV2;
export type DeckElement = DeckElementV2;
export type ElementBounds = Pick<DeckElement, 'x' | 'y' | 'width' | 'height'>;

export { deckModelsEqual, upgradeDeckModel };

/** Reference slide width the model's `fontSize` values are authored against. */
export const SLIDE_REFERENCE_WIDTH = 960;
export const MIN_ELEMENT_SIZE = 1;
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 5;
export const HISTORY_LIMIT = 200;
export const TEXT_COALESCE_MS = 1_500;

/** Same bounded color subset as Office export; never interpret CSS URLs. */
export function slideColor(value: string | undefined, fallback: string) {
  const normalized = String(value || '')
    .trim()
    .replace(/^#/, '')
    .toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? `#${normalized}` : fallback;
}

export function createDeckId() {
  return crypto.randomUUID();
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Keep an element fully inside the slide with a usable minimum size. Lines may be flat. */
export function clampElementBounds(bounds: ElementBounds, minSize = MIN_ELEMENT_SIZE): ElementBounds {
  const width = round(
    Math.min(100, Math.max(minSize, Number.isFinite(bounds.width) ? bounds.width : minSize)),
  );
  const height = round(
    Math.min(100, Math.max(minSize, Number.isFinite(bounds.height) ? bounds.height : minSize)),
  );
  const x = Math.min(100 - width, Math.max(0, Number.isFinite(bounds.x) ? bounds.x : 0));
  const y = Math.min(100 - height, Math.max(0, Number.isFinite(bounds.y) ? bounds.y : 0));
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

export function clampFontSize(value: number) {
  return Math.min(240, Math.max(8, Number.isFinite(value) ? Math.round(value) : 16));
}

/** CSS font size that follows the slide container's width (container query units). */
export function fontSizeForCanvas(fontSize: number | undefined) {
  const size = clampFontSize(fontSize ?? 16);
  return `${round((size / SLIDE_REFERENCE_WIDTH) * 100)}cqw`;
}

/** Points to container width units: the slide is 960pt wide at reference scale. */
export function pointsForCanvas(points: number) {
  return `${round((points / SLIDE_REFERENCE_WIDTH) * 100)}cqw`;
}

const lift = (model: AnyDeckModel) => upgradeDeckModel(model);

export function activeSlide(model: AnyDeckModel): DeckSlide {
  const deck = lift(model);
  return deck.slides.find((slide) => slide.id === deck.activeSlideId) || deck.slides[0];
}

export function slideIndex(model: AnyDeckModel, slideId: string) {
  return model.slides.findIndex((slide) => slide.id === slideId);
}

function withSlides(model: DeckModel, slides: DeckSlide[], activeSlideId = model.activeSlideId): DeckModel {
  return { ...model, activeSlideId, slides };
}

export function updateSlide(model: AnyDeckModel, slideId: string, patch: Partial<DeckSlide>): DeckModel {
  const deck = lift(model);
  return withSlides(
    deck,
    deck.slides.map((slide) => (slide.id === slideId ? { ...slide, ...patch, id: slide.id } : slide)),
  );
}

export function updateTheme(model: AnyDeckModel, patch: Partial<DeckModel['theme']>): DeckModel {
  const deck = lift(model);
  return { ...deck, theme: { ...deck.theme, ...patch } };
}

export function newSlide(id: string, index: number, createId: () => string = createDeckId): DeckSlide {
  return {
    id,
    title: `Slide ${index}`,
    elements: [
      {
        id: createId(),
        type: 'text',
        role: 'title',
        x: 8,
        y: 10,
        width: 84,
        height: 16,
        text: `Slide ${index}`,
        fontSize: 32,
      },
      {
        id: createId(),
        type: 'text',
        role: 'body',
        x: 10,
        y: 34,
        width: 80,
        height: 44,
        text: '',
        fontSize: 18,
      },
    ],
  };
}

/** Insert a fresh slide after the active one and select it. */
export function addSlide(model: AnyDeckModel, createId: () => string = createDeckId): DeckModel {
  const deck = lift(model);
  const index = slideIndex(deck, deck.activeSlideId);
  const slide = newSlide(createId(), deck.slides.length + 1, createId);
  const slides = [...deck.slides];
  slides.splice(index + 1, 0, slide);
  return withSlides(deck, slides, slide.id);
}

/** Deep-copy a slide with new slide and element identities; select the copy. */
export function duplicateSlide(
  model: AnyDeckModel,
  slideId: string,
  createId: () => string = createDeckId,
): DeckModel {
  const deck = lift(model);
  const index = slideIndex(deck, slideId);
  if (index < 0) return deck;
  const source = deck.slides[index];
  const copy: DeckSlide = {
    ...source,
    id: createId(),
    elements: source.elements.map((element) => ({ ...element, id: createId() })),
  };
  const slides = [...deck.slides];
  slides.splice(index + 1, 0, copy);
  return withSlides(deck, slides, copy.id);
}

/** Remove a slide; the selection moves to the neighbour that took its place. */
export function deleteSlide(model: AnyDeckModel, slideId: string): DeckModel {
  const deck = lift(model);
  const index = slideIndex(deck, slideId);
  if (index < 0 || deck.slides.length <= 1) return deck;
  const slides = deck.slides.filter((slide) => slide.id !== slideId);
  const activeSlideId =
    deck.activeSlideId === slideId ? slides[Math.min(index, slides.length - 1)].id : deck.activeSlideId;
  return withSlides(deck, slides, activeSlideId);
}

export function moveSlide(model: AnyDeckModel, slideId: string, direction: -1 | 1): DeckModel {
  const deck = lift(model);
  const index = slideIndex(deck, slideId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= deck.slides.length) return deck;
  const slides = [...deck.slides];
  const [moved] = slides.splice(index, 1);
  slides.splice(target, 0, moved);
  return withSlides(deck, slides);
}

export function selectSlide(model: AnyDeckModel, slideId: string): DeckModel {
  const deck = lift(model);
  if (slideId === deck.activeSlideId || slideIndex(deck, slideId) < 0) return deck;
  return { ...deck, activeSlideId: slideId };
}

export interface NewElementOptions {
  /** Required for images: an owned asset. */
  image?: { assetId: string; src?: string; alt: string; aspect?: number };
  ink?: string;
}

export function newElement(
  type: DeckElement['type'],
  id: string,
  existingCount: number,
  options: NewElementOptions = {},
): DeckElement {
  const offset = Math.min(30, existingCount * 4);
  switch (type) {
    case 'shape':
      return clampElement({
        id,
        type: 'shape',
        shape: 'rect',
        x: 30 + offset,
        y: 30 + offset,
        width: 24,
        height: 24,
      });
    case 'line':
      return clampElement({
        id,
        type: 'line',
        x: 20 + offset,
        y: 50 + offset,
        width: 60,
        height: 0,
        stroke: { color: options.ink ?? '#17202A', width: 1.5 },
      });
    case 'image': {
      const image = options.image ?? { assetId: '', alt: '' };
      const aspect = image.aspect ?? 4 / 3;
      const width = 40;
      const height = Math.min(70, (width / aspect) * (16 / 9));
      return clampElement({
        id,
        type: 'image',
        x: 30 + offset,
        y: 15 + offset,
        width,
        height,
        assetId: image.assetId,
        ...(image.src ? { src: image.src } : {}),
        alt: image.alt,
        fit: 'cover',
        ...(image.aspect ? { aspect: image.aspect } : {}),
      });
    }
    case 'chart':
      return clampElement({
        id,
        type: 'chart',
        chart: 'column',
        x: 20 + offset,
        y: 25 + offset,
        width: 60,
        height: 50,
        categories: ['A', 'B', 'C'],
        series: [{ name: 'Series', values: [3, 5, 4] }],
      });
    default:
      return clampElement({
        id,
        type: 'text',
        role: 'body',
        x: 10 + offset,
        y: 40 + offset,
        width: 60,
        height: 14,
        text: 'Text',
        fontSize: 18,
      });
  }
}

export function clampElement(element: DeckElement): DeckElement {
  const bounds = clampElementBounds(element, element.type === 'line' ? 0 : MIN_ELEMENT_SIZE);
  const next = { ...element, ...bounds } as DeckElement;
  if (next.type === 'text' && next.fontSize !== undefined) next.fontSize = clampFontSize(next.fontSize);
  return next;
}

export function addElement(
  model: AnyDeckModel,
  slideId: string,
  type: DeckElement['type'],
  createId: () => string = createDeckId,
  options: NewElementOptions = {},
): { model: DeckModel; elementId: string } {
  const deck = lift(model);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return { model: deck, elementId: '' };
  const element = newElement(type, createId(), slide.elements.length, {
    ink: deck.theme.colors.ink,
    ...options,
  });
  return {
    model: updateSlide(deck, slideId, { elements: [...slide.elements, element] }),
    elementId: element.id,
  };
}

/** Any field of any element kind; the element's own kind decides what applies. */
export type ElementPatch = Partial<Omit<DeckElement, 'id' | 'type'>> & Record<string, unknown>;

/**
 * Patch an element, clamping geometry and font size. A title element's text
 * also keeps the slide title in step so the filmstrip and outline stay honest.
 */
export function updateElement(
  model: AnyDeckModel,
  slideId: string,
  elementId: string,
  patch: ElementPatch,
): DeckModel {
  const deck = lift(model);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  const current = slide?.elements.find((element) => element.id === elementId);
  if (!slide || !current) return deck;
  const element = clampElement({ ...current, ...patch, id: current.id, type: current.type } as DeckElement);
  const slidePatch: Partial<DeckSlide> = {
    elements: slide.elements.map((candidate) => (candidate.id === elementId ? element : candidate)),
  };
  if (element.type === 'text' && element.role === 'title' && patch.text !== undefined)
    slidePatch.title = element.text || slide.title;
  return updateSlide(deck, slideId, slidePatch);
}

export function nudgeElement(
  model: AnyDeckModel,
  slideId: string,
  elementId: string,
  dx: number,
  dy: number,
): DeckModel {
  const deck = lift(model);
  const element = deck.slides
    .find((candidate) => candidate.id === slideId)
    ?.elements.find((candidate) => candidate.id === elementId);
  if (!element) return deck;
  return updateElement(deck, slideId, elementId, { x: element.x + dx, y: element.y + dy });
}

export function deleteElement(model: AnyDeckModel, slideId: string, elementId: string): DeckModel {
  const deck = lift(model);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide?.elements.some((element) => element.id === elementId)) return deck;
  return updateSlide(deck, slideId, {
    elements: slide.elements.filter((element) => element.id !== elementId),
  });
}

/** Move an element one step up or down the layer order. */
export function reorderElement(
  model: AnyDeckModel,
  slideId: string,
  elementId: string,
  direction: -1 | 1,
): DeckModel {
  const deck = lift(model);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return deck;
  const index = slide.elements.findIndex((element) => element.id === elementId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= slide.elements.length) return deck;
  const elements = [...slide.elements];
  const [moved] = elements.splice(index, 1);
  elements.splice(target, 0, moved);
  return updateSlide(deck, slideId, { elements });
}

/** Undo history with optional coalescing of rapid same-key edits (typing). */
export interface EditHistory<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey?: string;
  lastAt?: number;
}

export function createHistory<T>(present: T): EditHistory<T> {
  return { past: [], present, future: [] };
}

export function pushHistory<T>(
  history: EditHistory<T>,
  next: T,
  options: { key?: string; now?: number; coalesceMs?: number } = {},
): EditHistory<T> {
  if (next === history.present) return history;
  const now = options.now ?? 0;
  const coalesceMs = options.coalesceMs ?? TEXT_COALESCE_MS;
  const coalesce =
    options.key !== undefined &&
    history.lastKey === options.key &&
    history.lastAt !== undefined &&
    now - history.lastAt <= coalesceMs;
  const past = coalesce ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: options.key, lastAt: options.key ? now : undefined };
}

export function undoHistory<T>(history: EditHistory<T>): EditHistory<T> {
  if (!history.past.length) return history;
  const past = history.past.slice(0, -1);
  return {
    past,
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redoHistory<T>(history: EditHistory<T>): EditHistory<T> {
  if (!history.future.length) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present], present, future };
}

/** One element of one slide, or undefined. */
export function findElement(
  model: AnyDeckModel,
  slideId: string,
  elementId: string,
): DeckElement | undefined {
  return lift(model)
    .slides.find((slide) => slide.id === slideId)
    ?.elements.find((element) => element.id === elementId);
}

/** A readable kind name for the inspector. */
export function elementLabel(element: DeckElement): string {
  switch (element.type) {
    case 'text':
      return 'Text';
    case 'shape':
      return 'Shape';
    case 'line':
      return 'Line';
    case 'image':
      return 'Image';
    case 'chart':
      return 'Chart';
  }
}

/** Copy an element onto the same slide, a little lower and to the right, and put it on top. */
export function duplicateElement(
  model: AnyDeckModel,
  slideId: string,
  elementId: string,
  createId: () => string = createDeckId,
): { model: DeckModel; elementId: string } {
  const deck = lift(model);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  const source = slide?.elements.find((element) => element.id === elementId);
  if (!slide || !source || slide.elements.length >= 300) return { model: deck, elementId: '' };
  const copy = clampElement({ ...source, id: createId(), x: source.x + 2, y: source.y + 2 } as DeckElement);
  return {
    model: updateSlide(deck, slideId, { elements: [...slide.elements, copy] }),
    elementId: copy.id,
  };
}

/** The slide with one element's box replaced; used for the live drag preview. Pure. */
export function slideWithElementBounds(
  slide: DeckSlide,
  elementId: string,
  bounds: ElementBounds & { flip?: boolean },
): DeckSlide {
  return {
    ...slide,
    elements: slide.elements.map((element) =>
      element.id === elementId ? ({ ...element, ...bounds } as DeckElement) : element,
    ),
  };
}

/** Set or clear the slide background image. */
export function setSlideBackgroundImage(
  model: AnyDeckModel,
  slideId: string,
  image: DeckSlide['backgroundImage'] | null,
): DeckModel {
  const deck = lift(model);
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return deck;
  const { backgroundImage: _dropped, ...rest } = slide;
  const next: DeckSlide = image ? { ...rest, backgroundImage: image } : rest;
  return withSlides(
    deck,
    deck.slides.map((candidate) => (candidate.id === slideId ? next : candidate)),
  );
}
