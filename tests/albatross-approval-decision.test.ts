import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  APPROVAL_COPY,
  approvalDetailParts,
  approvalRowLine,
  approvalView,
  DECIDED_ROW_MS,
  decideApproval,
  retainDecidedApprovals,
  useApprovalDecisions,
} from '../lib/albatross/approval-decision';
import { seedApprovalPreview } from '../lib/albatross/approval-fixtures';

/* One decision on one approval, for every web surface. */

const INVITE = { id: 'ap1', status: 'pending', kind: 'calendar_invite' };
const at = 1_000;

beforeEach(() => {
  useApprovalDecisions.setState({ decisions: {} });
});

describe('approvalView', () => {
  test('a waiting row can take a decision and has no outcome line', () => {
    expect(approvalView(INVITE)).toMatchObject({ state: 'waiting', canDecide: true, line: null });
  });

  test('a press in flight offers no second press', () => {
    const view = approvalView(INVITE, { state: 'deciding', choice: 'approve', at });
    expect(view).toMatchObject({ state: 'deciding', canDecide: false, line: APPROVAL_COPY.approving });
    expect(approvalView(INVITE, { state: 'deciding', choice: 'decline', at }).line).toBe(
      APPROVAL_COPY.declining,
    );
  });

  test('a claim that never ended offers the press again and says what to check', () => {
    expect(approvalView({ ...INVITE, status: 'pending', staleClaim: true })).toMatchObject({
      state: 'waiting',
      canDecide: true,
      line: APPROVAL_COPY.staleClaim,
    });
  });

  test('a claiming row from another client offers no press', () => {
    expect(approvalView({ ...INVITE, status: 'claiming' })).toMatchObject({
      state: 'deciding',
      canDecide: false,
    });
  });

  test('each kind says what went out, and a run that goes on says so', () => {
    const approved = { state: 'approved' as const, at, goesOn: false };
    expect(approvalView(INVITE, approved).line).toBe('Approved. The invite went out.');
    expect(approvalView({ ...INVITE, kind: 'calendar_rsvp' }, approved).line).toBe(
      'Approved. Your answer went out.',
    );
    expect(approvalView({ ...INVITE, kind: 'email_send' }, approved).line).toBe(
      'Approved. The email went out.',
    );
    expect(approvalView({ ...INVITE, kind: 'external_action' }, approved).line).toBe(
      'Approved. It went out.',
    );
    expect(approvalView(INVITE, { ...approved, goesOn: true }).line).toBe(
      `Approved. The invite went out. ${APPROVAL_COPY.goesOn}`,
    );
    expect(approvalView(INVITE, approved)).toMatchObject({
      canDecide: false,
      word: 'Approved',
      tone: 'done',
    });
  });

  test('a decline says that nothing went out', () => {
    expect(approvalView(INVITE, { state: 'declined', at })).toMatchObject({
      state: 'declined',
      canDecide: false,
      line: 'Declined. Nothing went out.',
    });
  });

  test('a failure shows the message and can try again', () => {
    expect(approvalView(INVITE, { state: 'failed', message: 'Calendar is offline.', at })).toMatchObject({
      state: 'failed',
      canDecide: true,
      tone: 'hot',
      line: 'Calendar is offline.',
    });
  });

  test('a final server row wins over this client, so a decision on iPhone shows here', () => {
    const local = { state: 'deciding' as const, choice: 'decline' as const, at };
    expect(approvalView({ ...INVITE, status: 'approved' }, local).state).toBe('approved');
    expect(approvalView({ ...INVITE, status: 'rejected' }, local).state).toBe('declined');
    expect(approvalView({ ...INVITE, status: 'expired' }).line).toBe(APPROVAL_COPY.expired);
    expect(approvalView({ ...INVITE, status: 'undone' }).line).toBe(APPROVAL_COPY.undone);
    expect(approvalView({ ...INVITE, status: 'expired' }).canDecide).toBe(false);
  });

  test('a claim from another client outranks an old failure here', () => {
    const failed = { state: 'failed' as const, message: 'Old failure.', at };
    expect(approvalView({ ...INVITE, status: 'claiming' }, failed).canDecide).toBe(false);
  });
});

describe('approval detail words', () => {
  const detail =
    'To Dana Reyes <dana@example.com>, sam@example.com. Starts Nov 5, 2026, 2:00 PM. From the goal "Kickoff".';

  test('the detail splits what goes out from where it came from', () => {
    expect(approvalDetailParts(detail)).toEqual({
      what: 'To Dana Reyes <dana@example.com>, sam@example.com. Starts Nov 5, 2026, 2:00 PM.',
      from: 'From the goal "Kickoff".',
    });
  });

  test('an older row has only where it came from', () => {
    expect(approvalDetailParts('From the step "Kickoff".')).toEqual({
      what: '',
      from: 'From the step "Kickoff".',
    });
    expect(approvalDetailParts(null)).toEqual({ what: '', from: null });
    expect(approvalDetailParts('2 attendees will be notified.')).toEqual({
      what: '2 attendees will be notified.',
      from: null,
    });
  });

  test('a row names people without their addresses, and keeps an address with no name', () => {
    expect(approvalRowLine(detail)).toBe('To Dana Reyes, sam@example.com. Starts Nov 5, 2026, 2:00 PM.');
    expect(approvalRowLine('From the step "Kickoff".')).toBe('From the step "Kickoff".');
    expect(approvalRowLine(undefined)).toBe('');
  });
});

describe('decideApproval', () => {
  test('Approve calls the same tool as iOS and records what the server did', async () => {
    const call = mock(async (_name: string, _args: Record<string, unknown>) => ({
      ok: true,
      followUp: { action: 'continued', nextRunId: 'run-2' },
    }));
    useApprovalDecisions.setState({ call });
    const pending = decideApproval(INVITE, 'approve');
    expect(useApprovalDecisions.getState().decisions.ap1).toMatchObject({
      state: 'deciding',
      choice: 'approve',
    });
    await pending;
    expect(call).toHaveBeenCalledWith('albatross_approve_action', { approvalId: 'ap1' });
    expect(useApprovalDecisions.getState().decisions.ap1).toMatchObject({ state: 'approved', goesOn: true });
  });

  test('Decline calls the reject tool', async () => {
    const call = mock(async (_name: string, _args: Record<string, unknown>) => ({ ok: true }));
    useApprovalDecisions.setState({ call });
    await decideApproval(INVITE, 'decline');
    expect(call).toHaveBeenCalledWith('albatross_reject_action', { approvalId: 'ap1' });
    expect(useApprovalDecisions.getState().decisions.ap1).toMatchObject({ state: 'declined' });
  });

  test('a second press while the first is in flight sends nothing', async () => {
    let release: (value: unknown) => void = () => undefined;
    const call = mock(() => new Promise((resolve) => (release = resolve)));
    useApprovalDecisions.setState({ call });
    const first = decideApproval(INVITE, 'approve');
    await decideApproval(INVITE, 'approve');
    await decideApproval(INVITE, 'decline');
    expect(call).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await first;
    await decideApproval(INVITE, 'approve');
    expect(call).toHaveBeenCalledTimes(1);
  });

  test('a claiming row sends nothing', async () => {
    const call = mock(async () => ({ ok: true }));
    useApprovalDecisions.setState({ call });
    await decideApproval({ ...INVITE, status: 'claiming' }, 'approve');
    expect(call).not.toHaveBeenCalled();
  });

  test('a failure keeps the real message, and the next press tries again', async () => {
    const call = mock(async () => {
      throw new Error('This was already declined.');
    });
    useApprovalDecisions.setState({ call });
    await decideApproval(INVITE, 'approve');
    expect(useApprovalDecisions.getState().decisions.ap1).toMatchObject({
      state: 'failed',
      message: 'This was already declined.',
    });
    await decideApproval(INVITE, 'approve');
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('a failure with no message has plain words', async () => {
    useApprovalDecisions.setState({
      call: async () => {
        throw 'odd';
      },
    });
    await decideApproval(INVITE, 'decline');
    expect(useApprovalDecisions.getState().decisions.ap1).toMatchObject({ message: APPROVAL_COPY.failed });
  });

  test('the default caller goes through the tool route', async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return Response.json({ ok: true, result: { ok: true } });
    }) as typeof fetch;
    try {
      const { call } = useApprovalDecisions.getInitialState();
      await call('albatross_reject_action', { approvalId: 'ap1' });
      expect(urls).toEqual(['/api/tools/albatross_reject_action']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('retainDecidedApprovals', () => {
  const row = { id: 'approval:ap1', approval: { id: 'ap1' } };
  const seen = new Map([[row.id, row]]);

  test('a row the user just decided stays after the live queue drops it', () => {
    const decisions = { ap1: { state: 'approved' as const, at, goesOn: false } };
    expect(retainDecidedApprovals([], seen, decisions, at + 1)).toEqual([row]);
    expect(retainDecidedApprovals([], seen, { ap1: { state: 'declined', at } }, at + 1)).toEqual([row]);
  });

  test('it leaves after the window', () => {
    const decisions = { ap1: { state: 'approved' as const, at, goesOn: false } };
    expect(retainDecidedApprovals([], seen, decisions, at + DECIDED_ROW_MS)).toEqual([]);
  });

  test('a row decided on another client just leaves', () => {
    expect(retainDecidedApprovals([], seen, {}, at)).toEqual([]);
  });

  test('a failed row and a row still in the list do not repeat', () => {
    const items = [row];
    expect(retainDecidedApprovals(items, seen, { ap1: { state: 'approved', at, goesOn: false } }, at)).toBe(
      items,
    );
    expect(retainDecidedApprovals([], seen, { ap1: { state: 'failed', message: 'x', at } }, at)).toEqual([]);
    const plain = { id: 'question:q1' };
    expect(retainDecidedApprovals([], new Map([[plain.id, plain]]), {}, at)).toEqual([]);
  });
});

describe('seedApprovalPreview', () => {
  test('it puts one approval in the state the query names, and clears it', async () => {
    seedApprovalPreview('ap1', 'failed');
    expect(useApprovalDecisions.getState().decisions.ap1).toMatchObject({ state: 'failed' });
    seedApprovalPreview('ap1', 'waiting');
    expect(useApprovalDecisions.getState().decisions.ap1).toBeUndefined();
    seedApprovalPreview('ap1', null);
    expect(useApprovalDecisions.getState().decisions.ap1).toBeUndefined();
    const { call } = useApprovalDecisions.getState();
    expect(await call('albatross_approve_action', {})).toMatchObject({ followUp: { action: 'continued' } });
    expect(await call('albatross_reject_action', {})).toEqual({ ok: true });
    useApprovalDecisions.setState({ call: useApprovalDecisions.getInitialState().call });
  });
});
