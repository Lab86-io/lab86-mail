import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  uiCloseBar,
  uiFocusThread,
  uiOpenCompose,
  uiOpenReply,
  uiSetQuery,
  uiSwitchAccount,
  uiToast,
} from '../lib/tools/ui-tools';
import { runTool } from './tools/harness';

describe('UI tools', () => {
  test('return acknowledged no-op payloads', async () => {
    expect(
      await runTool(uiFocusThread.handler, { threadId: 'thread_123', account: 'jakob@example.test' }),
    ).toEqual({
      acknowledged: true,
      hint: 'UI will focus thread thread_123.',
    });
    expect(
      await runTool(uiSetQuery.handler, { query: 'from:alex newer_than:7d', label: 'From Alex' }),
    ).toEqual({
      acknowledged: true,
      hint: 'UI will run "from:alex newer_than:7d".',
    });
    expect(await runTool(uiOpenCompose.handler, { to: 'alex@example.test', subject: 'Hello' })).toEqual({
      acknowledged: true,
      hint: 'Compose pane opened — user will review and send.',
    });
    expect(await runTool(uiOpenReply.handler, { threadId: 'thread_123', body: 'Thanks!' })).toEqual({
      acknowledged: true,
    });
    expect(await runTool(uiToast.handler, { message: 'Saved', kind: 'success' })).toEqual({
      acknowledged: true,
    });
    expect(await runTool(uiCloseBar.handler, {})).toEqual({ acknowledged: true });
    expect(await runTool(uiSwitchAccount.handler, { account: 'jakob@example.test' })).toEqual({
      acknowledged: true,
      hint: 'Switched to jakob@example.test',
    });
  });
});
