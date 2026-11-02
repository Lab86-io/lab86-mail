// UI tools (lib/tools/ui-tools.ts) run in the browser. These helpers keep two
// promises of that split: a restored chat never runs its old calls again, and a
// call that failed in the browser reaches the model on the next request.

export function isUiToolName(name: unknown): name is string {
  return typeof name === 'string' && /^ui_[a-z_]{1,40}$/.test(name);
}

function toolCallIds(messages: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages as any[]) {
    if (!Array.isArray(message?.parts)) continue;
    for (const part of message.parts) if (typeof part?.toolCallId === 'string') ids.push(part.toolCallId);
  }
  return ids;
}

/**
 * Marks every tool call in restored messages as handled, before they render.
 * Those calls ran when the model made them. Without this, an old chat opens
 * its compose window again and refreshes its queries again.
 */
export function seedHandledToolCalls(handled: Set<string>, messages: readonly unknown[]) {
  for (const id of toolCallIds(messages)) {
    handled.add(id);
    handled.add(`refresh:${id}`);
  }
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  ui_focus_thread: 'Could not open that thread.',
  ui_set_query: 'Could not run that search.',
  ui_open_compose: 'Could not open the compose window.',
  ui_open_reply: 'Could not open the reply window.',
  ui_toast: 'Could not show that notice.',
  ui_close_bar: 'Could not close the assistant.',
  ui_switch_account: 'Could not switch the account.',
};

/** What the user reads when a UI tool fails in the browser. */
export function uiToolFailureText(name: string): string {
  return FAILURE_TEXT[name] ?? 'Could not do that in the app.';
}

/**
 * The system note for UI tools that failed in the browser. The server answered
 * those calls before the browser ran them, so the model believes that they
 * worked. The names come from the client, so only the `ui_` shape gets through.
 */
export function clientToolFailureNote(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const names = [...new Set(value.filter(isUiToolName))].slice(0, 7);
  return names.length
    ? `These app actions failed in the browser after the server answered them: ${names.join(', ')}. They did not happen. Do not say that they did. Try again if the user still needs them.`
    : '';
}
