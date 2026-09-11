/**
 * Pure presentation-model helpers: slide identity, selection correction,
 * bounded element layout and a small coalescing undo history. No React/DOM.
 * All geometry is percent of the slide; fonts are sized against a 960-wide
 * reference so text scales with the canvas, never the viewport.
 */
import type { AlbatrossDocumentModel, DeckElement, DeckSlide } from '@/lib/documents/model';

export type DeckModel = Extract<AlbatrossDocumentModel, { kind: 'deck' }>;
export type ElementBounds = Pick<DeckElement, 'x' | 'y' | 'width' | 'height'>;

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

/** Keep an element fully inside the slide with a usable minimum size. */
export function clampElementBounds(bounds: ElementBounds): ElementBounds {
  const width = round(
    Math.min(100, Math.max(MIN_ELEMENT_SIZE, Number.isFinite(bounds.width) ? bounds.width : 1)),
  );
  const height = round(
    Math.min(100, Math.max(MIN_ELEMENT_SIZE, Number.isFinite(bounds.height) ? bounds.height : 1)),
  );
  const x = Math.min(100 - width, Math.max(0, Number.isFinite(bounds.x) ? bounds.x : 0));
  const y = Math.min(100 - height, Math.max(0, Number.isFinite(bounds.y) ? bounds.y : 0));
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

export function clampFontSize(value: number) {
  return Math.min(160, Math.max(8, Number.isFinite(value) ? Math.round(value) : 16));
}

/** CSS font size that follows the slide container's width (container query units). */
export function fontSizeForCanvas(fontSize: number | undefined) {
  const size = clampFontSize(fontSize ?? 16);
  return `${round((size / SLIDE_REFERENCE_WIDTH) * 100)}cqw`;
}

export function activeSlide(model: DeckModel): DeckSlide {
  return model.slides.find((slide) => slide.id === model.activeSlideId) || model.slides[0];
}

export function slideIndex(model: DeckModel, slideId: string) {
  return model.slides.findIndex((slide) => slide.id === slideId);
}

function withSlides(model: DeckModel, slides: DeckSlide[], activeSlideId = model.activeSlideId): DeckModel {
  return { ...model, activeSlideId, slides };
}

export function updateSlide(model: DeckModel, slideId: string, patch: Partial<DeckSlide>): DeckModel {
  return withSlides(
    model,
    model.slides.map((slide) => (slide.id === slideId ? { ...slide, ...patch, id: slide.id } : slide)),
  );
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
export function addSlide(model: DeckModel, createId: () => string = createDeckId): DeckModel {
  const index = slideIndex(model, model.activeSlideId);
  const slide = newSlide(createId(), model.slides.length + 1, createId);
  const slides = [...model.slides];
  slides.splice(index + 1, 0, slide);
  return withSlides(model, slides, slide.id);
}

/** Deep-copy a slide with new slide and element identities; select the copy. */
export function duplicateSlide(
  model: DeckModel,
  slideId: string,
  createId: () => string = createDeckId,
): DeckModel {
  const index = slideIndex(model, slideId);
  if (index < 0) return model;
  const source = model.slides[index];
  const copy: DeckSlide = {
    ...source,
    id: createId(),
    elements: source.elements.map((element) => ({ ...element, id: createId() })),
  };
  const slides = [...model.slides];
  slides.splice(index + 1, 0, copy);
  return withSlides(model, slides, copy.id);
}

/** Remove a slide; the selection moves to the neighbour that took its place. */
export function deleteSlide(model: DeckModel, slideId: string): DeckModel {
  const index = slideIndex(model, slideId);
  if (index < 0 || model.slides.length <= 1) return model;
  const slides = model.slides.filter((slide) => slide.id !== slideId);
  const activeSlideId =
    model.activeSlideId === slideId ? slides[Math.min(index, slides.length - 1)].id : model.activeSlideId;
  return withSlides(model, slides, activeSlideId);
}

export function moveSlide(model: DeckModel, slideId: string, direction: -1 | 1): DeckModel {
  const index = slideIndex(model, slideId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= model.slides.length) return model;
  const slides = [...model.slides];
  const [moved] = slides.splice(index, 1);
  slides.splice(target, 0, moved);
  return withSlides(model, slides);
}

export function selectSlide(model: DeckModel, slideId: string): DeckModel {
  if (slideId === model.activeSlideId || slideIndex(model, slideId) < 0) return model;
  return { ...model, activeSlideId: slideId };
}

export function newElement(type: DeckElement['type'], id: string, existingCount: number): DeckElement {
  const offset = Math.min(30, existingCount * 4);
  if (type === 'shape') {
    return clampElement({
      id,
      type: 'shape',
      role: 'shape',
      x: 30 + offset,
      y: 30 + offset,
      width: 24,
      height: 24,
      fill: '#DCE6F2',
    });
  }
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

export function clampElement(element: DeckElement): DeckElement {
  const next: DeckElement = { ...element, ...clampElementBounds(element) };
  if (next.fontSize !== undefined) next.fontSize = clampFontSize(next.fontSize);
  return next;
}

export function addElement(
  model: DeckModel,
  slideId: string,
  type: DeckElement['type'],
  createId: () => string = createDeckId,
): { model: DeckModel; elementId: string } {
  const slide = model.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return { model, elementId: '' };
  const element = newElement(type, createId(), slide.elements.length);
  return {
    model: updateSlide(model, slideId, { elements: [...slide.elements, element] }),
    elementId: element.id,
  };
}

/**
 * Patch an element, clamping geometry and font size. A title element's text
 * also keeps the slide title in step so the filmstrip and outline stay honest.
 */
export function updateElement(
  model: DeckModel,
  slideId: string,
  elementId: string,
  patch: Partial<Omit<DeckElement, 'id' | 'type'>>,
): DeckModel {
  const slide = model.slides.find((candidate) => candidate.id === slideId);
  const current = slide?.elements.find((element) => element.id === elementId);
  if (!slide || !current) return model;
  const element = clampElement({ ...current, ...patch });
  const slidePatch: Partial<DeckSlide> = {
    elements: slide.elements.map((candidate) => (candidate.id === elementId ? element : candidate)),
  };
  if (element.role === 'title' && patch.text !== undefined) slidePatch.title = element.text || slide.title;
  return updateSlide(model, slideId, slidePatch);
}

export function nudgeElement(
  model: DeckModel,
  slideId: string,
  elementId: string,
  dx: number,
  dy: number,
): DeckModel {
  const element = model.slides
    .find((candidate) => candidate.id === slideId)
    ?.elements.find((candidate) => candidate.id === elementId);
  if (!element) return model;
  return updateElement(model, slideId, elementId, { x: element.x + dx, y: element.y + dy });
}

export function deleteElement(model: DeckModel, slideId: string, elementId: string): DeckModel {
  const slide = model.slides.find((candidate) => candidate.id === slideId);
  if (!slide?.elements.some((element) => element.id === elementId)) return model;
  return updateSlide(model, slideId, {
    elements: slide.elements.filter((element) => element.id !== elementId),
  });
}

function elementsEqual(left: DeckElement, right: DeckElement) {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    (left.text ?? undefined) === (right.text ?? undefined) &&
    (left.role ?? undefined) === (right.role ?? undefined) &&
    (left.fill ?? undefined) === (right.fill ?? undefined) &&
    (left.color ?? undefined) === (right.color ?? undefined) &&
    (left.fontSize ?? undefined) === (right.fontSize ?? undefined)
  );
}

/** Structural equality that ignores key order and undefined fields. */
export function deckModelsEqual(left: DeckModel | null | undefined, right: DeckModel | null | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.activeSlideId !== right.activeSlideId || left.slides.length !== right.slides.length) return false;
  return left.slides.every((slide, index) => {
    const other = right.slides[index];
    return (
      slide.id === other.id &&
      slide.title === other.title &&
      (slide.notes ?? undefined) === (other.notes ?? undefined) &&
      (slide.background ?? undefined) === (other.background ?? undefined) &&
      slide.elements.length === other.elements.length &&
      slide.elements.every((element, elementIndex) => elementsEqual(element, other.elements[elementIndex]))
    );
  });
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

/** Selection correction after any model change or external revision. */
export function resolveSelection(
  model: DeckModel,
  selection: { slideId: string; elementId: string | null },
): { slideId: string; elementId: string | null } {
  const slide = model.slides.find((candidate) => candidate.id === selection.slideId) || activeSlide(model);
  const elementId =
    selection.elementId && slide.elements.some((element) => element.id === selection.elementId)
      ? selection.elementId
      : null;
  return { slideId: slide.id, elementId };
}
