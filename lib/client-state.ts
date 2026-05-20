'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ComposePrefill {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

export interface ClientState {
  account: string;
  query: string;
  selectedThreadId: string | null;
  selectedIds: string[];
  paletteOpen: boolean;
  composeOpen: boolean;
  composePrefill: ComposePrefill | null;
  shortcutsOpen: boolean;
  rightRailOpen: boolean;
  railOpen: boolean;
  aiBarOpen: boolean;
  pendingReplyBody: string | null;

  setAccount: (account: string) => void;
  setQuery: (query: string) => void;
  setSelectedThread: (id: string | null) => void;
  toggleSelected: (id: string) => void;
  clearSelected: () => void;
  selectMany: (ids: string[]) => void;
  setPaletteOpen: (open: boolean) => void;
  setComposeOpen: (open: boolean) => void;
  openCompose: (prefill?: ComposePrefill) => void;
  setShortcutsOpen: (open: boolean) => void;
  setRightRailOpen: (open: boolean) => void;
  setRailOpen: (open: boolean) => void;
  setAiBarOpen: (open: boolean) => void;
  setPendingReplyBody: (body: string | null) => void;
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
      composePrefill: null,
      shortcutsOpen: false,
      rightRailOpen: true,
      railOpen: true,
      aiBarOpen: false,
      pendingReplyBody: null,

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
      setComposeOpen: (composeOpen) =>
        set((s) => ({ composeOpen, composePrefill: composeOpen ? s.composePrefill : null })),
      openCompose: (prefill) => set({ composeOpen: true, composePrefill: prefill ?? null }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setRightRailOpen: (rightRailOpen) => set({ rightRailOpen }),
      setRailOpen: (railOpen) => set({ railOpen }),
      setAiBarOpen: (aiBarOpen) => set({ aiBarOpen }),
      setPendingReplyBody: (pendingReplyBody) => set({ pendingReplyBody }),
    }),
    {
      name: 'mail-os-ui',
      partialize: (s) => ({
        account: s.account,
        query: s.query,
        rightRailOpen: s.rightRailOpen,
        railOpen: s.railOpen,
      }),
    },
  ),
);
