import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { ScheduledSendsList } from '../components/inbox/ScheduledSends';
import { loadScheduledSends, normalizeScheduledSend, scheduledSendState } from '../lib/shell/scheduled-sends';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const acct = { account: 'acc_1', label: 'me@example.test' };

test('provider status codes map to one state', () => {
  expect(scheduledSendState('pending')).toBe('pending');
  expect(scheduledSendState('close_to_send_time')).toBe('pending');
  expect(scheduledSendState('sucess')).toBe('sent');
  expect(scheduledSendState('failed')).toBe('failed');
  expect(scheduledSendState('cancelled')).toBe('cancelled');
});

test('scheduled sends are read from every mailbox, and only waiting ones are kept', async () => {
  const list = mock(async (account: string) => {
    if (account === 'acc_2') throw new Error('Reconnect needed');
    return {
      scheduled: [
        { scheduleId: 8, status: { code: 'pending' }, closeTime: 1_900_000_000 },
        { schedule_id: '7', status: { code: 'pending' }, close_time: 1_800_000_000_000 },
        { scheduleId: 9, status: { code: 'sucess' }, closeTime: 1_700_000_000 },
        { status: { code: 'pending' } },
      ],
    };
  });
  const result = await loadScheduledSends([acct, { account: 'acc_2', label: 'work@example.test' }], list);
  expect(result.failedAccounts).toEqual(['work@example.test']);
  expect(result.rows.map((r) => [r.scheduleId, r.at])).toEqual([
    ['7', 1_800_000_000_000],
    ['8', 1_900_000_000_000],
  ]);
  expect(normalizeScheduledSend({ id: 'x', status: 'pending' }, acct)?.at).toBeNull();
});

test('the list shows each send with Cancel and names mailboxes it could not read', async () => {
  const onCancel = mock(() => {});
  const row = {
    account: 'acc_1',
    accountLabel: 'me@example.test',
    scheduleId: '7',
    state: 'pending' as const,
    at: null,
  };
  let view: any;
  await act(async () => {
    view = create(
      <ScheduledSendsList
        loading={false}
        error={false}
        rows={[row]}
        failedAccounts={['work@example.test']}
        onCancel={onCancel}
      />,
    );
  });
  const button = view.root.findByType('button');
  await act(async () => button.props.onClick());
  expect(onCancel).toHaveBeenCalledWith(row);
  const html = renderToStaticMarkup(
    <ScheduledSendsList
      loading={false}
      error={false}
      rows={[row]}
      failedAccounts={['work@example.test']}
      onCancel={onCancel}
    />,
  );
  expect(html).toContain('Cancel send');
  expect(html).toContain('Could not read scheduled sends for work@example.test.');
  expect(
    renderToStaticMarkup(
      <ScheduledSendsList loading={false} error={false} rows={[]} failedAccounts={[]} onCancel={onCancel} />,
    ),
  ).toContain('Nothing is scheduled.');
  await act(async () => view.unmount());
});
