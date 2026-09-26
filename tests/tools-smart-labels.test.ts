import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getThread } from '../lib/store/threads';
import {
  applySmartCorrection,
  createSmartLabel,
  createSmartRule,
  deleteSmartLabel,
  listSmartLabels,
  listSmartRules,
  previewSmartLabel,
  setSmartRuleEnabledTool,
  updateSmartLabel,
} from '../lib/tools/smart-labels';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

describe('smart label and rule tools', () => {
  test('creates, lists, updates, disables, and deletes custom labels', async () => {
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

    // Disable keeps the label, so the settings dialog can enable it again.
    const disabled = await runTool(updateSmartLabel.handler, { id: created.label._id, enabled: false });
    expect(disabled.label.enabled).toBe(false);
    const withDisabled = await runTool(listSmartLabels.handler, { includeDisabled: true });
    expect(withDisabled.custom.some((label: any) => label._id === created.label._id)).toBe(true);
    const reenabled = await runTool(updateSmartLabel.handler, { id: created.label._id, enabled: true });
    expect(reenabled.label.enabled).toBe(true);
  });

  test('delete removes the label and turns off the rules that file mail under it', async () => {
    const created = await runTool(createSmartLabel.handler, {
      name: 'Receipts Box',
      description: 'Receipts',
      positiveExamples: ['receipt'],
      negativeExamples: ['newsletter'],
    });
    expect(created.label.gmailLabelName).toBe('Albatross/Receipts Box');
    const filing = await runTool(createSmartRule.handler, {
      name: 'File receipts',
      scope: 'sender',
      match: 'shop@example.test',
      effect: 'always_custom_label',
      customLabelId: created.label._id,
    });
    const other = await runTool(createSmartRule.handler, {
      name: 'Other rule',
      scope: 'sender',
      match: 'news@example.test',
      effect: 'always_noise',
    });

    const deleted = await runTool(deleteSmartLabel.handler, { id: created.label._id });
    expect(deleted.label._id).toBe(created.label._id);
    expect(deleted.disabledRuleIds).toEqual([filing.rule._id]);

    const listed = await runTool(listSmartLabels.handler, { includeDisabled: true });
    expect(listed.custom.some((label: any) => label._id === created.label._id)).toBe(false);
    const rules = await runTool(listSmartRules.handler, { includeDisabled: true });
    expect(rules.rules.find((rule: any) => rule._id === filing.rule._id)?.enabled).toBe(false);
    expect(rules.rules.find((rule: any) => rule._id === other.rule._id)?.enabled).toBe(true);

    // The name is free again after a real delete.
    const again = await runTool(createSmartLabel.handler, {
      name: 'Receipts Box',
      description: 'Receipts',
      positiveExamples: ['receipt'],
      negativeExamples: ['newsletter'],
    });
    expect(again.label._id).not.toBe(created.label._id);
    await expect(runTool(deleteSmartLabel.handler, { id: 'missing-label' })).rejects.toThrow(/not found/);
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
    const { threadId } = await seedThreadMessage({
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
    expect(
      preview.items.some(
        (item: any) => item._id === threadId || item.subject === 'Launch checklist for Friday',
      ),
    ).toBe(true);
  });

  test('apply_smart_correction records the new category', async () => {
    const { account, threadId } = await seedThreadMessage({
      threadId: 'cls14-correction-thread',
      messageId: 'cls14-correction-message',
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

    const { corrections } = await runTool(listSmartRules.handler, { correctionLimit: 10 });
    const byRule = new Map(corrections.map((item: any) => [item.ruleId, item]));
    expect((byRule.get(corrected.rule._id) as any)?.newCategory).toBe('main');
    // The corpus row is the stored verdict. The unused local thread cache is
    // not written.
    const cached = await withToolContext(() => getThread(account, threadId));
    expect(cached?.smartCategory ?? null).toBeNull();
  });

  test('apply_smart_correction requires move_to targets', async () => {
    const { account, threadId } = await seedThreadMessage();
    await expect(
      runTool(applySmartCorrection.handler, { account, threadId, action: 'move_to' }),
    ).rejects.toThrow(/category or customLabelId/);
  });
});
