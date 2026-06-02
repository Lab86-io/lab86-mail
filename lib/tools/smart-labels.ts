import { z } from 'zod';
import { classifyThreadWithContext, SMART_CATEGORY_IDS } from '../mail/smart-categories';
import { emailFromHeader } from '../shared/format';
import type { SmartRule } from '../shared/types';
import {
  listSmartCorrections as listSmartCorrectionRecords,
  writeSmartCorrection,
} from '../store/smart-corrections';
import {
  createSmartLabel as createSmartLabelRecord,
  disableSmartLabel,
  listSmartLabels as listSmartLabelRecords,
  updateSmartLabel as updateSmartLabelRecord,
} from '../store/smart-labels';
import {
  createSmartRule as createSmartRuleRecord,
  listSmartRules as listSmartRuleRecords,
  setSmartRuleEnabled,
} from '../store/smart-rules';
import { getThread, listRecentThreads, setThreadSmartCategory } from '../store/threads';
import { defineTool } from './registry';

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
    'Create a local AI-only smart label. Requires a description plus positive and negative examples. Does not create Gmail labels.',
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
      gmailLabelName: `MailOS/${args.name}`,
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
  description: 'Disable a local custom smart label.',
  category: 'mail',
  mutating: true,
  input: z.object({ id: z.string() }),
  output: z.object({ label: z.any() }),
  async handler({ id }) {
    const label = await disableSmartLabel(id);
    return { label };
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
  output: z.object({ rule: z.any() }),
  async handler(args, ctx) {
    const rule = await createSmartRuleRecord({
      ...args,
      source: args.source || (ctx.agent === 'ai' ? 'agent' : 'settings'),
    });
    return { rule };
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
  output: z.object({ ok: z.boolean(), rule: z.any().optional(), label: z.any().optional() }),
  async handler({ account, threadId, action, scope = 'sender', category, customLabelId, newLabel }, ctx) {
    const thread = await getThread(account, threadId);
    if (!thread) throw new Error('Thread not found in local cache');
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
    const smartCategory = classifyThreadWithContext(thread, { rules, customLabels: labels });
    await setThreadSmartCategory(account, threadId, smartCategory).catch(() => undefined);
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
    return { ok: true, rule, label: label || undefined };
  },
});

export const markSenderHuman = defineTool({
  name: 'mark_sender_human',
  description:
    'Teach the classifier that a sender is a real person: always route their mail to Main. Reuses the smart-rule store; does not mutate Gmail. Used by the daily report "This is a person" control so a missed human self-corrects next run.',
  category: 'mail',
  mutating: true,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({ ok: z.boolean(), rule: z.any() }),
  async handler({ account, threadId }) {
    const thread = await getThread(account, threadId);
    if (!thread) throw new Error('Thread not found in local cache');
    const email = threadEmail(thread);
    if (!email) throw new Error('No sender email to mark as human');
    const previousCategory = thread.smartCategory?.primary;
    const rule = await createSmartRuleRecord({
      name: 'mark sender human',
      scope: 'sender',
      match: email,
      effect: 'always_category',
      category: 'main',
      reason: 'Marked as a real person from the daily report',
      source: 'quick_fix',
    });
    const [rules, labels] = await Promise.all([listSmartRuleRecords(), listSmartLabelRecords()]);
    const smartCategory = classifyThreadWithContext(thread, { rules, customLabels: labels });
    await setThreadSmartCategory(account, threadId, smartCategory).catch(() => undefined);
    await writeSmartCorrection({
      account,
      threadId,
      fromEmail: email,
      fromDomain: threadDomain(thread),
      subject: thread.subject,
      previousCategory,
      newCategory: smartCategory.primary,
      ruleId: rule._id,
      action: 'move_to',
    });
    return { ok: true, rule };
  },
});
