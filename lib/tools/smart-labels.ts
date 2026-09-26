import { z } from 'zod';
import { api, convexMutation } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { MAIL_UNDO, mailOperationReason, quotedSubject, recordMailOperation } from '../mail/mail-operations';
import {
  classifyThreadWithContext,
  SMART_CATEGORY_IDS,
  SMART_CATEGORY_LABELS,
  SMART_GMAIL_LABEL_PREFIX,
} from '../mail/smart-categories';
import { emailFromHeader } from '../shared/format';
import type { SmartRule } from '../shared/types';
import { requireStoreUserId } from '../store/kv';
import {
  listSmartCorrections as listSmartCorrectionRecords,
  writeSmartCorrection,
} from '../store/smart-corrections';
import {
  createSmartLabel as createSmartLabelRecord,
  deleteSmartLabel as deleteSmartLabelRecord,
  listSmartLabels as listSmartLabelRecords,
  updateSmartLabel as updateSmartLabelRecord,
} from '../store/smart-labels';
import {
  createSmartRule as createSmartRuleRecord,
  listSmartRules as listSmartRuleRecords,
  setSmartRuleEnabled,
} from '../store/smart-rules';
import { listRecentThreads, resolveThread } from '../store/threads';
import { defineTool } from './registry';

// Synchronously flip every recent corpus thread the new rule matches before
// the tool returns, so the client's immediate refetch (and the Convex live
// query) already reflect the correction instead of waiting for the deferred
// full-corpus sweep.
async function reclassifyRuleMatches(rule: Pick<SmartRule, 'scope' | 'match'>) {
  if (!isConvexConfigured()) return;
  try {
    await convexMutation((api as any).smart.reclassifyMatchingThreads, {
      userId: requireStoreUserId(),
      scope: rule.scope,
      match: rule.match,
    });
  } catch {
    // Best-effort: the scheduled reclassify sweep converges regardless.
  }
}

/** "mail from ann@example.com goes to Noise": what a new rule does, in words. */
export function describeSmartRule(
  rule: Pick<SmartRule, 'scope' | 'match' | 'effect' | 'category'>,
  labelName?: string | null,
) {
  const match = rule.match.trim();
  const who =
    rule.scope === 'sender'
      ? `mail from ${match}`
      : rule.scope === 'domain'
        ? `mail from ${match.startsWith('@') ? match : `@${match}`}`
        : rule.scope === 'thread'
          ? 'this thread'
          : rule.scope === 'subject_pattern'
            ? `mail with "${match.slice(0, 60)}" in the subject`
            : `mail with the header ${match.slice(0, 60)}`;
  const label = labelName ? `"${labelName}"` : 'a custom label';
  const what =
    rule.effect === 'never_main'
      ? 'stays out of Main'
      : rule.effect === 'always_noise'
        ? 'goes to Noise'
        : rule.effect === 'always_category'
          ? `goes to ${rule.category ? SMART_CATEGORY_LABELS[rule.category] : 'a category'}`
          : rule.effect === 'always_custom_label'
            ? `gets the label ${label}`
            : `never gets the label ${label}`;
  return `${who} ${what}`;
}

/** One undoable Activity entry for a new smart rule. Undo turns the rule off. */
async function recordSmartRuleOperation(
  ctx: { userId?: string | null; agent?: 'user' | 'ai' | 'codex'; operationBatchId?: string },
  input: { tool: string; rule: SmartRule; labelName?: string | null; reason?: string; threadId?: string },
) {
  return recordMailOperation({
    userId: ctx.userId,
    tool: input.tool,
    summary: `New rule: ${describeSmartRule(input.rule, input.labelName)}`,
    reason: mailOperationReason(ctx, input.reason),
    target: {
      kind: 'smartRule',
      id: input.rule._id,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    inverse: {
      kind: MAIL_UNDO.disableRule,
      payload: { ruleId: input.rule._id, scope: input.rule.scope, match: input.rule.match },
    },
    batchId: ctx.operationBatchId,
  });
}

const SmartCategorySchema = z.enum(SMART_CATEGORY_IDS);
const RuleScopeSchema = z.enum(['thread', 'sender', 'domain', 'subject_pattern', 'header']);
const RuleEffectSchema = z.enum([
  'never_main',
  'always_noise',
  'always_category',
  'always_custom_label',
  'never_custom_label',
]);

function threadEmail(thread: any) {
  return (emailFromHeader(String(thread?.fromAddress || thread?.from || '')) || '').toLowerCase();
}

function threadDomain(thread: any) {
  return threadEmail(thread).split('@')[1] || '';
}

function scopeMatch(scope: SmartRule['scope'], thread: any, fallback = '') {
  if (scope === 'thread') return thread?._id || fallback;
  if (scope === 'sender') return threadEmail(thread) || fallback;
  if (scope === 'domain') return threadDomain(thread) || fallback;
  if (scope === 'subject_pattern') return String(thread?.subject || fallback).toLowerCase();
  return fallback.toLowerCase();
}

export const listSmartLabels = defineTool({
  name: 'list_smart_labels',
  description: 'List built-in smart categories and custom smart labels.',
  category: 'mail',
  mutating: false,
  input: z.object({ includeDisabled: z.boolean().optional() }).optional(),
  output: z.object({
    builtins: z.array(z.object({ id: SmartCategorySchema, label: z.string() })),
    custom: z.array(z.any()),
  }),
  async handler(input) {
    const custom = await listSmartLabelRecords(input?.includeDisabled ?? false);
    return {
      builtins: SMART_CATEGORY_IDS.map((id) => ({ id, label: id })),
      custom,
    };
  },
});

export const createSmartLabel = defineTool({
  name: 'create_smart_label',
  description:
    'Create a local custom label. It matches by keywords: a thread gets the label when every word of the label name or of one positive example is a whole word in its sender, subject, preview, or body, and no negative example matches the same way. The description is not matched. Does not create Gmail labels.',
  category: 'mail',
  mutating: true,
  input: z.object({
    name: z.string(),
    description: z.string(),
    positiveExamples: z.array(z.string()).min(1),
    negativeExamples: z.array(z.string()).min(1),
    sidebarVisible: z.boolean().optional(),
    createdBy: z.enum(['user', 'agent', 'system']).optional(),
  }),
  output: z.object({ label: z.any() }),
  async handler(args, ctx) {
    const label = await createSmartLabelRecord({
      ...args,
      createdBy: args.createdBy || (ctx.agent === 'ai' ? 'agent' : 'user'),
    });
    return { label };
  },
});

export const previewSmartLabel = defineTool({
  name: 'preview_smart_label',
  description: 'Preview matching cached threads for a proposed natural-language smart label before saving.',
  category: 'mail',
  mutating: false,
  input: z.object({
    name: z.string(),
    description: z.string(),
    positiveExamples: z.array(z.string()).min(1),
    negativeExamples: z.array(z.string()).min(1),
    max: z.number().int().min(1).max(80).default(20),
  }),
  output: z.object({ items: z.array(z.any()) }),
  async handler(args) {
    const tempLabel = {
      _id: 'preview-smart-label',
      name: args.name,
      slug: 'preview',
      description: args.description,
      enabled: true,
      sidebarVisible: false,
      gmailLabelName: `${SMART_GMAIL_LABEL_PREFIX}${args.name}`,
      aiMode: 'metadata_snippet' as const,
      positiveExamples: args.positiveExamples,
      negativeExamples: args.negativeExamples,
      createdBy: 'user' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const [threads, rules, labels] = await Promise.all([
      listRecentThreads(500),
      listSmartRuleRecords(),
      listSmartLabelRecords(),
    ]);
    const items = threads
      .map((thread) => ({
        ...thread,
        smartCategory: classifyThreadWithContext(thread, { rules, customLabels: [...labels, tempLabel] }),
      }))
      .filter((thread) => thread.smartCategory.customLabels?.includes(tempLabel._id))
      .slice(0, args.max);
    return { items };
  },
});

export const updateSmartLabel = defineTool({
  name: 'update_smart_label',
  description: 'Update a local custom smart label.',
  category: 'mail',
  mutating: true,
  input: z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    positiveExamples: z.array(z.string()).optional(),
    negativeExamples: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    sidebarVisible: z.boolean().optional(),
  }),
  output: z.object({ label: z.any() }),
  async handler({ id, ...patch }) {
    const label = await updateSmartLabelRecord(id, patch);
    return { label };
  },
});

export const deleteSmartLabel = defineTool({
  name: 'delete_smart_label',
  description:
    'Delete a local custom smart label and turn off the rules that file mail under it. To keep the label but hide it, use update_smart_label with enabled false.',
  category: 'mail',
  mutating: true,
  input: z.object({ id: z.string() }),
  output: z.object({ label: z.any(), disabledRuleIds: z.array(z.string()) }),
  async handler({ id }) {
    return await deleteSmartLabelRecord(id);
  },
});

export const listSmartRules = defineTool({
  name: 'list_smart_rules',
  description: 'List local smart classification rules and correction history.',
  category: 'mail',
  mutating: false,
  input: z
    .object({ includeDisabled: z.boolean().optional(), correctionLimit: z.number().default(50).optional() })
    .optional(),
  output: z.object({ rules: z.array(z.any()), corrections: z.array(z.any()) }),
  async handler(input) {
    const [rules, corrections] = await Promise.all([
      listSmartRuleRecords(input?.includeDisabled ?? false),
      listSmartCorrectionRecords(input?.correctionLimit ?? 50),
    ]);
    return { rules, corrections };
  },
});

export const createSmartRule = defineTool({
  name: 'create_smart_rule',
  description: 'Create a local smart classification rule. User rules override built-ins and AI labels.',
  category: 'mail',
  mutating: true,
  input: z.object({
    name: z.string(),
    scope: RuleScopeSchema,
    match: z.string(),
    effect: RuleEffectSchema,
    category: SmartCategorySchema.optional(),
    customLabelId: z.string().optional(),
    reason: z.string().optional(),
    source: z.enum(['quick_fix', 'agent', 'settings']).optional(),
  }),
  output: z.object({ rule: z.any(), operationId: z.string().optional() }),
  async handler(args, ctx) {
    const rule = await createSmartRuleRecord({
      ...args,
      source: args.source || (ctx.agent === 'ai' ? 'agent' : 'settings'),
    });
    await reclassifyRuleMatches(rule);
    const operationId = await recordSmartRuleOperation(ctx, {
      tool: 'create_smart_rule',
      rule,
      reason: args.reason,
    });
    return { rule, operationId };
  },
});

export const setSmartRuleEnabledTool = defineTool({
  name: 'set_smart_rule_enabled',
  description: 'Enable or disable a smart rule.',
  category: 'mail',
  mutating: true,
  input: z.object({ id: z.string(), enabled: z.boolean() }),
  output: z.object({ rule: z.any() }),
  async handler({ id, enabled }) {
    const rule = await setSmartRuleEnabled(id, enabled);
    return { rule };
  },
});

export const applySmartCorrection = defineTool({
  name: 'apply_smart_correction',
  description:
    'Apply a quick local correction such as Never Main, Always Noise, Move to category, or Create label from this. Does not mutate Gmail.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    action: z.enum(['never_main', 'always_noise', 'move_to', 'create_label_from_this']),
    scope: RuleScopeSchema.optional(),
    category: SmartCategorySchema.optional(),
    customLabelId: z.string().optional(),
    newLabel: z
      .object({
        name: z.string(),
        description: z.string(),
        positiveExamples: z.array(z.string()).min(1),
        negativeExamples: z.array(z.string()).min(1),
      })
      .optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    rule: z.any().optional(),
    label: z.any().optional(),
    operationId: z.string().optional(),
  }),
  async handler({ account, threadId, action, scope = 'sender', category, customLabelId, newLabel }, ctx) {
    const thread = await resolveThread(account, threadId);
    if (!thread) throw new Error('Thread not found');
    const previousCategory = thread.smartCategory?.primary;
    let label = null;
    let rule = null;
    let effect: SmartRule['effect'] = 'never_main';
    let targetCategory = category;
    let targetCustomLabelId = customLabelId;
    if (action === 'always_noise') {
      effect = 'always_noise';
      targetCategory = 'noise';
    } else if (action === 'move_to') {
      if (!category && !customLabelId) {
        throw new Error('Either category or customLabelId is required for the move_to action');
      }
      effect = customLabelId ? 'always_custom_label' : 'always_category';
    } else if (action === 'create_label_from_this') {
      if (!newLabel) throw new Error('New label details are required');
      label = await createSmartLabelRecord({ ...newLabel, createdBy: ctx.agent === 'ai' ? 'agent' : 'user' });
      effect = 'always_custom_label';
      targetCustomLabelId = label._id;
    }

    const match = scopeMatch(scope, thread, threadId);
    rule = await createSmartRuleRecord({
      name: action.replace(/_/g, ' '),
      scope,
      match,
      effect,
      category: targetCategory,
      customLabelId: targetCustomLabelId,
      reason: `Quick correction: ${action.replace(/_/g, ' ')}`,
      source: 'quick_fix',
    });

    const rules = await listSmartRuleRecords();
    const labels = await listSmartLabelRecords();
    // The stored verdict is the corpus row, which reclassifyRuleMatches
    // updates. This local verdict only records the new category.
    const smartCategory = classifyThreadWithContext(thread, { rules, customLabels: labels });
    await reclassifyRuleMatches(rule);
    await writeSmartCorrection({
      account,
      threadId,
      fromEmail: threadEmail(thread),
      fromDomain: threadDomain(thread),
      subject: thread.subject,
      previousCategory,
      newCategory: smartCategory.primary,
      customLabelId: targetCustomLabelId,
      ruleId: rule._id,
      action,
    });
    const labelName =
      label?.name || (targetCustomLabelId ? labels.find((l) => l._id === targetCustomLabelId)?.name : null);
    const operationId = await recordSmartRuleOperation(ctx, {
      tool: 'apply_smart_correction',
      rule,
      labelName,
      threadId,
      reason:
        ctx.agent === 'ai' ? undefined : `You corrected where ${quotedSubject(thread.subject)} belongs.`,
    });
    return { ok: true, rule, label: label || undefined, operationId };
  },
});
