import { randomUUID } from 'node:crypto';
import type { SmartCategoryId, SmartRule } from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

export async function listSmartRules(includeDisabled = false) {
  const rules = await kvList<SmartRule>('smartRule', { limit: 1000 });
  const filtered = includeDisabled ? rules : rules.filter((rule) => rule.enabled);
  filtered.sort((a, b) => b.createdAt - a.createdAt);
  return filtered;
}

export async function getSmartRule(id: string) {
  return await kvGet<SmartRule>('smartRule', id);
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
  await kvUpsert('smartRule', rule._id, rule);
  return rule;
}

export async function setSmartRuleEnabled(id: string, enabled: boolean) {
  const existing = await getSmartRule(id);
  if (!existing) throw new Error('Smart rule not found');
  const next = { ...existing, enabled, updatedAt: Date.now() };
  await kvUpsert('smartRule', id, next);
  return next;
}
