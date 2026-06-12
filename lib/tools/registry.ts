import { z } from 'zod';
import { runWithAiRequestContext } from '../ai/context';
import { writeAudit } from '../store/audit';

export interface ToolContext {
  agent: 'user' | 'ai' | 'codex';
  account?: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  // One id per agent turn; mutating tools record their operations under it so
  // the UI can present the turn as a single change-set (lib/ai/operations.ts).
  operationBatchId?: string;
  chatId?: string;
  // IANA timezone for interpreting naive wall-clock timestamps in tool args.
  userTimezone?: string;
}

export interface ToolDefinition<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TOut extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  category:
    | 'mail'
    | 'compose'
    | 'ai'
    | 'memory'
    | 'calendar'
    | 'tasks'
    | 'contacts'
    | 'web'
    | 'audit'
    | 'meta';
  mutating: boolean;
  input: TArgs;
  output: TOut;
  handler: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<z.infer<TOut>>;
}

export function defineTool<TArgs extends z.ZodTypeAny, TOut extends z.ZodTypeAny>(
  t: ToolDefinition<TArgs, TOut>,
): ToolDefinition<TArgs, TOut> {
  return t;
}

export type AnyTool = ToolDefinition<any, any>;

export async function invokeTool(tool: AnyTool, args: unknown, ctx: ToolContext) {
  return runWithAiRequestContext(
    {
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      userName: ctx.userName,
      agent: ctx.agent,
      operationBatchId: ctx.operationBatchId,
      chatId: ctx.chatId,
      userTimezone: ctx.userTimezone,
    },
    async () => {
      let parsed: unknown;
      try {
        parsed = tool.input.parse(args);
      } catch (err: any) {
        const issue = err?.issues?.[0];
        throw new ToolValidationError(
          issue
            ? `Invalid args for ${tool.name}: ${issue.path.join('.')} — ${issue.message}`
            : `Invalid args for ${tool.name}`,
        );
      }
      let result: unknown;
      try {
        result = await tool.handler(parsed as any, ctx);
      } catch (err: any) {
        await writeAudit({
          tool: tool.name,
          userId: ctx.userId ?? null,
          account: ctx.account ?? null,
          args: parsed as Record<string, unknown>,
          result: 'error',
          detail: err?.message,
          agent: ctx.agent,
        }).catch((auditErr) => {
          console.error(`Failed to write audit log for ${tool.name} error:`, auditErr);
        });
        throw err;
      }
      await writeAudit({
        tool: tool.name,
        userId: ctx.userId ?? null,
        account: ctx.account ?? null,
        args: parsed as Record<string, unknown>,
        result: 'ok',
        detail: tool.mutating ? safeSummary(result) : undefined,
        agent: ctx.agent,
      }).catch((auditErr) => {
        console.error(`Failed to write audit log for ${tool.name}:`, auditErr);
      });
      return result;
    },
  );
}

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

function safeSummary(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(value);
  }
}
