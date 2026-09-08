import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const today = readFileSync(new URL('../Lab86Mail/Features/Today/TodayView.swift', import.meta.url), 'utf8');
const area = readFileSync(new URL('../Lab86Mail/Features/Work/AreaDetailView.swift', import.meta.url), 'utf8');

// These are composition guardrails, not a substitute for native rendering.
// The regressions were missing SwiftUI modifiers, so protect the actual wiring
// in addition to BriefChromeTests' masthead threshold checks.
describe('desktop brief chrome composition', () => {
  it('uses one scroll observer for both native and legacy Mac editions', () => {
    const start = today.indexOf('private func macBriefBody(');
    const end = today.indexOf('\n    #endif', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = today.slice(start, end);

    expect(body.match(/ScrollView \{/g)).toHaveLength(1);
    expect(body).toMatch(/ScrollView \{\s+if let document = report\.document/);
    expect(body).toMatch(/BriefDocumentView\([\s\S]+\} else \{\s+DailyBriefView\(/);
    expect(body).toMatch(/\.padding\(\.bottom, 32\)\s+\}\s+\}\s+\.background/);
    expect(body.match(/\.onScrollGeometryChange\(/g)).toHaveLength(1);
    expect(body).toContain('containerWidth: min(geometry.containerSize.width, 920)');
    expect(body).toContain('showsInlineDate = crossed');
  });

  it('removes redundant text-first Mac clearance without changing iPhone or masthead insets', () => {
    const lead = area.slice(area.indexOf('private struct AreaBriefLead: View'));
    expect(lead).toMatch(
      /#if os\(macOS\)[\s\S]*?\.padding\(\.top, mastheadURL == nil \? 0 : 20\)\s+#else[\s\S]*?\.padding\(\.top, mastheadURL == nil \? 60 : 20\)\s+#endif/,
    );
  });
});
