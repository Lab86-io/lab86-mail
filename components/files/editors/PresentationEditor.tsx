'use client';

import { ArrowDown, ArrowUp, Copy, Play, Plus, Redo2, Square, Trash2, Type, Undo2, X } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import type { AlbatrossDocumentModel, DeckElement, DeckSlide } from '@/lib/documents/model';
import { cn } from '@/lib/utils';
import {
  activeSlide,
  addElement,
  addSlide,
  createHistory,
  type DeckModel,
  deckModelsEqual,
  deleteElement,
  deleteSlide,
  duplicateSlide,
  fontSizeForCanvas,
  moveSlide,
  nudgeElement,
  pushHistory,
  redoHistory,
  selectSlide,
  slideColor,
  undoHistory,
  updateElement,
  updateSlide,
} from './deck-model';
import './document-editors.css';

function elementStyle(element: DeckElement): CSSProperties {
  return {
    left: `${element.x}%`,
    top: `${element.y}%`,
    width: `${element.width}%`,
    height: `${element.height}%`,
    fontSize: fontSizeForCanvas(element.fontSize || (element.role === 'title' ? 28 : 16)),
    color: slideColor(element.color, '#17202A'),
    fontWeight: element.role === 'title' ? 650 : 400,
    ...(element.type === 'shape'
      ? {
          backgroundColor: slideColor(element.fill, '#DCE6F2'),
          border: `1px solid ${slideColor(element.color, '#94A3B8')}`,
        }
      : {}),
  };
}

export function SlideCanvas({
  slide,
  interactive = false,
  selected,
  onSelect,
  onEdit,
  readOnly = false,
}: {
  slide: DeckSlide;
  interactive?: boolean;
  selected?: string | null;
  onSelect?: (id: string) => void;
  onEdit?: (id: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div
      className="deck-slide w-full"
      style={{ backgroundColor: slideColor(slide.background, '#FFFFFF') }}
      data-slide-canvas
    >
      {slide.elements.map((element, index) =>
        interactive ? (
          <button
            key={element.id}
            type="button"
            className="deck-element"
            data-element-id={element.id}
            aria-label={`${element.type === 'shape' ? 'Shape' : element.role || 'Text'} object ${index + 1}`}
            aria-pressed={selected === element.id}
            disabled={readOnly}
            data-selected={selected === element.id}
            style={elementStyle(element)}
            onClick={() => onSelect?.(element.id)}
            onFocus={() => onSelect?.(element.id)}
            onDoubleClick={() => onEdit?.(element.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onEdit?.(element.id);
              }
            }}
          >
            {element.type === 'text'
              ? element.text || (
                  <span className="opacity-40">{element.role === 'title' ? 'Title' : 'Text'}</span>
                )
              : null}
          </button>
        ) : (
          <div key={element.id} className="deck-element" style={elementStyle(element)}>
            {element.type === 'text' ? element.text : null}
          </div>
        ),
      )}
    </div>
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
            <SlideCanvas slide={model.slides[index]} />
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

export function PresentationEditor({
  model,
  onChange,
  readOnly = false,
}: {
  model: DeckModel;
  onChange: (model: AlbatrossDocumentModel) => void;
  readOnly?: boolean;
}) {
  const [history, setHistory] = useState(() => createHistory(model));
  const historyRef = useRef(history);
  const current = useRef(model);
  const [selected, setSelected] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const textField = useRef<HTMLTextAreaElement>(null);
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
  }, [model]);
  const publish = (next: typeof history) => {
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    current.current = next.present;
    onChange(next.present);
  };
  const change = (next: DeckModel, key?: string) => {
    if (readOnly || deckModelsEqual(current.current, next)) return;
    publish(pushHistory(historyRef.current, next, { key, now: Date.now() }));
  };
  const choose = (id: string) => {
    setSelected(null);
    const next = selectSlide(current.current, id);
    if (next !== current.current) publish({ ...historyRef.current, present: next, lastKey: undefined });
  };
  const patchObject = (patch: Partial<DeckElement>, key?: string) => {
    if (object) change(updateElement(current.current, slide.id, object.id, patch), key);
  };
  const insert = (type: DeckElement['type']) => {
    const next = addElement(current.current, slide.id, type);
    change(next.model);
    setSelected(next.elementId);
  };
  const editObject = (id: string) => {
    setSelected(id);
    requestAnimationFrame(() => {
      textField.current?.focus();
      textField.current?.select();
    });
  };
  return (
    <fieldset
      aria-label="Presentation editing workspace"
      disabled={readOnly}
      className="deck-editor-workspace m-0 flex h-full min-h-0 min-w-0 flex-col border-0 p-0"
      onKeyDown={(event) => {
        if (readOnly || event.defaultPrevented || event.nativeEvent.isComposing) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          event.stopPropagation();
          publish(event.shiftKey ? redoHistory(historyRef.current) : undoHistory(historyRef.current));
          return;
        }
        const target = event.target as HTMLElement;
        if (!target.matches('button[data-element-id]') || !object) return;
        const step = event.shiftKey ? 5 : 1;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        if (moves[event.key]) {
          event.preventDefault();
          event.stopPropagation();
          change(nudgeElement(current.current, slide.id, object.id, ...moves[event.key]));
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          change(deleteElement(current.current, slide.id, object.id));
          setSelected(null);
        }
      }}
    >
      <div
        role="toolbar"
        aria-label="Presentation tools"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2"
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly || model.slides.length >= 500}
          onClick={() => {
            change(addSlide(current.current));
            setSelected(null);
          }}
        >
          <Plus className="size-4" />
          Slide
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Duplicate slide"
          disabled={readOnly || model.slides.length >= 500}
          onClick={() => {
            change(duplicateSlide(current.current, slide.id));
            setSelected(null);
          }}
        >
          <Copy className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Move slide earlier"
          disabled={readOnly || activeIndex === 0}
          onClick={() => change(moveSlide(current.current, slide.id, -1))}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Move slide later"
          disabled={readOnly || activeIndex === model.slides.length - 1}
          onClick={() => change(moveSlide(current.current, slide.id, 1))}
        >
          <ArrowDown className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Delete slide"
          disabled={readOnly || model.slides.length === 1}
          onClick={() => {
            change(deleteSlide(current.current, slide.id));
            setSelected(null);
          }}
        >
          <Trash2 className="size-4" />
        </Button>
        <span className="mx-1 h-5 border-l border-[var(--color-border)]" />
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly || slide.elements.length >= 300}
          onClick={() => insert('text')}
        >
          <Type className="size-4" />
          Text
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly || slide.elements.length >= 300}
          onClick={() => insert('shape')}
        >
          <Square className="size-4" />
          Shape
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Undo"
          disabled={readOnly || !history.past.length}
          onClick={() => publish(undoHistory(historyRef.current))}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          aria-label="Redo"
          disabled={readOnly || !history.future.length}
          onClick={() => publish(redoHistory(historyRef.current))}
        >
          <Redo2 className="size-4" />
        </Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setPresenting(true)}>
          <Play className="size-3.5" />
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
              <div aria-hidden="true">
                <SlideCanvas slide={item} />
              </div>
              <span className="mt-1 block truncate px-1 text-[10px] text-[var(--color-text-muted)]">
                {index + 1} · {item.title}
              </span>
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="deck-canvas-padding mx-auto max-w-[1040px]">
            <div className="border border-slate-300 bg-white">
              <SlideCanvas
                slide={slide}
                interactive
                selected={selected}
                onSelect={setSelected}
                onEdit={editObject}
                readOnly={readOnly}
              />
            </div>
          </div>
          <section
            aria-label="Slide inspector"
            className="deck-canvas-padding mx-auto max-w-[1040px] space-y-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
                Slide title
                <input
                  aria-label="Slide title"
                  className="control-field mt-1 h-9 w-full px-2 text-sm"
                  disabled={readOnly}
                  value={slide.title}
                  onChange={(event) =>
                    change(
                      updateSlide(current.current, slide.id, { title: event.target.value }),
                      `title:${slide.id}`,
                    )
                  }
                />
              </label>
              <label className="text-xs text-[var(--color-text-muted)]">
                Background
                <input
                  type="color"
                  aria-label="Slide background"
                  className="mt-1 block h-9 w-12 rounded border border-[var(--color-border)] bg-transparent p-1"
                  disabled={readOnly}
                  value={slideColor(slide.background, '#FFFFFF')}
                  onChange={(event) =>
                    change(updateSlide(current.current, slide.id, { background: event.target.value }))
                  }
                />
              </label>
            </div>
            {object ? (
              <div className="space-y-3 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">
                    {object.type === 'shape' ? 'Shape' : 'Text'} · arrows move, Shift moves faster
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete object"
                    disabled={readOnly}
                    onClick={() => {
                      change(deleteElement(current.current, slide.id, object.id));
                      setSelected(null);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                {object.type === 'text' ? (
                  <textarea
                    ref={textField}
                    aria-label="Object text"
                    className="control-field min-h-20 w-full resize-y p-2 text-sm"
                    disabled={readOnly}
                    value={object.text || ''}
                    onChange={(event) => patchObject({ text: event.target.value }, `text:${object.id}`)}
                  />
                ) : null}
                <div className="grid grid-cols-4 gap-2">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <label key={field} className="text-[11px] capitalize text-[var(--color-text-muted)]">
                      {field} %
                      <input
                        type="number"
                        aria-label={`Object ${field}`}
                        className="control-field mt-1 h-9 w-full px-2 text-xs"
                        min={field === 'width' || field === 'height' ? 1 : 0}
                        max={100}
                        step={1}
                        disabled={readOnly}
                        value={object[field]}
                        onChange={(event) => patchObject({ [field]: Number(event.target.value) })}
                      />
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-4">
                  {object.type === 'text' ? (
                    <label className="text-xs text-[var(--color-text-muted)]">
                      Font size
                      <input
                        type="number"
                        aria-label="Object font size"
                        className="control-field mt-1 h-9 w-20 px-2 text-xs"
                        min={8}
                        max={160}
                        disabled={readOnly}
                        value={object.fontSize || (object.role === 'title' ? 28 : 16)}
                        onChange={(event) => patchObject({ fontSize: Number(event.target.value) })}
                      />
                    </label>
                  ) : (
                    <label className="text-xs text-[var(--color-text-muted)]">
                      Fill
                      <input
                        type="color"
                        aria-label="Shape fill"
                        className="mt-1 block h-9 w-12"
                        disabled={readOnly}
                        value={slideColor(object.fill, '#DCE6F2')}
                        onChange={(event) => patchObject({ fill: event.target.value })}
                      />
                    </label>
                  )}
                  <label className="text-xs text-[var(--color-text-muted)]">
                    {object.type === 'shape' ? 'Border' : 'Text color'}
                    <input
                      type="color"
                      aria-label="Object color"
                      className="mt-1 block h-9 w-12"
                      disabled={readOnly}
                      value={slideColor(object.color, object.type === 'shape' ? '#94A3B8' : '#17202A')}
                      onChange={(event) => patchObject({ color: event.target.value })}
                    />
                  </label>
                </div>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">
                Select text or a shape on the slide to edit it. Enter opens its text; arrow keys move the
                selected object.
              </p>
            )}
            <details>
              <summary className="cursor-pointer py-2 text-xs font-medium">
                Speaker notes{slide.notes ? ' · saved with this slide' : ''}
              </summary>
              <textarea
                aria-label="Speaker notes"
                className="control-field mt-2 min-h-24 w-full resize-y p-2 text-sm"
                disabled={readOnly}
                value={slide.notes || ''}
                onChange={(event) =>
                  change(
                    updateSlide(current.current, slide.id, { notes: event.target.value }),
                    `notes:${slide.id}`,
                  )
                }
              />
            </details>
          </section>
        </div>
      </div>
      {presenting ? <PresentationPlayer model={model} onClose={() => setPresenting(false)} /> : null}
    </fieldset>
  );
}
