'use client';

import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DeckElement } from '../deck-model';
import {
  BOX_HANDLES,
  type BoxHandle,
  type Guide,
  handleCursor,
  handlePosition,
  LINE_HANDLES,
  type LineBounds,
  type LineHandle,
  lineEndpoints,
} from './canvas-math';

/**
 * The selection frame over the slide: an outline, eight resize handles for
 * a box or two end handles for a line, and the snap guides while a drag is
 * in progress. Drawn beside the slide, not inside it, so handles on the
 * slide edge are not clipped.
 */

const HANDLE_NAMES: Record<BoxHandle, string> = {
  n: 'top',
  s: 'bottom',
  e: 'right',
  w: 'left',
  ne: 'top right',
  nw: 'top left',
  se: 'bottom right',
  sw: 'bottom left',
};

export function SelectionOverlay({
  element,
  bounds,
  guides,
  readOnly = false,
  onHandlePointerDown,
}: {
  element: DeckElement;
  bounds: LineBounds;
  guides: Guide[];
  readOnly?: boolean;
  onHandlePointerDown?: (handle: BoxHandle | LineHandle, event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const locked = Boolean(element.locked) || readOnly;
  const press = (handle: BoxHandle | LineHandle) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (locked) return;
    // Keep focus on the element so arrow keys still nudge it after a resize.
    event.preventDefault();
    onHandlePointerDown?.(handle, event);
  };
  return (
    <div className="deck-overlay" aria-hidden="true">
      {guides.map((guide) => (
        <div
          key={`${guide.axis}-${guide.at}`}
          className="deck-guide"
          data-axis={guide.axis}
          style={guide.axis === 'x' ? { left: `${guide.at}%` } : { top: `${guide.at}%` }}
        />
      ))}
      {element.type === 'line' ? (
        <>
          <svg
            className="deck-overlay-line"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <line
              x1={lineEndpoints(bounds).start.x}
              y1={lineEndpoints(bounds).start.y}
              x2={lineEndpoints(bounds).end.x}
              y2={lineEndpoints(bounds).end.y}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {LINE_HANDLES.map((handle) => {
            const point = lineEndpoints(bounds)[handle];
            return (
              <button
                key={handle}
                type="button"
                tabIndex={-1}
                className="deck-handle"
                data-handle={handle}
                data-locked={locked ? 'true' : undefined}
                aria-label={`Move the ${handle} of the line`}
                style={{ left: `${point.x}%`, top: `${point.y}%`, cursor: locked ? 'default' : 'move' }}
                onPointerDown={press(handle)}
              />
            );
          })}
        </>
      ) : (
        <div
          className="deck-selection"
          data-locked={locked ? 'true' : undefined}
          style={{
            left: `${bounds.x}%`,
            top: `${bounds.y}%`,
            width: `${bounds.width}%`,
            height: `${bounds.height}%`,
            ...(element.rotation ? { transform: `rotate(${element.rotation}deg)` } : {}),
          }}
        >
          {locked
            ? null
            : BOX_HANDLES.map((handle) => {
                const at = handlePosition(handle);
                return (
                  <button
                    key={handle}
                    type="button"
                    tabIndex={-1}
                    className="deck-handle"
                    data-handle={handle}
                    aria-label={`Resize from the ${HANDLE_NAMES[handle]}`}
                    style={{
                      left: `${at.x}%`,
                      top: `${at.y}%`,
                      cursor: handleCursor(handle, element.rotation ?? 0),
                    }}
                    onPointerDown={press(handle)}
                  />
                );
              })}
        </div>
      )}
    </div>
  );
}
