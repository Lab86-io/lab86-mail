import { describe, expect, test } from 'bun:test';
import type { AlbatrossDailyReportContext } from '../lib/albatross/daily-report';
import { injectReportAreaBrief, renderReportAreaBriefHtml } from '../lib/mail/report-area-brief';

describe('report area brief injection', () => {
  test('injects a host-rendered area brief before the artifact footer', () => {
    const html =
      '<html><body><main><section>Brief</section><footer class="brief-footer">Made</footer></main></body></html>';
    const out = injectReportAreaBrief(html, contextFixture());

    expect(out.indexOf('data-lab86-area-brief-host')).toBeGreaterThan(-1);
    expect(out.indexOf('data-lab86-area-brief-host')).toBeLessThan(out.indexOf('brief-footer'));
    expect(out).toContain('Area briefs');
    expect(out).toContain('Launch');
    expect(out).toContain('Project: Ship area briefs');
  });

  test('renders open-area payloads for standalone area briefs', () => {
    const out = renderReportAreaBriefHtml(contextFixture());

    expect(out).toContain('data-action="open_area"');
    expect(out).toContain('&quot;areaId&quot;:&quot;area_launch&quot;');
    expect(out).toContain('data-action="open_view"');
    expect(out).toContain('&quot;view&quot;:&quot;areas&quot;');
  });

  test('is idempotent and escapes area text', () => {
    const injected = injectReportAreaBrief('<main></main>', {
      ...contextFixture(),
      includedAreas: [
        {
          areaId: 'area_bad',
          name: '<script>alert(1)</script>',
          reason: 'Needs <review>',
          imageUrl: 'javascript:alert(1)',
        },
      ],
      askBeforeCentering: [
        {
          areaId: 'area_bad',
          name: '<script>alert(1)</script>',
          prompt: 'Confirm this area?',
          loudness: 90,
          imageUrl: 'javascript:alert(2)',
        },
      ],
      activeProjects: [],
      activeIntents: [],
    });
    const twice = injectReportAreaBrief(injected, contextFixture());

    expect(twice.match(/data-lab86-area-brief-host/g)?.length).toBe(1);
    expect(twice).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(twice).toContain('Needs a decision');
    expect(twice).not.toContain('javascript:alert');
  });

  test('still renders a quiet areas module when context has no active rows', () => {
    const out = renderReportAreaBriefHtml({
      includedAreas: [],
      askBeforeCentering: [],
      activeIntents: [],
      activeProjects: [],
      contextReview: [],
      completions: [],
    });

    expect(out).toContain('Areas are quiet right now');
    expect(out).toContain('No active area pressure');
  });
});

function contextFixture(): AlbatrossDailyReportContext {
  return {
    includedAreas: [
      {
        areaId: 'area_launch',
        name: 'Launch',
        reason: 'Live Albatross work',
        faviconUrl: 'https://example.com/favicon.ico',
      },
    ],
    askBeforeCentering: [
      {
        areaId: 'area_house',
        name: 'House',
        prompt: 'House has 2 pending approvals. Include it today?',
        loudness: 80,
      },
    ],
    activeProjects: [
      {
        id: 'project_1',
        title: 'Ship area briefs',
        areaId: 'area_launch',
        status: 'active',
        outcome: 'Visible in the daily report',
      },
    ],
    activeIntents: [
      {
        id: 'intent_1',
        text: 'Plan the launch review',
        areaId: 'area_launch',
        status: 'needs_answers',
      },
    ],
    contextReview: [{ id: 'review_1', areaId: 'area_house', title: 'Confirm contractor', reason: 'Waiting' }],
    completions: [{ id: 'done_1', areaId: 'area_launch', summary: 'Applied plan: draft review' }],
  };
}
