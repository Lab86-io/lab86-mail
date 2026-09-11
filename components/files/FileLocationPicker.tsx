'use client';

import { ChevronDown, FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function FileLocationPicker({
  locations,
  value,
  onChange,
  onManage,
}: {
  locations: { id: string; label: string; needsAttention?: boolean }[];
  value: string;
  onChange: (value: string) => void;
  onManage: () => void;
}) {
  const current = locations.find((item) => item.id === value) ?? locations[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="File location"
          className="min-w-0 max-w-[min(100%,240px)]"
        >
          <FolderOpen className="size-3.5" />
          <span className="truncate">{current?.label ?? 'All files'}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {locations.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id} className="min-w-0">
              <span className="truncate">{item.label}</span>
              {item.needsAttention ? (
                <span className="ml-auto text-[10px] text-[var(--color-danger)]">Needs attention</span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage}>
          <Plus className="size-3.5" />
          Add a drive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
