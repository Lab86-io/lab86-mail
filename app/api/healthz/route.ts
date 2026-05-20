import { NextResponse } from 'next/server';
import { describeProvider, hasAi } from '@/lib/ai/client';
import { TOOLS } from '@/lib/tools';
import { listAccounts } from '@/lib/tools/mail';

export const runtime = 'nodejs';

export async function GET() {
  let accounts: any = { accounts: [] };
  try {
    accounts = await listAccounts.handler({}, { agent: 'user' });
  } catch {}
  return NextResponse.json({
    ok: true,
    service: 'lab86-mail',
    version: '2.0.0',
    accounts: accounts.accounts.length,
    authed: accounts.accounts.filter((a: any) => a.authed).map((a: any) => a.email),
    tools: Object.keys(TOOLS).length,
    ai: { configured: hasAi(), ...describeProvider() },
  });
}
