import { describe, expect, test } from 'bun:test';
import './tools/harness';
import * as mailMutate from '../lib/tools/mail-mutate';
import { archiveThread, markThreadRead, snoozeThreadTool } from '../lib/tools/mail-mutate';
import { runTool, seedThreadMessage } from './tools/harness';

describe('mail mutate tools — Nylas guards', () => {
  test('provider mutations fail clearly without a connected account', async () => {
    const { account, threadId } = await seedThreadMessage();
    await expect(runTool(archiveThread.handler, { account, threadId })).rejects.toThrow(
      /Nylas account|Convex/,
    );
    await expect(runTool(markThreadRead.handler, { account, threadId })).rejects.toThrow(
      /Nylas account|Convex/,
    );
    // MUT-1: snooze moves real mail, so without a provider it fails loudly
    // instead of reporting a snooze that nothing would honor.
    await expect(
      runTool(snoozeThreadTool.handler, { account, threadId, untilTs: Date.now() + 3_600_000 }),
    ).rejects.toThrow(/Nylas account|Convex/);
  });

  test('set_smart_category is gone; corrections go through apply_smart_correction (CLS-14)', () => {
    expect('setSmartCategoryTool' in mailMutate).toBe(false);
  });
});
