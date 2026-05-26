import { randomUUID } from 'node:crypto';
import type { SmartCategoryId, SmartRule } from '../shared/types';
import { db, findMany, findOne, upsert } from './db';

export async function listSmartRules(includeDisabled = false) {
  return await findMany<SmartRule>(db().smartRules, includeDisabled ? {} : { enabled: true }, {
    sort: { createdAt: -1 },
  });
}

export async function getSmartRule(id: string) {
  return await findOne<SmartRule>(db().smartRules, { _id: id });
}

export async function createSmartRule(input: {
  name: string;
  scope: SmartRule['scope'];
  match: string;
  effect: SmartRule['effect'];
  category?: SmartCategoryId;
  customLabelId?: string;
  reason?: string;
  source?: SmartRule['source'];
}) {
  const ts = Date.now();
  const rule: SmartRule = {
    _id: randomUUID(),
    name: input.name.trim() || `${input.effect} ${input.match}`,
    enabled: true,
    scope: input.scope,
    match: input.match.trim().toLowerCase(),
    effect: input.effect,
    category: input.category,
    customLabelId: input.customLabelId,
    reason: input.reason,
    source: input.source || 'quick_fix',
    createdAt: ts,
    updatedAt: ts,
  };
  if (!rule.match) throw new Error('Rule match is required');
  await upsert(db().smartRules, { _id: rule._id }, rule);
  return rule;
}

export async function setSmartRuleEnabled(id: string, enabled: boolean) {
  const existing = await getSmartRule(id);
  if (!existing) throw new Error('Smart rule not found');
  const next = { ...existing, enabled, updatedAt: Date.now() };
  await upsert(db().smartRules, { _id: id }, next);
  return next;
}
