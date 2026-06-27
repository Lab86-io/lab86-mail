import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getDraft } from '../lib/store/drafts';
import { listDueSnoozes } from '../lib/store/snooze';
import { getThread } from '../lib/store/threads';
import { deleteDraftTool, listDraftsTool, saveDraftTool, updateDraft } from '../lib/tools/compose';
import { snoozeThreadTool, unsnoozeThreadTool } from '../lib/tools/mail-mutate';
import { listMemories, recall, remember } from '../lib/tools/memories';
import {
  createSmartLabel,
  createSmartRule,
  listSmartLabels,
  listSmartRules,
} from '../lib/tools/smart-labels';
import {
  getTrackedThreadTool,
  listTrackedThreadsTool,
  resolveTrackedThread,
  trackThread,
  updateTrackedThreadTool,
} from '../lib/tools/tracked-threads';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

describe('representative agent local-store smoke flow', () => {
  test('round-trips memory, draft, snooze, label, rule, and tracking mutations', async () => {
    const { account, messageId, threadId } = await seedThreadMessage({
      threadId: 'thread_smoke_contract',
      messageId: 'msg_smoke_contract',
      subject: 'Regression contract review',
      from: 'Counsel <counsel@example.test>',
      textBody: 'Please review the revised agreement by Friday.',
    });

    const memory = await runTool(remember.handler, {
      email: 'counsel@example.test',
      notes: 'Prefers concise legal summaries.',
    });
    expect(memory.ok).toBe(true);
    expect((await runTool(recall.handler, { email: 'counsel@example.test' })).memory?.notes).toContain(
      'legal summaries',
    );
    expect(
      (await runTool(listMemories.handler, {})).memories.some((row) => row.email === 'counsel@example.test'),
    ).toBe(true);

    const draft = await runTool(saveDraftTool.handler, {
      account,
      to: 'counsel@example.test',
      subject: 'Re: Regression contract review',
      body: 'I will review this today.',
    });
    const updatedDraft = await runTool(updateDraft.handler, {
      id: draft.draft._id,
      patch: { body: 'I reviewed this and left comments.' },
    });
    expect(updatedDraft.ok).toBe(true);
    expect(await withToolContext(() => getDraft(draft.draft._id))).toMatchObject({
      body: 'I reviewed this and left comments.',
    });
    expect(
      (await runTool(listDraftsTool.handler, { account })).drafts.some(
        (row: any) => row._id === draft.draft._id,
      ),
    ).toBe(true);
    await runTool(deleteDraftTool.handler, { id: draft.draft._id });
    expect(await withToolContext(() => getDraft(draft.draft._id))).toBeNull();

    const untilTs = Date.parse('2026-06-15T13:00:00.000Z');
    await runTool(snoozeThreadTool.handler, { account, messageId, threadId, untilTs });
    expect(
      (await withToolContext(() => listDueSnoozes(Number.POSITIVE_INFINITY))).some(
        (row) => row.account === account && row.messageId === messageId,
      ),
    ).toBe(true);
    await runTool(unsnoozeThreadTool.handler, { account, messageId });
    expect(
      (await withToolContext(() => listDueSnoozes(Number.POSITIVE_INFINITY))).some(
        (row) => row.account === account && row.messageId === messageId,
      ),
    ).toBe(false);

    const label = await runTool(createSmartLabel.handler, {
      name: 'Legal smoke',
      description: 'Legal review threads used by the smoke contract.',
      positiveExamples: ['agreement redlines'],
      negativeExamples: ['newsletter'],
    });
    expect(
      (await runTool(listSmartLabels.handler, {})).custom.some((row: any) => row._id === label.label._id),
    ).toBe(true);

    const rule = await runTool(createSmartRule.handler, {
      name: 'Counsel to review',
      scope: 'sender',
      match: 'counsel@example.test',
      effect: 'always_category',
      category: 'review',
    });
    expect(
      (await runTool(listSmartRules.handler, { includeDisabled: true })).rules.some(
        (row: any) => row._id === rule.rule._id,
      ),
    ).toBe(true);

    const tracked = await runTool(trackThread.handler, {
      account,
      threadId,
      reason: 'Waiting on legal review',
      status: 'open',
      openLoops: ['Review agreement'],
      nextAction: 'Read redlines',
    });
    expect((await runTool(getTrackedThreadTool.handler, { account, threadId })).tracked?._id).toBe(
      tracked.tracked._id,
    );
    const updated = await runTool(updateTrackedThreadTool.handler, {
      id: tracked.tracked._id,
      status: 'waiting',
      nextAction: 'Wait for counsel',
    });
    expect(updated.tracked.status).toBe('waiting');
    expect((await runTool(listTrackedThreadsTool.handler, { includeResolved: false })).tracked).toEqual(
      expect.arrayContaining([expect.objectContaining({ _id: tracked.tracked._id })]),
    );
    const resolved = await runTool(resolveTrackedThread.handler, {
      id: tracked.tracked._id,
      reason: 'Review complete',
    });
    expect(resolved.tracked.status).toBe('resolved');
    expect((await withToolContext(() => getThread(account, threadId)))?.subject).toBe(
      'Regression contract review',
    );
  });
});
