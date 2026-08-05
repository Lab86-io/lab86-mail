import { describe, expect, test } from 'bun:test';
import { persistedClientState, useClientStore } from '../lib/client-state';
import {
  isLab86AiDisabled,
  isOutboundSendDisabled,
  isPublicSignupDisabled,
  isSubscriptionServiceDisabled,
  isUserOpenRouterKeyRequired,
} from '../lib/hosted/controls';
import { DEFAULT_MAIL_QUERY as DEFAULT_QUERY } from '../lib/mail/search/constants';

// The store is what the surfaces agree through. These pin the doors the
// Albatross shell opened: one way to raise capture from anywhere, and one
// switch for the optional board.

describe('the capture door', () => {
  test('any surface can ask for it, and the launcher can close it again', () => {
    const store = useClientStore.getState();
    expect(store.captureOpen).toBe(false);

    store.setCaptureOpen(true);
    expect(useClientStore.getState().captureOpen).toBe(true);

    // The launcher owns the overlay; it lowers the flag once it has opened.
    useClientStore.getState().setCaptureOpen(false);
    expect(useClientStore.getState().captureOpen).toBe(false);
  });
});

describe('the optional board', () => {
  test('is off until the user turns it on', () => {
    expect(useClientStore.getState().boardSurfaceEnabled).toBe(false);
    useClientStore.getState().setBoardSurfaceEnabled(true);
    expect(useClientStore.getState().boardSurfaceEnabled).toBe(true);
    useClientStore.getState().setBoardSurfaceEnabled(false);
    expect(useClientStore.getState().boardSurfaceEnabled).toBe(false);
  });
});

describe('the primary view', () => {
  test('starts on Today', () => {
    // A new session lands on the day, not on the inbox.
    expect(useClientStore.getInitialState().primaryView).toBe('today');
  });

  test('opening an Albatross and choosing an area are separate moves', () => {
    const store = useClientStore.getState();
    store.setSelectedWorkId('work_abc');
    store.setPrimaryView('albatrosses');
    expect(useClientStore.getState().selectedWorkId).toBe('work_abc');
    expect(useClientStore.getState().primaryView).toBe('albatrosses');

    // Leaving the detail must not drop the surface underneath it.
    useClientStore.getState().setSelectedWorkId(null);
    expect(useClientStore.getState().selectedWorkId).toBeNull();
    expect(useClientStore.getState().primaryView).toBe('albatrosses');
  });

  test('a mail search always lands the user in Mail', () => {
    useClientStore.getState().setPrimaryView('today');
    useClientStore.getState().setQuery('is:unread');
    expect(useClientStore.getState().primaryView).toBe('mail');
    expect(useClientStore.getState().smartCategory).toBeNull();
  });
});

describe('the rest of the shell state', () => {
  // These setters back the chrome the Albatross shell relies on: the rail, the
  // reader, the composer, the assistant, and the theme. They were untested, so
  // a rename could silently break a surface without a red test anywhere.
  test('the rail remembers whether it is open and how wide', () => {
    const s = useClientStore.getState();
    s.setRailOpen(false);
    s.setRailWidth(320);
    expect(useClientStore.getState().railOpen).toBe(false);
    expect(useClientStore.getState().railWidth).toBe(320);
    useClientStore.getState().setRailOpen(true);
    expect(useClientStore.getState().railOpen).toBe(true);
  });

  test('thread selection and multi-select are independent', () => {
    const s = useClientStore.getState();
    s.setSelectedThread('thread_1');
    s.toggleSelected('thread_1');
    s.toggleSelected('thread_2');
    expect(useClientStore.getState().selectedIds).toEqual(['thread_1', 'thread_2']);
    useClientStore.getState().toggleSelected('thread_1');
    expect(useClientStore.getState().selectedIds).toEqual(['thread_2']);
    useClientStore.getState().selectMany(['a', 'b']);
    expect(useClientStore.getState().selectedIds).toEqual(['a', 'b']);
    useClientStore.getState().clearSelected();
    expect(useClientStore.getState().selectedIds).toEqual([]);
    expect(useClientStore.getState().selectedThreadId).toBe('thread_1');
  });

  test('compose opens fresh, opens on a thread, and closes', () => {
    const s = useClientStore.getState();
    s.openComposeNew({ to: 'someone@example.com' });
    expect(useClientStore.getState().compose.mode).toBe('new');
    expect(useClientStore.getState().compose.prefill?.to).toBe('someone@example.com');

    useClientStore.getState().openComposeReply({
      mode: 'reply',
      threadId: 'thread_9',
      messageId: 'message_9',
      account: 'me@example.com',
    });
    const composing = useClientStore.getState().compose;
    expect(composing.mode).toBe('reply');
    expect(composing.anchorThreadId).toBe('thread_9');
    expect(composing.anchorMessageId).toBe('message_9');

    useClientStore.getState().closeCompose();
    expect(useClientStore.getState().compose.mode).toBeNull();
  });

  test('the assistant carries the scope it was opened from', () => {
    const s = useClientStore.getState();
    s.setChatScope({ kind: 'work', workId: 'work_5' });
    expect(useClientStore.getState().chatScopeKind).toBe('work');
    expect(useClientStore.getState().chatScopeWorkId).toBe('work_5');

    useClientStore.getState().setChatScope({ kind: 'area', areaId: 'area_2' });
    expect(useClientStore.getState().chatScopeKind).toBe('area');
    expect(useClientStore.getState().chatScopeAreaId).toBe('area_2');

    useClientStore.getState().setChatScope({ kind: 'global' });
    expect(useClientStore.getState().chatScopeKind).toBe('global');
  });

  test('search state records what the user typed and what it became', () => {
    const s = useClientStore.getState();
    s.setSearchDraft('gold dealer');
    s.setTranslatedSearch('find the gold dealer', 'from:dealer', 'natural_language');
    expect(useClientStore.getState().searchDraft).toBe('gold dealer');
    expect(useClientStore.getState().nlSearchIntent).toBe('find the gold dealer');
    expect(useClientStore.getState().translatedQuery).toBe('from:dealer');
    expect(useClientStore.getState().querySource).toBe('natural_language');

    useClientStore.getState().setQueryError('search unavailable');
    expect(useClientStore.getState().queryError).toBe('search unavailable');
  });

  test('the overlays each open and close on their own', () => {
    const s = useClientStore.getState();
    s.setPaletteOpen(true);
    s.setShortcutsOpen(true);
    s.setAiBarOpen(true);
    s.setThreadFullscreen(true);
    s.setRightRailOpen(false);
    const open = useClientStore.getState();
    expect(open.paletteOpen).toBe(true);
    expect(open.shortcutsOpen).toBe(true);
    expect(open.aiBarOpen).toBe(true);
    expect(open.threadFullscreen).toBe(true);
    expect(open.rightRailOpen).toBe(false);

    const next = useClientStore.getState();
    next.setPaletteOpen(false);
    next.setShortcutsOpen(false);
    next.setAiBarOpen(false);
    next.setThreadFullscreen(false);
    expect(useClientStore.getState().paletteOpen).toBe(false);
    expect(useClientStore.getState().aiBarOpen).toBe(false);
  });

  test('the one-shot open requests clear after they are consumed', () => {
    const s = useClientStore.getState();
    s.setPendingOpenIntentId('intent_1');
    s.setPendingOpenWorkId('work_1');
    expect(useClientStore.getState().pendingOpenIntentId).toBe('intent_1');
    expect(useClientStore.getState().pendingOpenWorkId).toBe('work_1');
    useClientStore.getState().setPendingOpenIntentId(null);
    useClientStore.getState().setPendingOpenWorkId(null);
    expect(useClientStore.getState().pendingOpenIntentId).toBeNull();
    expect(useClientStore.getState().pendingOpenWorkId).toBeNull();
  });

  test('the palette theme axes each move independently', () => {
    const s = useClientStore.getState();
    s.setAccent(140, 0.12);
    s.setAccent2(30, 0.1);
    s.setAccent3(250, 0.08);
    s.setBgHue(120);
    s.setSurfaceTint(0.4);
    s.setDepthSpread(1.2);
    s.setWashOpacity(0.3);
    s.setBgWashOpacity(0.2);
    s.setGrainOpacity(0.05);
    s.setGrainScale(120);
    s.setAppFont('serif');
    const theme = useClientStore.getState();
    expect(theme.accentHue).toBe(140);
    expect(theme.accent2Hue).toBe(30);
    expect(theme.accent3Hue).toBe(250);
    expect(theme.bgHue).toBe(120);
    expect(theme.surfaceTint).toBe(0.4);
    expect(theme.depthSpread).toBe(1.2);
    expect(theme.washOpacity).toBe(0.3);
    expect(theme.bgWashOpacity).toBe(0.2);
    expect(theme.grainOpacity).toBe(0.05);
    expect(theme.grainScale).toBe(120);
    expect(theme.appFont).toBe('serif');
  });

  test('mail account scope and the reply hand-off', () => {
    const s = useClientStore.getState();
    s.setAccount('me@example.com');
    s.setAccountFilter(['acc_1']);
    s.setPrimaryAccount('acc_1');
    s.setThreadAccount('me@example.com');
    s.setSmartCategory('orders');
    s.setSelectedAreaId('area_7');
    s.setPendingReplyBody('Thanks — sending it over now.');
    s.setLastChatId('chat_3');
    s.setComposeRecoveredFiles([]);
    const state = useClientStore.getState();
    expect(state.account).toBe('me@example.com');
    expect(state.accountFilter).toEqual(['acc_1']);
    expect(state.primaryAccount).toBe('acc_1');
    expect(state.threadAccount).toBe('me@example.com');
    expect(state.smartCategory).toBe('orders');
    expect(state.selectedAreaId).toBe('area_7');
    expect(state.pendingReplyBody).toBe('Thanks — sending it over now.');
    expect(state.lastChatId).toBe('chat_3');
    expect(state.lastChatAt).toBeGreaterThan(0);
  });
});

describe('what survives a reload', () => {
  test('the board switch persists; the capture request does not', () => {
    useClientStore.getState().setBoardSurfaceEnabled(true);
    useClientStore.getState().setCaptureOpen(true);
    const saved = persistedClientState(useClientStore.getState()) as Record<string, unknown>;

    expect(saved.boardSurfaceEnabled).toBe(true);
    // captureOpen is a one-shot request. Restoring it would drop the user into
    // the capture takeover on a cold start.
    expect('captureOpen' in saved).toBe(false);
    useClientStore.getState().setCaptureOpen(false);
    useClientStore.getState().setBoardSurfaceEnabled(false);
  });

  test('the surface, the open Albatross and the chosen area all come back', () => {
    const s = useClientStore.getState();
    s.setPrimaryView('albatrosses');
    s.setSelectedWorkId('work_42');
    s.setSelectedAreaId('area_3');
    const saved = persistedClientState(useClientStore.getState());
    expect(saved.primaryView).toBe('albatrosses');
    expect(saved.selectedWorkId).toBe('work_42');
    expect(saved.selectedAreaId).toBe('area_3');
  });

  test('the whole palette comes back, so a reload is not a re-theme', () => {
    const s = useClientStore.getState();
    s.setAccent(200, 0.11);
    s.setGrainScale(90);
    s.setAppFont('news');
    const saved = persistedClientState(useClientStore.getState());
    expect(saved.accentHue).toBe(200);
    expect(saved.accentChroma).toBe(0.11);
    expect(saved.grainScale).toBe(90);
    expect(saved.appFont).toBe('news');
    expect(saved.railWidth).toBeGreaterThan(0);
  });

  test('transient chrome is left behind on purpose', () => {
    const saved = persistedClientState(useClientStore.getState()) as Record<string, unknown>;
    for (const transient of [
      'paletteOpen',
      'shortcutsOpen',
      'aiBarOpen',
      'threadFullscreen',
      'selectedThreadId',
      'selectedIds',
      'compose',
      'pendingReplyBody',
      'pendingOpenWorkId',
    ]) {
      expect(transient in saved).toBe(false);
    }
  });
});

describe('hosted control flags', () => {
  test('each flag reads its own environment variable', () => {
    const previous = { ...process.env };
    try {
      process.env.LAB86_DISABLE_LAB86_AI = '1';
      process.env.LAB86_REQUIRE_USER_OPENROUTER_KEY = 'true';
      process.env.LAB86_DISABLE_SUBSCRIPTIONS = 'yes';
      delete process.env.LAB86_DISABLE_OUTBOUND_SEND;
      delete process.env.LAB86_DISABLE_PUBLIC_SIGNUP;
      expect(isLab86AiDisabled()).toBe(true);
      expect(isUserOpenRouterKeyRequired()).toBe(true);
      expect(isSubscriptionServiceDisabled()).toBe(true);
      expect(isOutboundSendDisabled()).toBe(false);
      expect(isPublicSignupDisabled()).toBe(false);
    } finally {
      process.env = previous;
    }
  });

  test('there is no Albatross flag left to turn the product off', async () => {
    const controls = await import('../lib/hosted/controls');
    expect('isAlbatrossEnabled' in controls).toBe(false);
  });
});

describe('moving between mailboxes and smart labels', () => {
  test('choosing a mailbox drops the smart label it was filtered by', () => {
    // Main → Sent with a label still applied would show Sent narrowed by a
    // category the user cannot see and did not ask for.
    const store = useClientStore.getState();
    store.setSmartCategory('receipts');
    expect(useClientStore.getState().smartCategory).toBe('receipts');

    store.setQuery('in:sent');
    const after = useClientStore.getState();
    expect(after.smartCategory).toBeNull();
    expect(after.query).toBe('in:sent');
    expect(after.querySource).toBe('typed');
    expect(after.primaryView).toBe('mail');
  });

  test('choosing a smart label returns the mailbox to the inbox', () => {
    // Sent → a label without this reads the label against Sent only, which is
    // never what the user meant by pressing it.
    const store = useClientStore.getState();
    store.setQuery('in:sent');
    store.setSmartCategory('receipts');

    const after = useClientStore.getState();
    expect(after.query).toBe(DEFAULT_QUERY);
    expect(after.smartCategory).toBe('receipts');
    expect(after.querySource).toBe('category');
  });

  test('both transitions clear the half-typed search and its errors', () => {
    const store = useClientStore.getState();
    store.setSearchDraft('receipts from ma');
    store.setQueryError('Could not read that');
    store.setQuery('in:sent');
    expect(useClientStore.getState().searchDraft).toBe('');
    expect(useClientStore.getState().queryError).toBeNull();

    store.setSearchDraft('half typed');
    store.setSmartCategory('receipts');
    expect(useClientStore.getState().searchDraft).toBe('');
    expect(useClientStore.getState().nlSearchIntent).toBeNull();
  });

  test('clearing the label goes back to the default mailbox, not to nothing', () => {
    const store = useClientStore.getState();
    store.setSmartCategory(null);
    const after = useClientStore.getState();
    expect(after.query).toBe(DEFAULT_QUERY);
    expect(after.smartCategory).toBeNull();
    expect(after.querySource).toBe('typed');
  });
});
