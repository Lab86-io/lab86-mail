import type { ClientState } from '../client-state';
import { SEARCH_SCOPES, type SearchScope, type SearchTarget, searchFilePath } from './global-search';

type CategoryKey = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented'
>;

/** Horizontal arrows change sources at query edges without stealing text editing. */
export function searchScopeForArrow(
  event: CategoryKey,
  current: SearchScope,
  input?: Pick<HTMLInputElement, 'value' | 'selectionStart' | 'selectionEnd'>,
): SearchScope | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
  )
    return null;
  if (input) {
    const { selectionStart: start, selectionEnd: end, value } = input;
    if (start === null || end === null || start !== end) return null;
    if (event.key === 'ArrowLeft' ? start !== 0 : end !== value.length) return null;
  }
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const index = SEARCH_SCOPES.findIndex((scope) => scope.id === current);
  return SEARCH_SCOPES[(index + direction + SEARCH_SCOPES.length) % SEARCH_SCOPES.length].id;
}

export function focusSearchAfterSelection(root: ParentNode, previous: HTMLElement | null) {
  const launcher = root.querySelector<HTMLButtonElement>('button[aria-label^="Search everything"]');
  if (launcher) launcher.focus();
  else if (previous?.isConnected) previous.focus();
}

export function navigateSearchTarget(
  target: Exclude<SearchTarget, { kind: 'external' }>,
  state: Pick<
    ClientState,
    | 'setSelectedThread'
    | 'setCalendarSearchTarget'
    | 'setSelectedWorkId'
    | 'setSelectedAreaId'
    | 'setPrimaryView'
    | 'setThreadAccount'
  >,
  navigate: (path: string) => void,
) {
  if (target.kind === 'page' && target.view === 'chat') {
    state.setPrimaryView('chat');
    navigate('/?view=chat');
    return;
  }
  state.setSelectedThread(null);
  state.setCalendarSearchTarget(null);
  state.setSelectedWorkId(null);
  if (target.kind === 'narrative') {
    navigate(`/narrative${target.id ? `?id=${encodeURIComponent(target.id)}` : ''}`);
    return;
  }
  if (target.kind === 'settings') {
    navigate('/settings');
    return;
  }
  if (target.kind === 'page') {
    if (target.view === 'areas') state.setSelectedAreaId(null);
    state.setPrimaryView(target.view);
    navigate(`/?view=${target.view}`);
  } else if (target.kind === 'mail') {
    state.setThreadAccount(target.account);
    state.setSelectedThread(target.threadId);
    state.setPrimaryView('mail');
    navigate('/?view=mail');
  } else if (target.kind === 'calendar') {
    state.setCalendarSearchTarget(target.event);
    state.setPrimaryView('calendar');
    navigate('/?view=calendar');
  } else {
    state.setPrimaryView('files');
    navigate(searchFilePath(target));
  }
}
