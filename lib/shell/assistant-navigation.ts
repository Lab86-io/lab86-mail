interface AssistantState {
  aiBarOpen: boolean;
  assistantPresentation: 'corner' | 'split' | 'full';
}

/** Navigation must reveal its destination, without replacing the conversation. */
export function assistantAfterPageNavigation(
  state: AssistantState,
  viewport: { mobile?: boolean; availableWidth?: number } = {},
): Partial<AssistantState> {
  if (!state.aiBarOpen) return {};
  // A split needs the same 280px page + 6px seam + 360px chat as the frame.
  if (viewport.mobile || (viewport.availableWidth !== undefined && viewport.availableWidth < 646)) {
    return { aiBarOpen: false };
  }
  return state.assistantPresentation === 'full' ? { assistantPresentation: 'split' } : {};
}

export function pageNavigationAssistantState(state: AssistantState): Partial<AssistantState> {
  const mobile = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches;
  const workspace =
    typeof document === 'undefined'
      ? null
      : document.querySelector<HTMLElement>('[data-assistant-workspace]');
  return assistantAfterPageNavigation(state, {
    mobile,
    availableWidth: workspace?.clientWidth || undefined,
  });
}
