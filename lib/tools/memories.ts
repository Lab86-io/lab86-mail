import { z } from 'zod';
import {
  forgetSender,
  listMemories as listMemoriesRecord,
  recallSender,
  rememberSender,
} from '../store/memories';
import { defineTool } from './registry';

// Mirrors the Memory record shape in lib/store/memories.ts.
const MemorySchema = z.object({
  email: z.string(),
  notes: z.string(),
  updatedAt: z.number(),
});

export const remember = defineTool({
  name: 'remember',
  description:
    'Store a note about a sender or recipient, used to personalize drafts/triage. By default the note is added to the notes already saved for that email. Use mode "replace" only to rewrite the whole note, and pass the complete new text.',
  category: 'memory',
  risk: 'write_self',
  mutating: true,
  input: z.object({
    email: z.string(),
    notes: z.string(),
    mode: z
      .enum(['append', 'replace'])
      .default('append')
      .describe('append (default) adds to the saved notes; replace rewrites them.'),
  }),
  output: z.object({ ok: z.boolean(), memory: MemorySchema }),
  async handler({ email, notes, mode }) {
    const m = await rememberSender(email, notes, mode);
    return { ok: true, memory: m };
  },
});

export const recall = defineTool({
  name: 'recall',
  description: 'Look up the stored notes for a given email address.',
  category: 'memory',
  mutating: false,
  input: z.object({ email: z.string() }),
  output: z.object({ memory: MemorySchema.nullable() }),
  async handler({ email }) {
    return { memory: await recallSender(email) };
  },
});

export const forget = defineTool({
  name: 'forget',
  description: 'Delete all stored notes for an email.',
  category: 'memory',
  risk: 'destructive',
  mutating: true,
  input: z.object({ email: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ email }) {
    await forgetSender(email);
    return { ok: true };
  },
});

export const listMemories = defineTool({
  name: 'list_memories',
  description: 'List every sender memory.',
  category: 'memory',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({ memories: z.array(MemorySchema) }),
  async handler() {
    return { memories: await listMemoriesRecord() };
  },
});
