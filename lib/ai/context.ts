import { AsyncLocalStorage } from 'node:async_hooks';

export interface AiRequestContext {
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  agent?: 'user' | 'ai' | 'codex';
}

const aiContext = new AsyncLocalStorage<AiRequestContext>();

export function runWithAiRequestContext<T>(context: AiRequestContext, fn: () => T): T {
  return aiContext.run(context, fn);
}

export function getAiRequestContext() {
  return aiContext.getStore() || {};
}

/** Display name for the signed-in user, or null when unknown. */
export function contextUserName(): string | null {
  const { userName, userEmail } = getAiRequestContext();
  const name = (userName || '').trim();
  if (name && !name.includes('@')) return name;
  const email = (userEmail || '').trim();
  return email || null;
}

/** First name of the signed-in user for signatures/prompts, or null. */
export function contextFirstName(): string | null {
  const name = contextUserName();
  if (!name || name.includes('@')) return null;
  return name.split(/\s+/)[0] || null;
}
