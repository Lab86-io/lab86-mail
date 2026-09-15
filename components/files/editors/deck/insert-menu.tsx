'use client';

import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

export function InsertMenu({
  rich,
  disabled = false,
  onInsert,
  onPickImage,
}: {
  rich: boolean;
  disabled?: boolean;
  onInsert: (type: Exclude<DeckElement['type'], 'image'>) => void;
  onPickImage: () => void;
}) {
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
