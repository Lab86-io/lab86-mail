import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { useEmptyPageContinuation } from '../lib/mail/search/use-empty-page-continuation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
test('empty filtered pages load their continuation, then stop for visible rows, exhaustion, or errors', async () => {
  let calls = 0;
  const next = async () => {
    calls++;
  };
  function Harness({ count = 0, hasNext = true, fetching = false, failed = false }) {
    useEmptyPageContinuation(count, hasNext, fetching, failed, next);
    return null;
  }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness />);
  });
  expect(calls).toBe(1);
  await act(async () => {
    root.update(<Harness fetching />);
  });
  expect(calls).toBe(1);
  await act(async () => {
    root.update(<Harness />);
  });
  expect(calls).toBe(2);
  for (const props of [{ count: 1 }, { hasNext: false }, { failed: true }]) {
    await act(async () => {
      root.update(<Harness {...props} />);
    });
    expect(calls).toBe(2);
  }
  await act(async () => {
    root.unmount();
  });
});
