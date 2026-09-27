import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefSection, briefScheduleSummary } from '../components/settings/BriefSection';
import { BRIEF_EMAIL_UNAVAILABLE_REASON, type BriefPreferences } from '../lib/brief/preferences';

function render(preferences: BriefPreferences) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['brief-preferences'], preferences);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BriefSection />
    </QueryClientProvider>,
  );
}

const base: BriefPreferences = {
  deliveryHour: 8,
  weekendMode: 'light',
  weeklyReview: true,
  emailEnabled: false,
  timezone: 'America/New_York',
  email: { available: true, reason: null },
};

describe('Daily Brief settings', () => {
  test('says when each edition arrives in plain words', () => {
    expect(briefScheduleSummary(base)).toBe(
      'Weekdays at 8:00 AM America/New York time. A light edition on Saturday, and the weekly review on Sunday.',
    );
    expect(briefScheduleSummary({ ...base, weekendMode: 'off', weeklyReview: false, timezone: null })).toBe(
      'Weekdays at 8:00 AM. No edition on Saturday, and none on Sunday.',
    );
    expect(briefScheduleSummary({ ...base, weekendMode: 'full', weeklyReview: false })).toContain(
      'The full edition on Saturday, and the same on Sunday.',
    );
  });

  test('renders the delivery rows and an enabled email switch when email is set up', () => {
    const html = render(base);
    expect(html).toContain('Delivery time');
    expect(html).toContain('8:00 AM');
    expect(html).toContain('Waiting and FYI sections stay out.');
    expect(html).toContain('Weekly review on Sunday');
    expect(html).toContain('Send each edition by email');
    expect(html).not.toContain(BRIEF_EMAIL_UNAVAILABLE_REASON);
    expect(html).not.toMatch(/\bAI\b/);
  });

  test('disables the email switch with the reason when email is not set up', () => {
    const html = render({ ...base, email: { available: false, reason: BRIEF_EMAIL_UNAVAILABLE_REASON } });
    expect(html).toContain(BRIEF_EMAIL_UNAVAILABLE_REASON);
    expect(html).toMatch(/role="switch"[^>]*disabled=""[^>]*id="brief-email"/);
  });
});
