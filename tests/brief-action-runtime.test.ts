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
