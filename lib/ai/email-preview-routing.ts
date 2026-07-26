export interface EmailPreviewThreadTarget {
  account: string;
  threadId: string;
}

export function emailPreviewThreadTarget(payload: {
  account: unknown;
  threadId: unknown;
}): EmailPreviewThreadTarget {
  return {
    account: String(payload.account),
    threadId: String(payload.threadId),
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
