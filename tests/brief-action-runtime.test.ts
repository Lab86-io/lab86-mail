import { describe, expect, test } from 'bun:test';
import {
  briefActionReviewCopy,
  payloadForBriefAction,
} from '../components/report/brief-canvas/brief-action-runtime';

describe('brief action runtime', () => {
  test('fills stable action identities from source refs without overriding authored payload', () => {
    expect(
      payloadForBriefAction(
        { action: 'open_thread', label: 'Open', payload: {}, style: 'quiet' },
        { kind: 'thread', id: 'thread-1', account: 'account-1' },
      ),
    ).toEqual({ account: 'account-1', threadId: 'thread-1' });
    expect(
      payloadForBriefAction(
        {
          action: 'toggle_task',
          label: 'Done',
          payload: { cardId: 'authored', completed: true },
          style: 'quiet',
        },
        { kind: 'card', id: 'ref-card' },
      ),
    ).toEqual({ cardId: 'authored', completed: true });
  });

  test('review copy communicates the consequential effect', () => {
    const copy = briefActionReviewCopy(
      {
        action: 'create_event',
        label: 'Add',
        payload: {},
        style: 'primary',
      },
      { title: 'Design review' },
    );
    expect(copy.title).toContain('Design review');
    expect(copy.confirm).toBe('Add event');
  });
});

describe('brief telemetry request', () => {
  test('builds the events body from the region, the ref, and the outcome', async () => {
    const { briefEventRequest } = await import('../components/report/brief-canvas/brief-action-runtime');
    expect(
      briefEventRequest({
        reportId: 'report-1',
        surface: 'daily',
        regionId: 'answer',
        action: 'draft_reply',
        ref: { kind: 'thread', id: 'thread-1', account: 'me@example.com', label: 'Subject' },
        outcome: 'done',
      }),
    ).toEqual({
      reportId: 'report-1',
      surface: 'daily',
      regionId: 'answer',
      action: 'draft_reply',
      ref: { kind: 'thread', id: 'thread-1', account: 'me@example.com' },
      outcome: 'done',
    });
  });

  test('falls back to the payload identity, defaults to daily, and skips half-formed rows', async () => {
    const { briefEventRequest } = await import('../components/report/brief-canvas/brief-action-runtime');
    expect(
      briefEventRequest({
        regionId: 'tasks',
        action: 'toggle_task',
        payload: { cardId: 'card-1', completed: true },
        outcome: 'undone',
      }),
    ).toEqual({
      surface: 'daily',
      regionId: 'tasks',
      action: 'toggle_task',
      ref: { kind: 'card', id: 'card-1' },
      outcome: 'undone',
    });
    expect(
      briefEventRequest({
        regionId: '',
        action: 'open_thread',
        ref: { kind: 'thread', id: 't' },
        outcome: 'opened',
      }),
    ).toBeNull();
    expect(
      briefEventRequest({ regionId: 'answer', action: 'open_view', payload: {}, outcome: 'opened' }),
    ).toBeNull();
  });

  test('a connected-tool ref adds nothing to the authored payload', () => {
    expect(
      payloadForBriefAction(
        { action: 'open_url', label: 'Open', payload: { url: 'https://example.com/x' }, style: 'quiet' },
        { kind: 'mcp', id: 'external-1' },
      ),
    ).toEqual({ url: 'https://example.com/x' });
  });
});
