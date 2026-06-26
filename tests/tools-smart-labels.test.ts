import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  applySmartCorrection,
  createSmartLabel,
  createSmartRule,
  deleteSmartLabel,
  listSmartLabels,
  listSmartRules,
  markSenderHuman,
  previewSmartLabel,
  setSmartRuleEnabledTool,
  updateSmartLabel,
} from '../lib/tools/smart-labels';
import { runTool, seedThreadMessage } from './tools/harness';

describe('smart label and rule tools', () => {
  test('creates, lists, updates, and disables custom labels', async () => {
    const created = await runTool(createSmartLabel.handler, {
      name: 'Launch',
      description: 'Product launch threads',
      positiveExamples: ['launch checklist', 'go-live plan'],
      negativeExamples: ['newsletter promo'],
    });
    expect(created.label.name).toBe('Launch');

    const listed = await runTool(listSmartLabels.handler, {});
    expect(listed.custom.some((label: any) => label._id === created.label._id)).toBe(true);
    expect(listed.builtins.length).toBeGreaterThan(5);

    const updated = await runTool(updateSmartLabel.handler, {
      id: created.label._id,
      description: 'Updated launch description',
    });
    expect(updated.label.description).toBe('Updated launch description');

    const disabled = await runTool(deleteSmartLabel.handler, { id: created.label._id });
    expect(disabled.label.enabled).toBe(false);
  });

  test('creates rules and toggles enabled state', async () => {
    const created = await runTool(createSmartRule.handler, {
      name: 'Always finance',
      scope: 'sender',
      match: 'billing@example.test',
      effect: 'always_category',
      category: 'finance_admin',
    });
    expect(created.rule.enabled).toBe(true);

    const disabled = await runTool(setSmartRuleEnabledTool.handler, { id: created.rule._id, enabled: false });
    expect(disabled.rule.enabled).toBe(false);

    const listed = await runTool(listSmartRules.handler, { includeDisabled: true });
    expect(listed.rules.some((rule: any) => rule._id === created.rule._id)).toBe(true);
    expect(Array.isArray(listed.corrections)).toBe(true);
  });

  test('previewSmartLabel scans cached threads', async () => {
    await seedThreadMessage({
      subject: 'Launch checklist for Friday',
      textBody: 'Here is the go-live plan.',
      from: 'PM <pm@example.test>',
    });
    const preview = await runTool(previewSmartLabel.handler, {
      name: 'Launch',
      description: 'Launch planning threads',
      positiveExamples: ['launch checklist', 'go-live plan'],
      negativeExamples: ['weekly newsletter'],
      max: 10,
    });
    expect(Array.isArray(preview.items)).toBe(true);
  });

  test('apply_smart_correction and mark_sender_human update local categories', async () => {
    const { account, threadId } = await seedThreadMessage({
      from: 'Human Friend <friend@example.test>',
      subject: 'Coffee tomorrow?',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    });

    const corrected = await runTool(applySmartCorrection.handler, {
      account,
      threadId,
      action: 'move_to',
      category: 'main',
    });
    expect(corrected.ok).toBe(true);
    expect(corrected.rule).toBeTruthy();

    const marked = await runTool(markSenderHuman.handler, { account, threadId });
    expect(marked.ok).toBe(true);
    expect(marked.rule.scope).toBe('sender');
  });

  test('apply_smart_correction requires move_to targets', async () => {
    const { account, threadId } = await seedThreadMessage();
    await expect(
      runTool(applySmartCorrection.handler, { account, threadId, action: 'move_to' }),
    ).rejects.toThrow(/category or customLabelId/);
  });
});
