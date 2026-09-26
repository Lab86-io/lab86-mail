import { expect, mock, test } from 'bun:test';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import {
  createMutationErrorFallback,
  MUTATION_FALLBACK_MESSAGE,
  mutationFallbackMessage,
} from '../lib/shell/mutation-errors';

const bare = { options: {} };

test('a mutation with no error handler gets the fallback message', () => {
  expect(mutationFallbackMessage(new Error('Provider rejected the change'), bare)).toBe(
    'Provider rejected the change',
  );
  expect(mutationFallbackMessage(new Error('archive_thread failed (500)'), bare)).toBe(
    MUTATION_FALLBACK_MESSAGE,
  );
  expect(mutationFallbackMessage('boom', bare)).toBe(MUTATION_FALLBACK_MESSAGE);
  expect(
    mutationFallbackMessage(new Error('x'), { options: {}, meta: { errorToast: 'Could not archive.' } }),
  ).toBe('Could not archive.');
});

test('the fallback stays quiet for own handlers, inline errors, and cancellation', () => {
  expect(mutationFallbackMessage(new Error('x'), { options: { onError: () => {} } })).toBeNull();
  expect(mutationFallbackMessage(new Error('x'), { options: {}, meta: { errorToast: false } })).toBeNull();
  const abort = new DOMException('stopped', 'AbortError');
  expect(mutationFallbackMessage(abort, bare)).toBeNull();
});

test('the query client toasts only failed mutations that have no onError', async () => {
  const notify = mock((_message: string) => {});
  const client = new QueryClient({
    mutationCache: new MutationCache({ onError: createMutationErrorFallback(notify) }),
  });
  const fail = async () => {
    throw new Error('Could not trash this thread');
  };
  await client
    .getMutationCache()
    .build(client, { mutationFn: fail })
    .execute(undefined)
    .catch(() => undefined);
  const own = mock(() => {});
  await client
    .getMutationCache()
    .build(client, { mutationFn: fail, onError: own })
    .execute(undefined)
    .catch(() => undefined);
  expect(notify.mock.calls).toEqual([['Could not trash this thread']]);
  expect(own).toHaveBeenCalledTimes(1);
});
