import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TOOLS, listToolMetadata } from '@/lib/tools';

export const runtime = 'nodejs';

export async function GET() {
  const tools = Object.values(TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    mutating: t.mutating,
    input: zodToJsonSchema(t.input),
    output: zodToJsonSchema(t.output),
  }));
  return NextResponse.json({ ok: true, count: tools.length, tools });
}

function zodToJsonSchema(schema: z.ZodTypeAny | undefined): unknown {
  if (!schema) return { type: 'object' };
  try {
    // Zod 4 exposes `toJSONSchema`. Fall back gracefully.
    const anyZ: any = z;
    if (typeof anyZ.toJSONSchema === 'function') return anyZ.toJSONSchema(schema);
    if (typeof (schema as any).toJSONSchema === 'function') return (schema as any).toJSONSchema();
  } catch {}
  return { type: 'object', description: 'schema introspection unavailable' };
}

// Also export for the named-tool route to share.
export { listToolMetadata };
