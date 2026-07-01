import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { getTool } from '@/lib/tools';
import { invokeTool, ToolValidationError } from '@/lib/tools/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Some direct UI tools, notably manual Daily Brief generation, intentionally
// wait for a terminal saved result instead of spawning fragile background work.
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const tool = getTool(name);
  if (!tool) return NextResponse.json({ ok: false, error: `unknown tool: ${name}` }, { status: 404 });

  let body: any = {};
  try {
    body = await req.json().catch(() => ({}));
  } catch {}
  const agentHeader = req.headers.get('x-agent') || 'user';
  const agent = (agentHeader === 'ai' || agentHeader === 'codex' ? agentHeader : 'user') as
    | 'ai'
    | 'codex'
    | 'user';

  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: `tool:${tool.name}`,
      limit: tool.mutating ? 60 : 180,
      windowMs: 60_000,
    });
    const timezone = req.headers.get('x-user-timezone') || undefined;
    const result = await invokeTool(tool, body, {
      agent,
      account: body?.account,
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      operationBatchId:
        typeof body?.operationBatchId === 'string' ? body.operationBatchId.slice(0, 180) : undefined,
      userTimezone: timezone,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    const status = err instanceof AuthRequiredError ? 401 : err instanceof ToolValidationError ? 400 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'tool failure' }, { status });
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const tool = getTool(name);
  if (!tool) return NextResponse.json({ ok: false, error: `unknown tool: ${name}` }, { status: 404 });
  return NextResponse.json({
    ok: true,
    tool: {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      mutating: tool.mutating,
    },
  });
}
