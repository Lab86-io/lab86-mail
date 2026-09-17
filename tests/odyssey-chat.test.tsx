import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { WorkLog } from '../components/ai-elements/work-log';
import { PromptInput } from '../components/odysseyui/prompt-input';
import {
  ThoughtChain,
  ThoughtChainContent,
  ThoughtChainStep,
  ThoughtChainTrigger,
} from '../components/odysseyui/thought-chain';
import { groupMessageParts } from '../lib/chat/work-log';

const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
beforeEach(() => {
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
});

const click = {
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
};

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Result {count}
    </button>
  );
}

describe('Odyssey chat integration', () => {
  test('collapsing a tool result preserves its state and removes it from keyboard interaction', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <ThoughtChain>
          <ThoughtChainStep status="done">
            <ThoughtChainTrigger>Read file</ThoughtChainTrigger>
            <ThoughtChainContent>
              <Counter />
            </ThoughtChainContent>
          </ThoughtChainStep>
        </ThoughtChain>,
      );
    });
    await act(async () => tree.root.findAllByType('button')[1].props.onClick());
    await act(async () => tree.root.findAllByType('button')[0].props.onClick({ ...click }));
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(false);
    expect(tree.root.findAllByType('div').filter((node) => node.props.inert === true)).toHaveLength(1);
    await act(async () => tree.root.findAllByType('button')[0].props.onClick({ ...click }));
    expect(tree.root.findAllByType('button')[1].children.join('')).toBe('Result 1');
    await act(async () => tree.unmount());
  });

  test('controlled disclosure keeps the trigger and content synchronized', async () => {
    const onOpenChange = mock(() => {});
    const content = (open: boolean) => (
      <ThoughtChain>
        <ThoughtChainStep status="done" open={open} onOpenChange={onOpenChange}>
          <ThoughtChainTrigger>Read file</ThoughtChainTrigger>
          <ThoughtChainContent>
            <Counter />
          </ThoughtChainContent>
        </ThoughtChainStep>
      </ThoughtChain>
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(content(false));
    });
    await act(async () => tree.root.findAllByType('button')[0].props.onClick({ ...click }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(false);
    expect(tree.root.findAllByType('div').filter((node) => node.props.inert === true)).toHaveLength(1);
    await act(async () => tree.update(content(true)));
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(true);
    expect(tree.root.findAllByType('div').filter((node) => node.props.inert === true)).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('Enter submits once; Shift+Enter, IME and handled Ask/Hold keys do not submit again', async () => {
    const submit = mock(() => {});
    const handled = mock((event: any) => {
      if (event.ctrlKey) event.preventDefault();
    });
    const change = mock(() => {});
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <PromptInput value="Hello" onValueChange={change} onSubmit={submit} onKeyDown={handled} />,
      );
    });
    const input = tree.root.findByType('textarea');
    const event = (extra = {}) => ({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      ...click,
      ...extra,
    });
    input.props.onKeyDown(event());
    input.props.onKeyDown(event({ shiftKey: true }));
    input.props.onKeyDown(event({ nativeEvent: { isComposing: true } }));
    input.props.onKeyDown(event({ ctrlKey: true }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(3);
    input.props.onChange({ target: { value: 'Edited' } });
    expect(change).toHaveBeenCalledWith('Edited');
    await act(async () => tree.unmount());
  });

  test('running work becomes failed and stays expanded when a turn is interrupted', async () => {
    const segment = groupMessageParts([
      { type: 'tool-search_threads', toolCallId: 'one', state: 'input-available', input: {} },
    ])[0];
    if (segment.kind !== 'work-log') throw Error('Expected work log');
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<WorkLog rows={segment.rows} finished={false} />);
    });
    expect(tree.root.findAllByProps({ 'data-status': 'active' }).length).toBeGreaterThan(0);
    await act(async () => {
      tree.update(<WorkLog rows={segment.rows} finished />);
    });
    expect(tree.root.findAllByProps({ 'data-status': 'active' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ 'data-status': 'failed' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(true);
    await act(async () => tree.unmount());
  });

  test('only completed successful groups auto-collapse, and explicit user disclosure wins', async () => {
    const segment = groupMessageParts(
      ['a', 'b', 'c'].map((toolCallId) => ({
        type: 'tool-search_threads',
        toolCallId,
        state: 'output-available',
        output: { ok: true },
        input: {},
      })),
    )[0];
    if (segment.kind !== 'work-log') throw Error('Expected work log');
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<WorkLog rows={segment.rows} finished={false} />);
    });
    await act(async () => {
      tree.update(<WorkLog rows={segment.rows} finished />);
    });
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(false);
    await act(async () => tree.unmount());
    await act(async () => {
      tree = create(<WorkLog rows={segment.rows} finished={false} />);
    });
    await act(async () => tree.root.findAllByType('button')[0].props.onClick({ ...click }));
    await act(async () => tree.root.findAllByType('button')[0].props.onClick({ ...click }));
    await act(async () => {
      tree.update(<WorkLog rows={segment.rows} finished />);
    });
    expect(tree.root.findAllByType('button')[0].props['aria-expanded']).toBe(true);
    await act(async () => tree.unmount());
  });

  test('pending, active, done and failed rows expose distinct statuses without fabricating progress', () => {
    const markup = renderToStaticMarkup(
      <ThoughtChain>
        {(['pending', 'active', 'done', 'failed'] as const).map((status) => (
          <ThoughtChainStep key={status} status={status}>
            <ThoughtChainTrigger expandable={false}>{status}</ThoughtChainTrigger>
          </ThoughtChainStep>
        ))}
      </ThoughtChain>,
    );
    for (const status of ['pending', 'active', 'done', 'failed'])
      expect(markup).toContain(`data-status="${status}"`);
    expect(markup.match(/In progress/g)).toHaveLength(1);
  });
});
