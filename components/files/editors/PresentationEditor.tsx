'use client';

import { ArrowDown, ArrowUp, Copy, Redo2, Trash2, Undo2, X } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { type AnyDeckModel, deckModelForSave } from '@/lib/documents/deck-versions';
import { isDeckV2AuthoringEnabledOnClient } from '@/lib/documents/editor-flags';
import type { AlbatrossDocumentModel, DeckTheme } from '@/lib/documents/model';
import { cn } from '@/lib/utils';
import { ArtworkPanel } from './deck/artwork-panel';
import {
  artworkPlacement,
  type DeckArtworkCandidate,
  type DeckArtworkQuery,
  type ImportedDeckArtwork,
  importDeckArtwork,
  notesWithArtworkCredit,
  searchDeckArtworks,
  uploadDeckAsset,
} from './deck/assets';
import {
  type BoxHandle,
  DRAG_START_PX,
  type Guide,
  type LineBounds,
  type LineHandle,
  moveBounds,
  moveLineEndpoint,
  nudgeStep,
  percentDelta,
  type Rect,
  resizeBounds,
  type SnapTargets,
  snapBounds,
  snapResize,
  snapTargets,
} from './deck/canvas-math';
import { SelectionOverlay } from './deck/canvas-overlay';
import { InsertMenu } from './deck/insert-menu';
import { DeckInspector } from './deck/inspector';
import {
  activeSlide,
  addElement,
  addSlide,
  createDeckId,
  createHistory,
  type DeckElement,
  type DeckModel,
  type DeckSlide,
  deckModelsEqual,
  deleteElement,
  deleteSlide,
  duplicateElement,
  duplicateSlide,
  type ElementPatch,
  findElement,
  moveSlide,
  nudgeElement,
  pushHistory,
  redoHistory,
  reorderElement,
  selectSlide,
  setSlideBackgroundImage,
  slideWithElementBounds,
  undoHistory,
  updateElement,
  updateSlide,
  updateTheme,
  upgradeDeckModel,
} from './deck-model';
import './document-editors.css';
import { SlideSurface } from './SlideRenderer';

/** Backward-compatible name: the canvas is the shared renderer with the deck theme applied. */
export function SlideCanvas({
  slide,
  theme,
  interactive = false,
  selected,
  onSelect,
  onEdit,
  readOnly = false,
}: {
  slide: DeckSlide;
  theme: DeckTheme;
  interactive?: boolean;
  selected?: string | null;
  onSelect?: (id: string) => void;
  onEdit?: (id: string) => void;
  readOnly?: boolean;
}) {
  return (
    <SlideSurface
      slide={slide}
      theme={theme}
      interactive={interactive}
      selected={selected}
      onSelect={onSelect}
      onEdit={onEdit}
      readOnly={readOnly}
    />
  );
}

function PresentationPlayer({ model, onClose }: { model: DeckModel; onClose: () => void }) {
  const [index, setIndex] = useState(
    Math.max(
      0,
      model.slides.findIndex((slide) => slide.id === model.activeSlideId),
    ),
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const focused = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);
  const move = (next: number) => setIndex(Math.max(0, Math.min(model.slides.length - 1, next)));
  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Presentation"
      className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-slate-950 p-0 text-white backdrop:bg-black"
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault();
          move(index + 1);
        }
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault();
          move(index - 1);
        }
        if (event.key === 'Home') {
          event.preventDefault();
          move(0);
        }
        if (event.key === 'End') {
          event.preventDefault();
          move(model.slides.length - 1);
        }
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-3 px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{model.slides[index].title}</span>
          <Button variant="ghost" aria-label="Exit presentation" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 place-items-center overflow-hidden p-3">
          <div className="w-full max-w-[min(1600px,calc((100dvh-120px)*16/9))]">
            <SlideCanvas slide={model.slides[index]} theme={model.theme} />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-center gap-3 p-3">
          <Button variant="ghost" disabled={index === 0} onClick={() => move(index - 1)}>
            Previous
          </Button>
          <span role="status" className="text-xs">
            Slide {index + 1} of {model.slides.length}
          </span>
          <Button
            variant="ghost"
            disabled={index === model.slides.length - 1}
            onClick={() => move(index + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

interface DragState {
  kind: 'move' | 'resize' | 'line';
  elementId: string;
  handle?: BoxHandle | LineHandle;
  startX: number;
  startY: number;
  rect: Rect;
  origin: LineBounds;
  targets: SnapTargets;
  minSize: number;
  moved: boolean;
  last?: LineBounds;
}

interface LiveDrag {
  elementId: string;
  bounds: LineBounds;
  guides: Guide[];
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

/** Search and import for the artwork panel; the defaults call the artwork routes. */
export interface DeckArtworkClient {
  search: (query: DeckArtworkQuery, signal?: AbortSignal) => Promise<DeckArtworkCandidate[]>;
  import: (candidate: DeckArtworkCandidate) => Promise<ImportedDeckArtwork>;
}

const defaultArtworkClient: DeckArtworkClient = {
  search: (query, signal) => searchDeckArtworks(query, undefined, signal),
  import: (candidate) => importDeckArtwork(candidate),
};

interface ArtworkTarget {
  /** The image element to replace, or null to insert a new one. */
  replace: string | null;
  focusKey: number;
}

export function PresentationEditor({
  model: stored,
  onChange,
  readOnly = false,
  richAuthoring,
  upload = uploadDeckAsset,
  artwork = defaultArtworkClient,
}: {
  model: AnyDeckModel;
  onChange: (model: AlbatrossDocumentModel) => void;
  readOnly?: boolean;
  /** Version 2 authoring: lines, images, charts, the theme panel and the full inspector. */
  richAuthoring?: boolean;
  /** Image upload; the default posts to the assets route. */
  upload?: typeof uploadDeckAsset;
  /** Artwork search and import; the defaults call the artwork routes. */
  artwork?: DeckArtworkClient;
}) {
  const rich = richAuthoring ?? isDeckV2AuthoringEnabledOnClient();
  const model = useMemo(() => upgradeDeckModel(stored), [stored]);
  const storedVersion = stored.version;
  const [history, setHistory] = useState(() => createHistory(model));
  const historyRef = useRef(history);
  const current = useRef(model);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [presenting, setPresenting] = useState(false);
  const [live, setLive] = useState<LiveDrag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [artworkTarget, setArtworkTarget] = useState<ArtworkTarget | null>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const slide = activeSlide(model);
  const object = slide.elements.find((element) => element.id === selected);
  const activeIndex = model.slides.findIndex((item) => item.id === slide.id);
  useEffect(() => {
    if (deckModelsEqual(model, current.current)) return;
    current.current = model;
    const next = createHistory(model);
    historyRef.current = next;
    setHistory(next);
    setSelected(null);
    setEditing(null);
  }, [model]);
  useEffect(() => {
    if (!editing) return;
    textField.current?.focus();
    textField.current?.select();
  }, [editing]);
  const publish = (next: typeof history) => {
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    current.current = next.present;
    onChange(deckModelForSave(next.present, storedVersion));
  };
  const change = (next: DeckModel, key?: string) => {
    if (readOnly || deckModelsEqual(current.current, next)) return;
    publish(pushHistory(historyRef.current, next, { key, now: Date.now() }));
  };
  const changeRef = useRef(change);
  useLayoutEffect(() => {
    changeRef.current = change;
  });
  const choose = (id: string) => {
    setSelected(null);
    setEditing(null);
    const next = selectSlide(current.current, id);
    if (next !== current.current) publish({ ...historyRef.current, present: next, lastKey: undefined });
  };
  const patchObject = (patch: ElementPatch, key?: string) => {
    if (object) change(updateElement(current.current, slide.id, object.id, patch), key);
  };
  const insert = (type: DeckElement['type']) => {
    const next = addElement(current.current, slide.id, type);
    change(next.model);
    setSelected(next.elementId);
    setEditing(null);
  };
  const duplicateSelected = () => {
    if (!object) return;
    const next = duplicateElement(current.current, slide.id, object.id);
    if (!next.elementId) return;
    change(next.model);
    setSelected(next.elementId);
  };
  const removeSelected = () => {
    if (!object || object.locked) return;
    change(deleteElement(current.current, slide.id, object.id));
    setSelected(null);
    setEditing(null);
  };
  const insertImage = async (file: File) => {
    setUploading(true);
    setNotice(null);
    try {
      const asset = await upload(file);
      // The slide may have changed during the upload: insert where the user is now.
      const deck = current.current;
      const next = addElement(deck, deck.activeSlideId, 'image', createDeckId, {
        image: {
          assetId: asset.assetId,
          src: asset.src,
          alt: file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '),
          ...(asset.aspect ? { aspect: asset.aspect } : {}),
        },
      });
      changeRef.current(next.model);
      setSelected(next.elementId);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };
  const openArtwork = (replace: string | null = null) => {
    setInspectorOpen(true);
    setArtworkTarget((target) => ({ replace, focusKey: (target?.focusKey ?? 0) + 1 }));
  };
  const replacing =
    rich && artworkTarget?.replace && object?.type === 'image' && object.id === artworkTarget.replace
      ? object
      : null;
  /* Place an imported artwork: a new image sized to its aspect, or the asset of the chosen image. */
  const placeArtwork = (asset: ImportedDeckArtwork, candidate: DeckArtworkCandidate) => {
    const deck = current.current;
    const slideId = deck.activeSlideId;
    const target = deck.slides.find((item) => item.id === slideId);
    if (!target) return;
    const credit = asset.attribution.credit || candidate.credit;
    const source = asset.attribution.source || candidate.source;
    const notes = notesWithArtworkCredit(target.notes, credit, source);
    const image = {
      assetId: asset.assetId,
      src: asset.src,
      ...(asset.aspect ? { aspect: asset.aspect } : {}),
      source: credit,
    };
    if (replacing && target.elements.some((element) => element.id === replacing.id)) {
      const alt = replacing.alt.trim() ? replacing.alt : asset.attribution.title || candidate.title;
      const next = updateElement(deck, slideId, replacing.id, { ...image, alt });
      change(updateSlide(next, slideId, { notes }));
      return;
    }
    const added = addElement(deck, slideId, 'image', createDeckId, {
      image: { ...image, alt: asset.attribution.title || candidate.title },
    });
    const placed = updateElement(added.model, slideId, added.elementId, {
      ...artworkPlacement(asset.aspect),
      source: credit,
    });
    change(updateSlide(placed, slideId, { notes }));
    setSelected(added.elementId);
    setEditing(null);
  };
  const backgroundArtwork = (asset: ImportedDeckArtwork) => {
    const deck = current.current;
    change(
      setSlideBackgroundImage(deck, deck.activeSlideId, {
        assetId: asset.assetId,
        src: asset.src,
        opacity: 1,
        focal: { x: 0.5, y: 0.5 },
      }),
    );
  };

  /* Pointer drags: move, resize and line ends. One undo step per drag. */
  const onDragMove = useCallback((event: PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dxPx = event.clientX - state.startX;
    const dyPx = event.clientY - state.startY;
    if (!state.moved && Math.hypot(dxPx, dyPx) < DRAG_START_PX) return;
    state.moved = true;
    const delta = percentDelta(state.rect, dxPx, dyPx);
    const result =
      state.kind === 'move'
        ? snapBounds(moveBounds(state.origin, delta), state.targets)
        : state.kind === 'resize'
          ? snapResize(
              resizeBounds(state.origin, state.handle as BoxHandle, delta, state.minSize),
              state.handle as BoxHandle,
              state.targets,
              undefined,
              state.minSize,
            )
          : moveLineEndpoint(state.origin, state.handle as LineHandle, delta, state.targets);
    state.last = result.bounds;
    setLive({ elementId: state.elementId, bounds: result.bounds, guides: result.guides });
  }, []);
  const endDrag = useCallback(() => {
    const state = drag.current;
    drag.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    setLive(null);
    if (state?.moved && state.last) {
      const deck = current.current;
      changeRef.current(updateElement(deck, deck.activeSlideId, state.elementId, { ...state.last }));
    }
  }, [onDragMove]);
  useEffect(() => () => endDrag(), [endDrag]);
  const beginDrag = (
    kind: DragState['kind'],
    elementId: string,
    event: ReactPointerEvent<HTMLElement>,
    handle?: BoxHandle | LineHandle,
  ) => {
    if (readOnly || event.button !== 0) return;
    const deck = current.current;
    const element = findElement(deck, deck.activeSlideId, elementId);
    if (!element || element.locked) return;
    const canvas =
      (event.currentTarget as HTMLElement).closest('[data-slide-canvas]') ??
      stage.current?.querySelector('[data-slide-canvas]');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const others = activeSlide(deck).elements.filter((candidate) => candidate.id !== elementId);
    drag.current = {
      kind,
      elementId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      origin: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        ...(element.type === 'line' ? { flip: element.flip } : {}),
      },
      targets: snapTargets(others),
      minSize: element.type === 'line' ? 0 : 1,
      moved: false,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };
  const onElementPointerDown = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (editing && editing !== id) setEditing(null);
    if (editing === id) return;
    setSelected(id);
    beginDrag('move', id, event);
  };
  const onHandlePointerDown = (handle: BoxHandle | LineHandle, event: ReactPointerEvent<HTMLElement>) => {
    if (!object) return;
    beginDrag(object.type === 'line' ? 'line' : 'resize', object.id, event, handle);
  };

  /* A press on the ground around the slide clears the selection. */
  useEffect(() => {
    const ground = stage.current;
    if (!ground) return;
    const clear = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.deck-element, .deck-handle, button, input, textarea, select, label, a')) return;
      setSelected(null);
      setEditing(null);
    };
    ground.addEventListener('pointerdown', clear);
    return () => ground.removeEventListener('pointerdown', clear);
  }, []);

  const canvasSlide = live ? slideWithElementBounds(slide, live.elementId, live.bounds) : slide;
  const overlayBounds: LineBounds | null = object
    ? live && live.elementId === object.id
      ? live.bounds
      : {
          x: object.x,
          y: object.y,
          width: object.width,
          height: object.height,
          ...(object.type === 'line' ? { flip: object.flip } : {}),
        }
    : null;

  return (
    <fieldset
      aria-label="Presentation editing workspace"
      disabled={readOnly}
      className="deck-editor-workspace m-0 flex h-full min-h-0 min-w-0 flex-col border-0 p-0"
      data-dragging={live ? 'true' : undefined}
      onKeyDown={(event) => {
        if (readOnly || event.defaultPrevented || event.nativeEvent.isComposing) return;
        const target = event.target as HTMLElement;
        const inField = target.matches(EDITABLE);
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          event.stopPropagation();
          publish(event.shiftKey ? redoHistory(historyRef.current) : undoHistory(historyRef.current));
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && object && !inField) {
          event.preventDefault();
          event.stopPropagation();
          duplicateSelected();
          return;
        }
        if (event.key === 'Escape' && !inField) {
          if (selected) {
            event.preventDefault();
            event.stopPropagation();
          }
          setSelected(null);
          setEditing(null);
          return;
        }
        if (!target.matches('button[data-element-id]') || !object) return;
        const step = nudgeStep(event.shiftKey);
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        if (moves[event.key]) {
          event.preventDefault();
          event.stopPropagation();
          if (!object.locked) change(nudgeElement(current.current, slide.id, object.id, ...moves[event.key]));
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          removeSelected();
        }
      }}
    >
      <div
        role="toolbar"
        aria-label="Presentation tools"
        className="deck-toolbar flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly || model.slides.length >= 500}
          onClick={() => {
            change(addSlide(current.current));
            setSelected(null);
            setEditing(null);
          }}
        >
          Add slide
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Duplicate slide"
          disabled={readOnly || model.slides.length >= 500}
          onClick={() => {
            change(duplicateSlide(current.current, slide.id));
            setSelected(null);
            setEditing(null);
          }}
        >
          <Copy className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Move slide earlier"
          disabled={readOnly || activeIndex === 0}
          onClick={() => change(moveSlide(current.current, slide.id, -1))}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Move slide later"
          disabled={readOnly || activeIndex === model.slides.length - 1}
          onClick={() => change(moveSlide(current.current, slide.id, 1))}
        >
          <ArrowDown className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete slide"
          disabled={readOnly || model.slides.length === 1}
          onClick={() => {
            change(deleteSlide(current.current, slide.id));
            setSelected(null);
            setEditing(null);
          }}
        >
          <Trash2 className="size-4" />
        </Button>
        <span className="mx-1 h-5 border-l border-[var(--color-border)]" />
        <InsertMenu
          rich={rich}
          disabled={readOnly || uploading || slide.elements.length >= 300}
          onInsert={insert}
          onPickImage={() => fileInput.current?.click()}
          onPickArtwork={rich ? () => openArtwork() : undefined}
        />
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          tabIndex={-1}
          aria-label="Image file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void insertImage(file);
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Undo"
          disabled={readOnly || !history.past.length}
          onClick={() => publish(undoHistory(historyRef.current))}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Redo"
          disabled={readOnly || !history.future.length}
          onClick={() => publish(redoHistory(historyRef.current))}
        >
          <Redo2 className="size-4" />
        </Button>
        {uploading ? (
          <span role="status" className="px-2 text-xs text-[var(--color-text-muted)]">
            Uploading the image
          </span>
        ) : null}
        {notice ? (
          <span role="alert" className="px-2 text-xs text-[var(--color-danger)]">
            {notice}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen((open) => !open)}
        >
          Inspector
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPresenting(true)}>
          Present
        </Button>
      </div>
      <div className="deck-workspace-body flex min-h-0 flex-1">
        <nav
          aria-label="Slides"
          className="deck-filmstrip flex shrink-0 gap-2 border-[var(--color-border)] bg-[var(--color-bg)] p-2"
        >
          {model.slides.map((item, index) => (
            <button
              type="button"
              key={item.id}
              aria-label={`Slide ${index + 1}: ${item.title}`}
              aria-current={item.id === slide.id ? 'true' : undefined}
              onClick={() => choose(item.id)}
              className={cn(
                'deck-thumbnail shrink-0 rounded-[var(--radius-control)] border p-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
                item.id === slide.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-control-hover)]'
                  : 'border-transparent hover:bg-[var(--color-control-hover)]',
              )}
            >
              <div aria-hidden="true" className="deck-thumbnail-art">
                <SlideCanvas slide={item} theme={model.theme} />
              </div>
              <span className="mt-1 block truncate px-1 text-[10px] text-[var(--color-text-muted)]">
                {index + 1} · {item.title}
              </span>
            </button>
          ))}
        </nav>
        <div ref={stage} className="deck-stage min-w-0">
          <div className="deck-stage-inner">
            <div className="deck-slide-frame">
              <SlideSurface
                slide={canvasSlide}
                theme={model.theme}
                interactive
                selected={selected}
                onSelect={(id) => setSelected(id)}
                onEdit={(id) => {
                  const element = slide.elements.find((candidate) => candidate.id === id);
                  if (element?.type === 'text' && !element.locked) {
                    setSelected(id);
                    setEditing(id);
                  }
                }}
                readOnly={readOnly}
                editing={editing}
                onTextChange={(id, text) =>
                  change(updateElement(current.current, slide.id, id, { text }), `text:${id}`)
                }
                onEditEnd={() => setEditing(null)}
                onElementPointerDown={onElementPointerDown}
                textFieldRef={textField}
              />
              {object && overlayBounds && editing !== object.id ? (
                <SelectionOverlay
                  element={object}
                  bounds={overlayBounds}
                  guides={live?.guides ?? []}
                  readOnly={readOnly}
                  onHandlePointerDown={onHandlePointerDown}
                />
              ) : null}
            </div>
            <label className="deck-notes">
              <span className="deck-notes-label">Speaker notes</span>
              <textarea
                aria-label="Speaker notes"
                className="control-field min-h-16 w-full resize-y p-2 text-sm"
                placeholder="Notes for the presenter. They do not show on the slide."
                disabled={readOnly}
                value={slide.notes || ''}
                onChange={(event) =>
                  change(
                    updateSlide(current.current, slide.id, { notes: event.target.value }),
                    `notes:${slide.id}`,
                  )
                }
              />
            </label>
          </div>
        </div>
        {inspectorOpen ? (
          <aside aria-label="Inspector" className="deck-inspector shrink-0">
            {rich && artworkTarget ? (
              <ArtworkPanel
                theme={model.theme}
                slideId={slide.id}
                readOnly={readOnly}
                placeLabel={replacing ? 'Replace image' : 'Place on slide'}
                focusKey={artworkTarget.focusKey}
                onPlace={placeArtwork}
                onBackground={backgroundArtwork}
                onClose={() => setArtworkTarget(null)}
                search={artwork.search}
                importArtwork={artwork.import}
              />
            ) : null}
            <DeckInspector
              model={model}
              slide={slide}
              element={object}
              rich={rich}
              readOnly={readOnly}
              onElementPatch={patchObject}
              onSlidePatch={(patch, key) => change(updateSlide(current.current, slide.id, patch), key)}
              onBackgroundImage={(image) => change(setSlideBackgroundImage(current.current, slide.id, image))}
              onDelete={removeSelected}
              onDuplicate={duplicateSelected}
              onReorder={(direction) => {
                if (object) change(reorderElement(current.current, slide.id, object.id, direction));
              }}
              onTheme={(theme) => change(updateTheme(current.current, theme))}
              upload={upload}
              onChooseArtwork={rich ? () => openArtwork() : undefined}
              onReplaceWithArtwork={
                rich && object?.type === 'image' ? () => openArtwork(object.id) : undefined
              }
            />
          </aside>
        ) : null}
      </div>
      {presenting ? <PresentationPlayer model={model} onClose={() => setPresenting(false)} /> : null}
    </fieldset>
  );
}
