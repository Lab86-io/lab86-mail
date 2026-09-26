// The confirmation for an unsubscribe (FEATURES item 13). An unsubscribe
// cannot be undone, so the dialog says where the request goes and asks first.
// Shared by the reader and the sender cleanup list; pure for tests.

export interface UnsubscribeOptionsView {
  sender: string;
  method: 'one_click' | 'mailto' | 'link' | null;
  destination: string | null;
  url?: string;
}

export interface UnsubscribeConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  /** What the confirm button does. */
  action: 'unsubscribe' | 'open_link' | 'block';
}

export function unsubscribeConfirmCopy(
  options: UnsubscribeOptionsView,
  mailbox?: string | null,
): UnsubscribeConfirmCopy {
  const sender = options.sender || 'this sender';
  switch (options.method) {
    case 'one_click':
      return {
        title: `Unsubscribe from ${sender}?`,
        description: `Albatross sends a one-click unsubscribe request to ${options.destination || 'the sender'}. An unsubscribe cannot be undone.`,
        confirmLabel: 'Unsubscribe',
        action: 'unsubscribe',
      };
    case 'mailto':
      return {
        title: `Unsubscribe from ${sender}?`,
        description: `Albatross sends an email${mailbox ? ` from ${mailbox}` : ''} to ${options.destination || 'the sender'} that asks to take you off the list. An unsubscribe cannot be undone.`,
        confirmLabel: 'Send the request',
        action: 'unsubscribe',
      };
    case 'link':
      return {
        title: `Unsubscribe from ${sender}`,
        description: `${sender} only offers an unsubscribe page on ${options.destination || 'its website'}. Open it to finish there.`,
        confirmLabel: 'Open the page',
        action: 'open_link',
      };
    default:
      return {
        title: `${sender} has no unsubscribe option`,
        description:
          'Block the sender instead. Their mail goes to Noise from now on, and their threads leave the inbox. You can undo a block from Activity.',
        confirmLabel: 'Block sender',
        action: 'block',
      };
  }
}

/** The success line after a request went out. */
export function unsubscribeResultMessage(result: {
  status: 'unsubscribed' | 'requested' | 'open_link';
  sender: string;
}) {
  if (result.status === 'unsubscribed') return `Unsubscribed from ${result.sender}`;
  if (result.status === 'requested') return `Unsubscribe request sent to ${result.sender}`;
  return `Opened the unsubscribe page for ${result.sender}`;
}
