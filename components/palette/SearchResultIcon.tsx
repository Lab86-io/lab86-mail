'use client';

import { RAIL_SURFACE_ICONS } from '@/components/shell/navigation-icons';
import { FileTextIcon } from '@/components/ui/file-text';
import { FolderIcon } from '@/components/ui/folder';
import { HistoryIcon } from '@/components/ui/history';
import { LayoutGridIcon } from '@/components/ui/layout-grid';
import { RowIcon } from '@/components/ui/row-icon';
import { SettingsIcon } from '@/components/ui/settings';
import type { SearchTarget } from '@/lib/search/global-search';

export function searchResultIcon(target: SearchTarget) {
  if (target.kind === 'page') {
    if (target.view === 'areas') return FolderIcon;
    if (target.view === 'activity') return HistoryIcon;
    if (target.view in RAIL_SURFACE_ICONS)
      return RAIL_SURFACE_ICONS[target.view as keyof typeof RAIL_SURFACE_ICONS];
    return LayoutGridIcon;
  }
  if (target.kind === 'settings') return SettingsIcon;
  if (target.kind === 'mail') return RAIL_SURFACE_ICONS.mail;
  if (target.kind === 'calendar') return RAIL_SURFACE_ICONS.calendar;
  return FileTextIcon;
}

export function SearchResultIcon({ target, active }: { target: SearchTarget; active: boolean }) {
  return (
    <RowIcon
      icon={searchResultIcon(target)}
      size={16}
      active={active}
      className="text-[var(--color-text-muted)]"
    />
  );
}
