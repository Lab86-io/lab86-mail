'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ClientState {
  account: string;
  query: string;
  selectedThreadId: string | null;
  selectedIds: string[];
  paletteOpen: boolean;
  composeOpen: boolean;
  shortcutsOpen: boolean;
  rightRailOpen: boolean;

  setAccount: (account: string) => void;
  setQuery: (query: string) => void;
  setSelectedThread: (id: string | null) => void;
  toggleSelected: (id: string) => void;
  clearSelected: () => void;
  selectMany: (ids: string[]) => void;
  setPaletteOpen: (open: boolean) => void;
  setComposeOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setRightRailOpen: (open: boolean) => void;
}

export const useClientStore = create<ClientState>()(
  persist(
    (set) => ({
      account: '',
      query: 'in:inbox newer_than:30d',
      selectedThreadId: null,
      selectedIds: [],
      paletteOpen: false,
      composeOpen: false,
      shortcutsOpen: false,
      rightRailOpen: true,

      setAccount: (account) => set({ account }),
      setQuery: (query) => set({ query }),
      setSelectedThread: (selectedThreadId) => set({ selectedThreadId }),
      toggleSelected: (id) =>
        set((s) => ({
          selectedIds: s.selectedIds.includes(id)
            ? s.selectedIds.filter((x) => x !== id)
            : [...s.selectedIds, id],
        })),
      clearSelected: () => set({ selectedIds: [] }),
      selectMany: (ids) => set({ selectedIds: ids }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setComposeOpen: (composeOpen) => set({ composeOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setRightRailOpen: (rightRailOpen) => set({ rightRailOpen }),
    }),
    {
      name: 'mail-os-ui',
      partialize: (s) => ({ account: s.account, query: s.query, rightRailOpen: s.rightRailOpen }),
    },
  ),
);
