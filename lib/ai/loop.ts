import { tool as aiTool, streamText, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import { TOOLS } from '../tools';
import { invokeTool } from '../tools/registry';
import { primaryModel, hasAi } from './client';
import { SYSTEM_PROMPT } from './system-prompt';

function liftToolsForAgent(): Record<string, any> {
  const lifted: Record<string, any> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    lifted[name] = aiTool({
      description: t.description + (t.mutating ? ' (mutating — surfaces a confirmation in the UI)' : ''),
      inputSchema: ((t.input as unknown) ?? z.object({})) as any,
      execute: async (args: unknown) => {
        const result = await invokeTool(t, args ?? {}, { agent: 'ai' });
        return result;
      },
    });
  }
  return lifted;
}

export interface AgentRunOpts {
  messages: ModelMessage[];
  /** Bias the system prompt with extra context (selected thread, focused account). */
  extraSystem?: string;
}

export function runAgent({ messages, extraSystem }: AgentRunOpts) {
  if (!hasAi()) {
    throw new Error('AI not configured: set OPENAI_API_KEY (or ANTHROPIC_API_KEY).');
  }
  const system = extraSystem ? `${SYSTEM_PROMPT}\n\n${extraSystem}` : SYSTEM_PROMPT;
  const stream = streamText({
    model: primaryModel(),
    system,
    messages,
    tools: liftToolsForAgent(),
    stopWhen: stepCountIs(8),
    onError: (event) => {
      // Best-effort logging; don't crash the stream.
      console.error('[agent]', event.error);
    },
  });
  return stream;
}
