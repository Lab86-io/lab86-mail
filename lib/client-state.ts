'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Capacity } from './albatross/today';
import { DEFAULT_MAIL_QUERY } from './mail/search/constants';
import { migratePrimaryView, type PrimaryView } from './shared/types';

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
  // The area whose home page the 'areas' surface shows. Persisted like
  // primaryView so a reload lands back on the same area; null = the chooser.
  selectedAreaId: string | null;
  // Opening Work replaces the Area body while keeping Areas as the primary
  // navigation context. Persisted so a refresh returns to the same Work.
  selectedWorkId: string | null;
  // A one-shot request to open a specific intent on the Plans surface. The
  // Area Brief's capture bar sets this after creating an area-bound intent;
  // AppShell consumes it (switch to Plans + select) and clears it. Transient,
  // never persisted.
  pendingOpenIntentId: string | null;
  pendingOpenWorkId: string | null;
  searchDraft: string;
  nlSearchIntent: string | null;
  translatedQuery: string | null;
  querySource: 'default' | 'typed' | 'natural_language' | 'category';
  queryError: string | null;
  selectedThreadId: string | null;
  selectedIds: string[];
  paletteOpen: boolean;
  // Set by any surface that wants the capture takeover — the rail, an empty
  // state, a shortcut. The launcher owns the overlay; this is only the door.
  captureOpen: boolean;
  // Text the capture sheet should open with — a mail thread the user pointed
  // at, or a selection they highlighted. Transient; never persisted.
  captureSeed: string | null;
  // The column board is an optional lens, off by default. It used to be a
  // top-level surface, which made it a second system to maintain.
  boardSurfaceEnabled: boolean;
  // The user's own statement about the day. It changes how much Today puts in
  // front of them; it never changes what they are allowed to see.
  capacity: Capacity;
  // When the user last opened Albatross. Coming back after a while gets a
  // different first screen — never a wall of accumulated overdue work.
  lastSeenAt: number | null;
  compose: ComposeState;
  // Exact attachment blobs staged for the next composer (Undo Send or a
  // brief-generated deliverable). Transient by design; the composer persists
  // them with the draft as soon as it opens.
  composeRecoveredFiles: File[];
  shortcutsOpen: boolean;
  rightRailOpen: boolean;
  railOpen: boolean;
  railWidth: number;
  aiBarOpen: boolean;
  chatScopeKind: 'global' | 'area' | 'work';
  chatScopeAreaId: string | null;
  chatScopeWorkId: string | null;
  // Reader takes over (almost) the whole window; not persisted.
  threadFullscreen: boolean;
  // Persisted id of the most recent AI chat session, so reopening the app
  // restores the last conversation instead of starting blank.
  lastChatId: string | null;
  // When the last chat had activity; stale sessions aren't auto-restored.
  lastChatAt: number | null;
  pendingReplyBody: string | null;
  // Arc-style accent theming: one OKLCH hue + chroma pair drives the whole
  // accent family (see globals.css). null = the default forest green.
  accentHue: number | null;
  accentChroma: number | null;
  // Second accent: the editorial pairing (headers, tags, hairline-accent
  // lines). null = the default terracotta pair; presets write curated pairs
  // from lib/theme/palette-presets.ts.
  accent2Hue: number | null;
  accent2Chroma: number | null;
  // Third accent: the highlight voice (badges, lanes, stat deltas). null =
  // the default slate blue; the palette wheel writes chord positions from
  // lib/theme/palette-presets.ts.
  accent3Hue: number | null;
  accent3Chroma: number | null;
  // Background hue is its own axis, decoupled from the accent.
  bgHue: number | null;
  // 0..1 how much of bgHue bleeds into the background surfaces.
  surfaceTint: number;
  // Depth ladder spread (0.4 flat … 1.6 deep); 1 = the stock ladder. Scales
  // how far well/card/float surfaces sit from the paper and shadow weight.
  depthSpread: number;
  // 0..1 Arc-style gradient wash on the rail.
  washOpacity: number;
  // 0..1 accent-tinted wash over the main background, independent of the rail.
  bgWashOpacity: number;
  // 0..~0.3 film-grain overlay opacity.
  grainOpacity: number;
  // Grain tile size in px (60 fine … 240 coarse); smaller = higher resolution.
  grainScale: number;
  // UI font: null/sans = Geist, 'serif' = Fraunces, 'news' = Averia Serif Libre.
  appFont: 'sans' | 'serif' | 'news' | 'instrument' | 'grotesk' | null;

  setAccount: (account: string) => void;
  setAccountFilter: (accountIds: string[]) => void;
  setPrimaryView: (view: PrimaryView) => void;
  setThreadAccount: (account: string | null) => void;
  setPrimaryAccount: (account: string) => void;
  setQuery: (query: string) => void;
  setSmartCategory: (category: string | null) => void;
  setSelectedAreaId: (areaId: string | null) => void;
  setSelectedWorkId: (workId: string | null) => void;
  setPendingOpenIntentId: (intentId: string | null) => void;
  setPendingOpenWorkId: (workId: string | null) => void;
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
  setCaptureOpen: (open: boolean) => void;
  openCaptureWith: (seed: string) => void;
  setBoardSurfaceEnabled: (enabled: boolean) => void;
  setCapacity: (capacity: Capacity) => void;
  markSeen: () => void;
  openComposeNew: (prefill?: ComposePrefill) => void;
  openComposeReply: (input: {
    mode: 'reply' | 'reply_all' | 'forward';
    threadId: string;
    messageId: string;
    account: string;
    prefill?: ComposePrefill;
  }) => void;
  closeCompose: () => void;
  setComposeRecoveredFiles: (files: File[]) => void;
  setShortcutsOpen: (open: boolean) => void;
  setRightRailOpen: (open: boolean) => void;
  setRailOpen: (open: boolean) => void;
  setRailWidth: (width: number) => void;
  setAiBarOpen: (open: boolean) => void;
  setChatScope: (scope: {
    kind: 'global' | 'area' | 'work';
    areaId?: string | null;
    workId?: string | null;
  }) => void;
  setThreadFullscreen: (full: boolean) => void;
  setLastChatId: (id: string | null) => void;
  setPendingReplyBody: (body: string | null) => void;
  setAccent: (hue: number | null, chroma: number | null) => void;
  setAccent2: (hue: number | null, chroma: number | null) => void;
  setAccent3: (hue: number | null, chroma: number | null) => void;
  setBgHue: (hue: number | null) => void;
  setSurfaceTint: (tint: number) => void;
  setDepthSpread: (spread: number) => void;
  setWashOpacity: (opacity: number) => void;
  setBgWashOpacity: (opacity: number) => void;
  setGrainOpacity: (opacity: number) => void;
  setGrainScale: (px: number) => void;
  setAppFont: (font: 'sans' | 'serif' | 'news' | 'instrument' | 'grotesk' | null) => void;
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

/**
 * One capture door per screen. The expanded desktop rail already shows the
 * capture button, so the floating pill hides; a collapsed rail or the mobile
 * off-canvas drawer brings the pill back. The assistant panel owns the
 * bottom-right slot while it is open.
 */
export function capturePillHidden(
  aiBarOpen: boolean,
  railOpen: boolean,
  isMobile: boolean,
  readerOpen = false,
): boolean {
  // An open reader carries its own capture door ("This is an Albatross") in
  // its action bar, which sits in the same bottom-right corner.
  return aiBarOpen || readerOpen || (railOpen && !isMobile);
}

export function migratePersistedClientState(persisted: any) {
  if (!persisted) return persisted;
  persisted.account = '';
  if (persisted.query === '-in:trash newer_than:365d') persisted.query = DEFAULT_QUERY;
  if (persisted.smartCategory === 'waiting') persisted.smartCategory = 'review';
  // Every earlier view name maps forward. An unknown value lands on Today
  // rather than on a blank pane.
  persisted.primaryView = migratePrimaryView(persisted.primaryView) ?? 'today';
  return persisted;
}

/**
 * What survives a reload. Anything absent here is deliberately transient:
 * `captureOpen` is a one-shot request, not a preference, and restoring it
 * would open the capture takeover over a cold start.
 */
export function persistedClientState(s: ClientState) {
  return {
    account: s.account,
    primaryView: s.primaryView,
    boardSurfaceEnabled: s.boardSurfaceEnabled,
    capacity: s.capacity,
    lastSeenAt: s.lastSeenAt,
    query: s.query,
    smartCategory: s.smartCategory,
    selectedAreaId: s.selectedAreaId,
    selectedWorkId: s.selectedWorkId,
    rightRailOpen: s.rightRailOpen,
    railOpen: s.railOpen,
    railWidth: s.railWidth,
    lastChatId: s.lastChatId,
    lastChatAt: s.lastChatAt,
    accentHue: s.accentHue,
    accentChroma: s.accentChroma,
    accent2Hue: s.accent2Hue,
    accent2Chroma: s.accent2Chroma,
    accent3Hue: s.accent3Hue,
    accent3Chroma: s.accent3Chroma,
    bgHue: s.bgHue,
    surfaceTint: s.surfaceTint,
    depthSpread: s.depthSpread,
    washOpacity: s.washOpacity,
    bgWashOpacity: s.bgWashOpacity,
    grainOpacity: s.grainOpacity,
    grainScale: s.grainScale,
    appFont: s.appFont,
  };
}

export const useClientStore = create<ClientState>()(
  persist(
    (set) => ({
      account: '',
      accountFilter: [],
      primaryView: 'today',
      threadAccount: null,
      primaryAccount: '',
      query: DEFAULT_QUERY,
      smartCategory: 'main',
      selectedAreaId: null,
      selectedWorkId: null,
      pendingOpenIntentId: null,
      pendingOpenWorkId: null,
      searchDraft: '',
      nlSearchIntent: null,
      translatedQuery: null,
      querySource: 'category',
      queryError: null,
      selectedThreadId: null,
      selectedIds: [],
      paletteOpen: false,
      captureOpen: false,
      captureSeed: null,
      boardSurfaceEnabled: false,
      capacity: 'normal',
      lastSeenAt: null,
      compose: initialCompose,
      composeRecoveredFiles: [],
      shortcutsOpen: false,
      rightRailOpen: true,
      railOpen: true,
      railWidth: 240,
      aiBarOpen: false,
      chatScopeKind: 'global',
      chatScopeAreaId: null,
      chatScopeWorkId: null,
      threadFullscreen: false,
      lastChatId: null,
      lastChatAt: null,
      pendingReplyBody: null,
      accentHue: null,
      accentChroma: null,
      accent2Hue: null,
      accent2Chroma: null,
      accent3Hue: null,
      accent3Chroma: null,
      bgHue: null,
      surfaceTint: 0,
      depthSpread: 1,
      washOpacity: 0,
      bgWashOpacity: 0,
      grainOpacity: 0,
      grainScale: 140,
      appFont: null,

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
      setSelectedAreaId: (selectedAreaId) => set({ selectedAreaId }),
      setSelectedWorkId: (selectedWorkId) => set({ selectedWorkId }),
      setPendingOpenIntentId: (pendingOpenIntentId) => set({ pendingOpenIntentId }),
      setPendingOpenWorkId: (pendingOpenWorkId) => set({ pendingOpenWorkId }),
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
      setCaptureOpen: (captureOpen) => set({ captureOpen, ...(captureOpen ? {} : { captureSeed: null }) }),
      openCaptureWith: (captureSeed) => set({ captureSeed, captureOpen: true }),
      setBoardSurfaceEnabled: (boardSurfaceEnabled) => set({ boardSurfaceEnabled }),
      setCapacity: (capacity) => set({ capacity }),
      markSeen: () => set({ lastSeenAt: Date.now() }),
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
      setComposeRecoveredFiles: (composeRecoveredFiles) => set({ composeRecoveredFiles }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setRightRailOpen: (rightRailOpen) => set({ rightRailOpen }),
      setRailOpen: (railOpen) => set({ railOpen }),
      setRailWidth: (railWidth) => set({ railWidth }),
      setAiBarOpen: (aiBarOpen) => set({ aiBarOpen }),
      setChatScope: ({ kind, areaId, workId }) =>
        set({ chatScopeKind: kind, chatScopeAreaId: areaId || null, chatScopeWorkId: workId || null }),
      setThreadFullscreen: (threadFullscreen) => set({ threadFullscreen }),
      setLastChatId: (lastChatId) => set({ lastChatId, lastChatAt: lastChatId ? Date.now() : null }),
      setPendingReplyBody: (pendingReplyBody) => set({ pendingReplyBody }),
      setAccent: (accentHue, accentChroma) => set({ accentHue, accentChroma }),
      setAccent2: (accent2Hue, accent2Chroma) => set({ accent2Hue, accent2Chroma }),
      setAccent3: (accent3Hue, accent3Chroma) => set({ accent3Hue, accent3Chroma }),
      setBgHue: (bgHue) => set({ bgHue }),
      setSurfaceTint: (surfaceTint) => set({ surfaceTint }),
      setDepthSpread: (depthSpread) => set({ depthSpread }),
      setWashOpacity: (washOpacity) => set({ washOpacity }),
      setBgWashOpacity: (bgWashOpacity) => set({ bgWashOpacity }),
      setGrainOpacity: (grainOpacity) => set({ grainOpacity }),
      setGrainScale: (grainScale) => set({ grainScale }),
      setAppFont: (appFont) => set({ appFont }),
    }),
    {
      name: PERSIST_KEY,
      version: 5,
      // A previous build mapped an empty/cleared search to All Mail
      // (-in:trash …), which got persisted; reset that stale value so the
      // default view is the unified inbox again.
      migrate: (persisted: any) => {
        return migratePersistedClientState(persisted);
      },
      partialize: persistedClientState,
    },
  ),
);
