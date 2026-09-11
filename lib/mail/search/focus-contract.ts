export const MAIL_SEARCH_FOCUS_EVENT = 'lab86-mail:focus-search';
export const MAIL_SEARCH_TARGET_SELECTOR = '[data-mail-search-input="true"]';
export const MAIL_RESULT_SELECTOR = '[data-mail-thread-row="true"]';
const pendingSearchFocus = new WeakSet<Window>();

type KeyboardShortcutLike = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>;

/** A chat button is not editable, but still must not operate on hidden mail. */
export function isAssistantKeyboardTarget(target: EventTarget | null): boolean {
  return Boolean(
    (target as { closest?: (selector: string) => unknown } | null)?.closest?.('[data-assistant-chat]'),
  );
}

/**
 * Search is global, but it must never take a slash or Find shortcut away from
 * a control where the user is already typing or choosing a value.
 */
export function isEditableSearchTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tagName = element.tagName?.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.('[contenteditable="true"], [role="textbox"]'));
}

export function isGlobalMailSearchShortcut(event: KeyboardShortcutLike, target: EventTarget | null): boolean {
  if (isEditableSearchTarget(target) || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  if (key === '/') return !event.metaKey && !event.ctrlKey;
  return key === 'f' && (event.metaKey || event.ctrlKey);
}

export function mailSearchShortcutLabel(platform: string | null | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(platform || '') ? '⌘F' : 'Ctrl F';
}

/** Focus the one authoritative Inbox search input when it is already mounted. */
export function focusMailSearchInput(root: ParentNode = document): boolean {
  const input = root.querySelector<HTMLInputElement>(MAIL_SEARCH_TARGET_SELECTOR);
  if (!input) return false;
  input.focus({ preventScroll: true });
  input.select();
  return input.ownerDocument.activeElement === input;
}

/**
 * Keep the request until Inbox mounts. A frame-count retry can expire during
 * a slow render or a route transition before the search field exists.
 */
export function requestMailSearchFocus(targetWindow: Window = window): void {
  pendingSearchFocus.add(targetWindow);
  targetWindow.dispatchEvent(new Event(MAIL_SEARCH_FOCUS_EVENT));
  if (focusMailSearchInput(targetWindow.document)) pendingSearchFocus.delete(targetWindow);
}

export function registerMailSearchFocus(targetWindow: Window = window): () => void {
  const focus = () => {
    if (focusMailSearchInput(targetWindow.document)) pendingSearchFocus.delete(targetWindow);
  };
  targetWindow.addEventListener(MAIL_SEARCH_FOCUS_EVENT, focus);
  if (pendingSearchFocus.has(targetWindow)) focus();
  return () => targetWindow.removeEventListener(MAIL_SEARCH_FOCUS_EVENT, focus);
}

/** Arrow through the visible results without visiting every row's controls. */
export function focusMailResult(root: ParentNode, direction: 1 | -1, current?: HTMLElement): boolean {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(MAIL_RESULT_SELECTOR));
  const index = current ? rows.indexOf(current) + direction : direction === 1 ? 0 : rows.length - 1;
  const row = rows[index];
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
  return true;
}
