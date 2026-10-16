import { z } from 'zod';
import type { ToolRisk } from '../ai/approval';
import { runWithAiRequestContext } from '../ai/context';
import { truncateText } from '../shared/text';
import { writeAudit } from '../store/audit';

export type { ToolRisk } from '../ai/approval';

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
  runId?: string;
  toolExecutionKey?: string;
  abortSignal?: AbortSignal;
  // IANA timezone for interpreting naive wall-clock timestamps in tool args.
  userTimezone?: string;
  // Server-restored user choice; never supplied by model tool arguments.
  presentationChoicesDelegated?: boolean;
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
    | 'mcp'
    | 'documents'
    | 'meta';
  mutating: boolean;
  /**
   * What a call can touch: `read` (nothing), `write_self` (the user's own data,
   * shown in Activity with Undo), `reach_person` (another person sees it), or
   * `destructive` (it cannot be undone). Every mutating tool declares one; the
   * agent loop asks the user first for `reach_person` and `destructive`.
   */
  risk?: ToolRisk;
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

/** The risk class of a tool. A tool that declares none is `read` or, if it mutates, `write_self`. */
export function toolRisk(tool: Pick<AnyTool, 'mutating' | 'risk'>): ToolRisk {
  return tool.risk ?? (tool.mutating ? 'write_self' : 'read');
}

function validationIssues(issues: z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union' || !issue.errors.length) return [issue];
    const branches = issue.errors.map(validationIssues);
    return branches.reduce((closest, branch) => (branch.length < closest.length ? branch : closest));
  });
}

/**
 * Parses tool args. Some models send a list or an object as JSON text (for
 * example `values: "[{...}]"`). When a top-level field fails only because it
 * is text that holds the expected JSON list or object, the field is read as
 * that JSON and the args parse again. Anything else keeps the first error.
 */
export function parseToolArgs(schema: z.ZodTypeAny, args: unknown): unknown {
  const first = schema.safeParse(args);
  if (first.success) return first.data;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw first.error;
  const fixed: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  let changed = false;
  for (const issue of first.error.issues) {
    if (issue.code !== 'invalid_type' || issue.path.length !== 1) continue;
    if (issue.expected !== 'array' && issue.expected !== 'object') continue;
    const key = String(issue.path[0]);
    const raw = fixed[key];
    if (typeof raw !== 'string') continue;
    try {
      const value: unknown = JSON.parse(raw);
      const isArray = Array.isArray(value);
      if (value && typeof value === 'object' && isArray === (issue.expected === 'array')) {
        fixed[key] = value;
        changed = true;
      }
    } catch {
      // Not JSON: the first error stands.
    }
  }
  if (!changed) throw first.error;
  return schema.parse(fixed);
}

export async function invokeTool(tool: AnyTool, args: unknown, ctx: ToolContext) {
  return runWithAiRequestContext(
    {
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      userName: ctx.userName,
      agent: ctx.agent,
      operationBatchId: ctx.operationBatchId,
      chatId: ctx.chatId,
      runId: ctx.runId,
      toolExecutionKey: ctx.toolExecutionKey,
      userTimezone: ctx.userTimezone,
    },
    async () => {
      let parsed: unknown;
      try {
        parsed = parseToolArgs(tool.input, args);
      } catch (err: any) {
        const issues = err instanceof z.ZodError ? validationIssues(err.issues) : [];
        console.warn('[agent-tool-validation]', {
          runId: ctx.runId,
          tool: tool.name,
          issues: issues.map((entry) => ({ path: entry.path, code: entry.code })),
        });
        throw new ToolValidationError(
          issues.length
            ? `Invalid args for ${tool.name}: ${issues
                .slice(0, 5)
                .map((issue) => `${issue.path.join('.')} — ${issue.message}`)
                .join('; ')}`
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
    return s.length > 200 ? `${truncateText(s, 200)}…` : s;
  } catch {
    return String(value);
  }
}
