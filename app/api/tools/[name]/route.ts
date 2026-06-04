import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getTool } from '@/lib/tools';
import { invokeTool, ToolValidationError } from '@/lib/tools/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const result = await invokeTool(tool, body, {
      agent,
      account: body?.account,
      userId: user.userId,
      userEmail: user.email,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
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
