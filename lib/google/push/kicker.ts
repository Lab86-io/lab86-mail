// Direct Google push: one sync for each burst of messages.
//
// Google can send many messages for one change (Gmail sends up to one each
// second for a mailbox; Calendar sends one for each changed event). A kick
// waits `delayMs`, so that a burst starts one sync. A kick that arrives while
// the sync of its key runs marks the key, and one more sync starts after the
// first ends: a change during a sync is never lost. A sync that answers
// `again` (the sync was busy, or it has more to read) runs again after
// `retryDelayMs`, at most `maxChain` times in a row.

export type PushKickOutcome = 'done' | 'again';
export type PushKickResult = 'scheduled' | 'coalesced' | 'queued';

type Timer = unknown;

export interface PushKickerOptions<T> {
  /** Resolves to `again` to run once more after `retryDelayMs`; anything else ends the chain. */
  run: (input: T) => Promise<PushKickOutcome | undefined>;
  delayMs: number;
  retryDelayMs: number;
  maxChain: number;
  schedule?: (fn: () => void, ms: number) => Timer;
  reportError?: (key: string, error: unknown) => void;
}

interface KeyState<T> {
  input: T;
  timer?: Timer;
  running: boolean;
  dirty: boolean;
  chain: number;
}

export function createPushKicker<T>(options: PushKickerOptions<T>) {
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const reportError =
    options.reportError ??
    ((key: string, error: unknown) =>
      console.error(`[google-push] sync failed for ${key}:`, (error as any)?.message || error));
  const states = new Map<string, KeyState<T>>();

  function arm(key: string, state: KeyState<T>, ms: number) {
    state.timer = schedule(() => void start(key), ms);
  }

  async function start(key: string) {
    const state = states.get(key);
    if (!state) return;
    state.timer = undefined;
    state.running = true;
    state.dirty = false;
    let outcome: PushKickOutcome | undefined;
    try {
      outcome = await options.run(state.input);
    } catch (error) {
      reportError(key, error);
      outcome = 'done';
    }
    state.running = false;
    if (state.dirty) {
      // A new message came during the sync: a fresh burst.
      state.chain = 0;
      arm(key, state, options.delayMs);
    } else if (outcome === 'again' && state.chain < options.maxChain) {
      state.chain += 1;
      arm(key, state, options.retryDelayMs);
    } else {
      states.delete(key);
    }
  }

  function kick(key: string, input: T): PushKickResult {
    const state = states.get(key);
    if (state?.running) {
      state.dirty = true;
      state.input = input;
      return 'queued';
    }
    if (state?.timer !== undefined) {
      state.input = input;
      return 'coalesced';
    }
    const next: KeyState<T> = { input, running: false, dirty: false, chain: 0 };
    states.set(key, next);
    arm(key, next, options.delayMs);
    return 'scheduled';
  }

  return {
    kick,
    /** Keys with a timer or a running sync. */
    pending: () => states.size,
  };
}

export type PushKicker<T> = ReturnType<typeof createPushKicker<T>>;
