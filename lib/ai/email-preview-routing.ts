export interface EmailPreviewThreadTarget {
  account: string;
  threadId: string;
}

export function emailPreviewThreadTarget(payload: {
  account?: unknown;
  threadId?: unknown;
}): EmailPreviewThreadTarget | null {
  if (
    typeof payload.account !== 'string' ||
    !payload.account.trim() ||
    typeof payload.threadId !== 'string' ||
    !payload.threadId.trim()
  ) {
    return null;
  }
  return {
    account: payload.account,
    threadId: payload.threadId,
  };
}

export function routeEmailPreviewThread(
  target: EmailPreviewThreadTarget,
  actions: {
    setThreadAccount: (account: string) => void;
    setSelectedThread: (threadId: string) => void;
  },
) {
  actions.setThreadAccount(target.account);
  actions.setSelectedThread(target.threadId);
}
