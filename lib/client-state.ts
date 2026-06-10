'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MAIL_QUERY } from './mail/search/constants';
import type { PrimaryView } from './shared/types';

export interface ComposePrefill {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

export type ComposeMode = 'new' | 'reply' | 'reply_all' | 'forward';

export interface ComposeState {
  mode: ComposeMode | null;
  prefill: ComposePrefill | null;
  anchorThreadId: string | null;
  anchorMessageId: string | null;
  anchorAccount: string | null;
  // Bumped on each open so the inline composer's hooks can reset and re-seed
  // even when re-opened on the same anchor.
  nonce: number;
}

export interface ClientState {
  account: string;
  // Inbox account scope: empty array = all authed accounts (the default);
  // otherwise only the checked accountIds are fetched and merged.
  accountFilter: string[];
  primaryView: PrimaryView;
  // The concrete account that owns the currently-open thread. The inbox runs
  // unified ("all mailboxes"), but a thread's get/reply/archive need a real
  // account — this tracks it without collapsing the inbox view.
  threadAccount: string | null;
  // Primary authed account, resolved once accounts load; used as the "from"
  // for new compose when the inbox is in the unified view.
  primaryAccount: string;
  query: string;
  smartCategory: string | null;
  searchDraft: string;
  nlSearchIntent: string | null;
  translatedQuery: string | null;
  querySource: 'default' | 'typed' | 'natural_language' | 'category';
  queryError: string | null;
  selectedThreadId: string | null;
  selectedIds: string[];
  paletteOpen: boolean;
  compose: ComposeState;
  shortcutsOpen: boolean;
  rightRailOpen: boolean;
  railOpen: boolean;
  railWidth: number;
  aiBarOpen: boolean;
  pendingReplyBody: string | null;

  setAccount: (account: string) => void;
  setAccountFilter: (accountIds: string[]) => void;
  setPrimaryView: (view: PrimaryView) => void;
  setThreadAccount: (account: string | null) => void;
  setPrimaryAccount: (account: string) => void;
  setQuery: (query: string) => void;
  setSmartCategory: (category: string | null) => void;
  setSearchDraft: (draft: string) => void;
  setTranslatedSearch: (
    intent: string | null,
    translated: string | null,
    source: ClientState['querySource'],
  ) => void;
  setQueryError: (error: string | null) => void;
  setSelectedThread: (id: string | null) => void;
  toggleSelected: (id: string) => void;
  clearSelected: () => void;
  selectMany: (ids: string[]) => void;
  setPaletteOpen: (open: boolean) => void;
  openComposeNew: (prefill?: ComposePrefill) => void;
  openComposeReply: (input: {
    mode: 'reply' | 'reply_all' | 'forward';
    threadId: string;
    messageId: string;
    account: string;
    prefill?: ComposePrefill;
  }) => void;
  closeCompose: () => void;
  setShortcutsOpen: (open: boolean) => void;
  setRightRailOpen: (open: boolean) => void;
  setRailOpen: (open: boolean) => void;
  setRailWidth: (width: number) => void;
  setAiBarOpen: (open: boolean) => void;
  setPendingReplyBody: (body: string | null) => void;
}

const initialCompose: ComposeState = {
  mode: null,
  prefill: null,
  anchorThreadId: null,
  anchorMessageId: null,
  anchorAccount: null,
  nonce: 0,
};

const PERSIST_KEY = 'lab86-mail-ui';
const DEFAULT_QUERY = DEFAULT_MAIL_QUERY;

export const useClientStore = create<ClientState>()(
  persist(
    (set) => ({
      account: '',
      accountFilter: [],
      primaryView: 'daily_report',
      threadAccount: null,
      primaryAccount: '',
      query: DEFAULT_QUERY,
      smartCategory: 'main',
      searchDraft: '',
      nlSearchIntent: null,
      translatedQuery: null,
      querySource: 'category',
      queryError: null,
      selectedThreadId: null,
      selectedIds: [],
      paletteOpen: false,
      compose: initialCompose,
      shortcutsOpen: false,
      rightRailOpen: true,
      railOpen: true,
      railWidth: 240,
      aiBarOpen: false,
      pendingReplyBody: null,

      setAccount: (account) => set({ account }),
      setAccountFilter: (accountIds) => set({ accountFilter: accountIds }),
      setPrimaryView: (primaryView) => set({ primaryView }),
      setThreadAccount: (threadAccount) => set({ threadAccount }),
      setPrimaryAccount: (primaryAccount) => set({ primaryAccount }),
      setQuery: (query) =>
        set({
          primaryView: 'mail',
          query,
          smartCategory: null,
          searchDraft: '',
          nlSearchIntent: null,
          translatedQuery: null,
          queryError: null,
          querySource: query === DEFAULT_QUERY ? 'default' : 'typed',
        }),
      setSmartCategory: (smartCategory) =>
        set({
          primaryView: 'mail',
          smartCategory,
          query: DEFAULT_QUERY,
          searchDraft: '',
          nlSearchIntent: null,
          translatedQuery: null,
          queryError: null,
          querySource: smartCategory ? 'category' : 'typed',
        }),
      setSearchDraft: (searchDraft) => set({ searchDraft }),
      setTranslatedSearch: (nlSearchIntent, translatedQuery, querySource) =>
        set({ nlSearchIntent, translatedQuery, querySource, queryError: null }),
      setQueryError: (queryError) => set({ queryError }),
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
      openComposeNew: (prefill) =>
        set((s) => ({
          compose: {
            mode: 'new',
            prefill: prefill ?? null,
            anchorThreadId: null,
            anchorMessageId: null,
            anchorAccount: null,
            nonce: s.compose.nonce + 1,
          },
        })),
      openComposeReply: ({ mode, threadId, messageId, account, prefill }) =>
        set((s) => ({
          compose: {
            mode,
            prefill: prefill ?? null,
            anchorThreadId: threadId,
            anchorMessageId: messageId,
            anchorAccount: account,
            nonce: s.compose.nonce + 1,
          },
        })),
      closeCompose: () => set({ compose: { ...initialCompose } }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setRightRailOpen: (rightRailOpen) => set({ rightRailOpen }),
      setRailOpen: (railOpen) => set({ railOpen }),
      setRailWidth: (railWidth) => set({ railWidth }),
      setAiBarOpen: (aiBarOpen) => set({ aiBarOpen }),
      setPendingReplyBody: (pendingReplyBody) => set({ pendingReplyBody }),
    }),
    {
      name: PERSIST_KEY,
      version: 2,
      // A previous build mapped an empty/cleared search to All Mail
      // (-in:trash …), which got persisted; reset that stale value so the
      // default view is the unified inbox again.
      migrate: (persisted: any) => {
        if (!persisted) return persisted;
        persisted.account = '';
        if (persisted && persisted.query === '-in:trash newer_than:365d') {
          persisted.query = DEFAULT_QUERY;
        }
        return persisted;
      },
      partialize: (s) => ({
        account: s.account,
        primaryView: s.primaryView,
        query: s.query,
        smartCategory: s.smartCategory,
        rightRailOpen: s.rightRailOpen,
        railOpen: s.railOpen,
        railWidth: s.railWidth,
      }),
    },
  ),
);
