import { type CommandReceipt, CommandReceiptSchema } from './contract';

export function commandReceiptFromRow(row: any): CommandReceipt {
  if (!row?._id) throw new Error('Mobile command receipt is missing its command id.');
  return CommandReceiptSchema.parse({
    commandID: String(row._id),
    status: row.status,
    entityRevision: typeof row.entityRevision === 'number' ? row.entityRevision : undefined,
    operationID: typeof row.operationId === 'string' && row.operationId ? row.operationId : undefined,
    approvalID: typeof row.approvalId === 'string' && row.approvalId ? row.approvalId : undefined,
    undoExpiresAt:
      typeof row.undoExpiresAt === 'number' ? new Date(row.undoExpiresAt).toISOString() : undefined,
    recoverableError:
      row.errorCode && row.errorMessage
        ? {
            code: String(row.errorCode),
            message: String(row.errorMessage),
            retryable: Boolean(row.errorRetryable),
          }
        : undefined,
  });
}
