import { AsyncLocalStorage } from 'node:async_hooks';

export interface AiRequestContext {
  userId?: string | null;
  userEmail?: string | null;
  agent?: 'user' | 'ai' | 'codex';
}

const aiContext = new AsyncLocalStorage<AiRequestContext>();

export function runWithAiRequestContext<T>(context: AiRequestContext, fn: () => T): T {
  return aiContext.run(context, fn);
}

export function getAiRequestContext() {
  return aiContext.getStore() || {};
}
