export function mcpSyncStateFields(
  input: {
    userId: string;
    connectionId: string;
    server: string;
    status: 'idle' | 'syncing' | 'ready' | 'error';
    lastSyncedAt?: number;
    lastCursor?: string;
    itemCount?: number;
    accountEmail?: string;
    workspaceName?: string;
    error?: string;
  },
  updatedAt: number,
) {
  return {
    userId: input.userId,
    connectionId: input.connectionId,
    server: input.server,
    status: input.status,
    lastSyncedAt: input.lastSyncedAt,
    lastCursor: input.lastCursor,
    itemCount: input.itemCount,
    ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
    error: input.error,
    updatedAt,
  };
}
