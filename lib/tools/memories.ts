import { z } from 'zod';
import { defineTool } from './registry';
import {
  forgetSender,
  listMemories as listMemoriesRecord,
  recallSender,
  rememberSender,
} from '../store/memories';

export const remember = defineTool({
  name: 'remember',
  description: 'Store a note about a sender or recipient, used to personalize drafts/triage.',
  category: 'memory',
  mutating: true,
  input: z.object({ email: z.string(), notes: z.string() }),
  output: z.object({ ok: z.boolean(), memory: z.any() }),
  async handler({ email, notes }) {
    const m = await rememberSender(email, notes);
    return { ok: true, memory: m };
  },
});

export const recall = defineTool({
  name: 'recall',
  description: 'Look up the stored notes for a given email address.',
  category: 'memory',
  mutating: false,
  input: z.object({ email: z.string() }),
  output: z.object({ memory: z.any().nullable() }),
  async handler({ email }) {
    return { memory: await recallSender(email) };
  },
});

export const forget = defineTool({
  name: 'forget',
  description: 'Delete all stored notes for an email.',
  category: 'memory',
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
  output: z.object({ memories: z.array(z.any()) }),
  async handler() {
    return { memories: await listMemoriesRecord() };
  },
});
