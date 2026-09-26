import { afterEach, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AiSection } from '../components/settings/AiSection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let view: ReactTestRenderer | undefined;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (view) await act(async () => view?.unmount());
  view = undefined;
});

const text = (node: any): string =>
  typeof node === 'string' ? node : (node?.children || []).map(text).join('');

async function mount(plan: string) {
  globalThis.fetch = (async () =>
    Response.json({
      ok: true,
      settings: { mode: 'lab86' },
      entitlement: { plan, status: 'active', source: 'clerk' },
      usage: {
        status: 'ok',
        paidPlan: { monthlyUsd: 12, annualUsd: 120, byokMonthlyUsd: 5, byokAnnualUsd: 50 },
      },
    })) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <AiSection heading={null} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 20 && !view!.root.findAll((n) => n.props?.['data-slot'] === 'billing-line').length; i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  const labels = view!.root.findAllByType('button').map(text);
  const line = text(view!.root.find((n) => n.props?.['data-slot'] === 'billing-line'));
  return { labels, line };
}

test('a Pro user sees the plan and Manage, not Upgrade or the price list', async () => {
  const { labels, line } = await mount('pro');
  expect(line).toBe('Plan: Pro.');
  expect(labels).toContain('Manage');
  expect(labels).not.toContain('Upgrade');
});

test('a free user sees the prices and Upgrade', async () => {
  const { labels, line } = await mount('free');
  expect(line).toContain('$12/mo');
  expect(labels).toContain('Upgrade');
});
