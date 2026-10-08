// What each thread keeps while the user hops (docs/albatross-threads.md, T3;
// lead decision 4): the composer draft, the scroll position, and the rail's
// own scroll position (the rail mounts again with each thread). Memory only:
// a draft can hold a password or an ID number the user is about to send, so
// it never goes to browser storage, and a reload or sign-out drops it. One
// module-level store with a version counter, so a row can show "Draft"
// through useSyncExternalStore without React state in this file.

export interface ThreadScrollState {
  top: number;
  /** The reader followed the bottom when they left; follow it again on return. */
  atBottom: boolean;
}

type Listener = () => void;

const drafts = new Map<string, string>();
const scrolls = new Map<string, ThreadScrollState>();
const listeners = new Set<Listener>();
let version = 0;
let railTop = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function threadDraft(workId: string): string {
  return drafts.get(workId) ?? '';
}

export function setThreadDraft(workId: string, text: string) {
  if ((drafts.get(workId) ?? '') === text) return;
  if (text) drafts.set(workId, text);
  else drafts.delete(workId);
  notify();
}

export function hasThreadDraft(workId: string): boolean {
  return threadDraft(workId).trim().length > 0;
}

/** Every thread with an unsent draft. */
export function threadDraftWorkIds(): Set<string> {
  return new Set([...drafts].filter(([, text]) => text.trim()).map(([workId]) => workId));
}

export function subscribeThreadMemory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A number that changes on every write, for useSyncExternalStore. */
export function threadMemoryVersion(): number {
  return version;
}

export function threadScroll(workId: string): ThreadScrollState | null {
  return scrolls.get(workId) ?? null;
}

export function setThreadScroll(workId: string, state: ThreadScrollState) {
  scrolls.set(workId, state);
}

/** Where the rail was scrolled, so a hop does not send it back to the top. */
export function railScrollTop(): number {
  return railTop;
}

export function setRailScrollTop(top: number) {
  railTop = Math.max(0, top);
}

/** Tests only. */
export function resetThreadMemory() {
  drafts.clear();
  scrolls.clear();
  railTop = 0;
  notify();
}
