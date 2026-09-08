import type { ClientState } from '../client-state';
import { type SearchTarget, searchFilePath } from './global-search';

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
  state.setSelectedThread(null);
  state.setCalendarSearchTarget(null);
  state.setSelectedWorkId(null);
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
