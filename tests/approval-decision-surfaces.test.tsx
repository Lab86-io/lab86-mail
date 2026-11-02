import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  ApprovalDecision,
  focusApprovalControl,
  useRetainedApprovals,
} from '../components/albatross/ApprovalDecision';
import { RunBlock } from '../components/albatross/thread/RunBlock';
import { type NotificationItem, projectNotifications } from '../components/notifications/model';
import { NotificationsView } from '../components/notifications/NotificationsSurface';
import { useApprovalDecisions } from '../lib/albatross/approval-decision';
import { THREAD_FIXTURE_APPROVAL_ID, threadApprovalRunFixture } from '../lib/albatross/thread-fixtures';

/* The control on each surface, with the live store. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const noop = () => undefined;
const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const NAMES = [
  'window',
  'document',
  'navigator',
  'IS_REACT_ACT_ENVIRONMENT',
  'CSS',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  for (const name of NAMES) saved[name] = globals[name];
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.CSS = { escape: (value: string) => value };
  globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
  globals.cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete globals[name];
    else globals[name] = saved[name];
  }
});
afterEach(() => {
  useApprovalDecisions.setState({ decisions: {}, call: useApprovalDecisions.getInitialState().call });
});

const INVITE = { id: 'ap1', status: 'pending', kind: 'calendar_invite' };
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');
const pressable = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByType('button').map((button) => textOf(button));
const press = async (renderer: ReactTestRenderer, label: string) => {
  const button = renderer.root.findAllByType('button').find((node) => textOf(node) === label);
  if (!button) throw new Error(`No button ${label}`);
  await act(async () => button.props.onClick({ stopPropagation: noop }));
};
const mount = async (element: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
};

describe('ApprovalDecision', () => {
  test('waiting: both presses and the note', async () => {
    const renderer = await mount(
      <ApprovalDecision approval={INVITE} note="It goes out only after you approve it." />,
    );
    expect(pressable(renderer)).toEqual(['Approve', 'Decline']);
    expect(textOf(renderer.root)).toContain('It goes out only after you approve it.');
  });

  test('deciding: no press, a status line, and the second click cannot happen', async () => {
    let release: (value: unknown) => void = noop;
    const calls: string[] = [];
    useApprovalDecisions.setState({
      call: (name: string) => {
        calls.push(name);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const renderer = await mount(<ApprovalDecision approval={INVITE} />);
    await press(renderer, 'Approve');
    expect(pressable(renderer)).toEqual([]);
    const status = renderer.root.findAll((node) => node.type === 'p' && node.props.role === 'status');
    expect(status).toHaveLength(1);
    await act(async () => release({ ok: true, followUp: { action: 'none' } }));
    expect(calls).toEqual(['albatross_approve_action']);
    expect(textOf(renderer.root)).toBe('Approved. The invite went out.');
  });

  test('approved and the run goes on: the line says so, and the note and presses leave', async () => {
    useApprovalDecisions.setState({
      call: async () => ({ ok: true, followUp: { action: 'continued', nextRunId: 'run-2' } }),
    });
    const renderer = await mount(<ApprovalDecision approval={INVITE} note="A note." />);
    await press(renderer, 'Approve');
    expect(textOf(renderer.root)).toBe(
      'Approved. The invite went out. Albatross goes on with the next part.',
    );
    expect(pressable(renderer)).toEqual([]);
  });

  test('declined: the line says that nothing went out, and the quiet link stays', async () => {
    useApprovalDecisions.setState({ call: async () => ({ ok: true }) });
    const renderer = await mount(<ApprovalDecision approval={INVITE} end={<a href="/x">Open</a>} />);
    await press(renderer, 'Decline');
    expect(textOf(renderer.root)).toBe('Declined. Nothing went out.Open');
  });

  test('failed: an alert with the real message, and both presses stay', async () => {
    useApprovalDecisions.setState({
      call: async () => {
        throw new Error('This was already declined.');
      },
    });
    const renderer = await mount(<ApprovalDecision approval={INVITE} />);
    await press(renderer, 'Approve');
    const alert = renderer.root.findAll((node) => node.type === 'p' && node.props.role === 'alert');
    expect(textOf(alert[0])).toBe('This was already declined.');
    expect(pressable(renderer)).toEqual(['Approve', 'Decline']);
  });

  test('claiming: no press at all', async () => {
    const renderer = await mount(<ApprovalDecision approval={{ ...INVITE, status: 'claiming' }} />);
    expect(pressable(renderer)).toEqual([]);
    expect(textOf(renderer.root)).toBe('Albatross sends it now.');
  });
});

describe('the thread', () => {
  const block = (run = threadApprovalRunFixture(NOW)) => (
    <RunBlock
      run={run}
      timeZone="UTC"
      onStop={noop}
      onResume={noop}
      onDismiss={noop}
      onStart={noop}
      onMarkDone={noop}
      onNext={noop}
      onAnswer={noop}
    />
  );

  test('Approve in the block decides in place, with no way to press twice', async () => {
    const calls: Array<[string, unknown]> = [];
    useApprovalDecisions.setState({
      call: async (name: string, args: unknown) => {
        calls.push([name, args]);
        return { ok: true, followUp: { action: 'continued' } };
      },
    });
    const renderer = await mount(block());
    expect(pressable(renderer)).toContain('Approve');
    await press(renderer, 'Approve');
    expect(calls).toEqual([['albatross_approve_action', { approvalId: THREAD_FIXTURE_APPROVAL_ID }]]);
    expect(pressable(renderer)).not.toContain('Approve');
    expect(textOf(renderer.root)).toContain('Approved. The invite went out.');
  });

  test('a failure in the block shows the message, and Decline can still close it', async () => {
    useApprovalDecisions.setState({
      decisions: {
        [THREAD_FIXTURE_APPROVAL_ID]: { state: 'failed', message: 'Calendar is offline.', at: 1 },
      },
    });
    const renderer = await mount(block());
    expect(textOf(renderer.root)).toContain('Calendar is offline.');
    expect(pressable(renderer)).toEqual(expect.arrayContaining(['Approve', 'Decline']));
    expect(pressable(renderer)).not.toContain('Dismiss');
  });

  test('a press in flight on another surface shows here too', async () => {
    useApprovalDecisions.setState({
      decisions: { [THREAD_FIXTURE_APPROVAL_ID]: { state: 'deciding', choice: 'approve', at: 1 } },
    });
    const renderer = await mount(block());
    expect(pressable(renderer)).not.toContain('Approve');
  });
});

describe('the older Notifications page', () => {
  const invite = {
    _id: 'a1',
    title: 'Send the invite: Kickoff',
    detail: 'To Dana Reyes <dana@example.com>. From the goal "Kickoff".',
    status: 'pending',
    kind: 'calendar_invite',
    intentId: 'w1',
    createdAt: 100,
  };
  const base = { notifications: [], questions: [], checkin: null };
  const page = (approvals: (typeof invite)[], extra: Record<string, unknown> = {}) => (
    <NotificationsView
      projection={projectNotifications({ ...base, approvals })}
      now={NOW}
      onRead={async () => undefined}
      onDismiss={async () => undefined}
      onAction={noop}
      {...extra}
    />
  );

  test('a row decides on the list, and the live queue dropping it keeps its words', async () => {
    useApprovalDecisions.setState({ call: async () => ({ ok: true }) });
    const renderer = await mount(page([invite]));
    await press(renderer, 'Decline');
    expect(textOf(renderer.root)).toContain('Declined. Nothing went out.');
    await act(async () => renderer.update(page([])));
    expect(textOf(renderer.root)).toContain('Declined. Nothing went out.');
    expect(pressable(renderer)).not.toContain('Decline');
  });

  test('a request from another surface opens that approval, with the control', async () => {
    const renderer = await mount(page([invite], { openRequest: { id: 'approval:a1', at: 1 } }));
    const detail = renderer.root.findByProps({ 'aria-label': 'Notification details' });
    expect(textOf(detail)).toContain('To Dana Reyes <dana@example.com>.');
    expect(textOf(detail)).not.toContain('From the goal');
    expect(textOf(detail)).not.toContain('Waiting on you');
    expect(textOf(detail)).toContain('It goes out only after you approve it.');
    expect(detail.findAll((node) => node.type === 'button' && textOf(node) === 'Approve')).toHaveLength(1);
  });
});

describe('useRetainedApprovals', () => {
  test('it keeps a decided row only, and leaves other rows alone', async () => {
    const row = { id: 'approval:ap1', approval: { id: 'ap1' } } as unknown as NotificationItem;
    let seen: readonly NotificationItem[] = [];
    function Probe({ items }: { items: readonly NotificationItem[] }) {
      seen = useRetainedApprovals(items, NOW);
      return null;
    }
    const renderer = await mount(<Probe items={[row]} />);
    expect(seen).toEqual([row]);
    await act(async () => renderer.update(<Probe items={[]} />));
    expect(seen).toEqual([]);
    await act(async () => {
      useApprovalDecisions.setState({ decisions: { ap1: { state: 'declined', at: NOW } } });
    });
    expect(seen).toEqual([row]);
  });
});

describe('focusApprovalControl', () => {
  test('it moves focus to the control in view, so the user stays', () => {
    const doc = globals.document as Document;
    doc.body.innerHTML = '<div data-approval-decision="ap1"><button>Approve</button></div>';
    const control = doc.querySelector('[data-approval-decision]') as HTMLElement;
    control.scrollIntoView = () => undefined;
    const focus = spyOn(control.querySelector('button') as HTMLElement, 'focus');
    expect(focusApprovalControl('ap1')).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test('false with no control or no id, so the caller goes to the page', () => {
    (globals.document as Document).body.innerHTML = '';
    expect(focusApprovalControl('ap1')).toBe(false);
    expect(focusApprovalControl(null)).toBe(false);
  });
});
