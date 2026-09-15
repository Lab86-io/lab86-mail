'use client';

import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DeckElement } from '../deck-model';

/**
 * One menu for every kind of element. Line, image and chart need the
 * version 2 model, so they appear only when rich authoring is on.
 */
export interface InsertMenuItem {
  type: DeckElement['type'];
  label: string;
}

/** The items the menu offers; the gate lives here so it can be tested without a DOM. */
export function insertMenuItems(rich: boolean): InsertMenuItem[] {
  const items: InsertMenuItem[] = [
    { type: 'text', label: 'Text' },
    { type: 'shape', label: 'Shape' },
  ];
  if (rich) {
    items.push(
      { type: 'line', label: 'Line' },
      { type: 'image', label: 'Image' },
      { type: 'chart', label: 'Chart' },
    );
  }
  return items;
}

/** Entries under the element list that open a picker instead of inserting at once. */
export interface InsertMenuAction {
  action: 'artwork';
  label: string;
}

export function insertMenuActions(rich: boolean): InsertMenuAction[] {
  return rich ? [{ action: 'artwork', label: 'Artwork' }] : [];
}

export function InsertMenu({
  rich,
  disabled = false,
  onInsert,
  onPickImage,
  onPickArtwork,
}: {
  rich: boolean;
  disabled?: boolean;
  onInsert: (type: Exclude<DeckElement['type'], 'image'>) => void;
  onPickImage: () => void;
  /** Opens the artwork panel; the panel imports and inserts. */
  onPickArtwork?: () => void;
}) {
  const actions = onPickArtwork ? insertMenuActions(rich) : [];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} aria-label="Insert">
          Insert
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Insert an element">
        {insertMenuItems(rich).map((item) => (
          <DropdownMenuItem
            key={item.type}
            onSelect={() => (item.type === 'image' ? onPickImage() : onInsert(item.type))}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
        {actions.length ? <DropdownMenuSeparator /> : null}
        {actions.map((item) => (
          <DropdownMenuItem key={item.action} onSelect={() => onPickArtwork?.()}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
