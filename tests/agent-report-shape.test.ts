import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import './tools/harness';
import { withArtifactError } from '../lib/mail/agent-report';
import { BRIEF_PROSE_SYSTEM_PROMPT } from '../lib/mail/brief-prose';
import { MAX_ARTIFACT_ERRORS } from '../lib/shared/types';

describe('brief pipeline hang/wedge guards', () => {
  const src = readFileSync(path.join(import.meta.dir, '..', 'lib', 'mail', 'agent-report.ts'), 'utf8');

  test('every unbounded await in the composition path carries a deadline', () => {
    // Context gathering (messages, area pulses, weather) and the one prose
    // call. A hang must become a caught error that settles the edition.
    expect((src.match(/withDeadline\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("from '../shared/deadline'");
    expect(src).not.toMatch(/const \{ text \} = await generateTextForCurrentUser\(/);
  });

  test('the pipeline re-resolves the user timezone from calendars', () => {
    expect(src).toContain('resolveBriefTimezone');
    expect(src).toMatch(/runWithAiRequestContext\(\{ \.\.\.context, userTimezone \}/);
  });

  test('daily composition uses the editorial agent after bounded source gathering', () => {
    expect(src).not.toContain("scope: 'full'");
    expect(src).toContain('await writeDailyEditorial(');
    expect(src).toContain('evidence: composed.editorialEvidence');
  });
});

describe('brief prose prompt', () => {
  test('preserves source terminology and gives compatibility summaries a larger budget', () => {
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('Preserve relevant product names');
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('no emoji');
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('no ALL-CAPS words');
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('lede: at most 4 sentences');
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('at most 60 words each');
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('weekAhead: at most 4 sentences');
    expect(BRIEF_PROSE_SYSTEM_PROMPT).toContain('Use the supplied weekday names and dates exactly');
  });
});

describe('withArtifactError', () => {
  test('keeps only the newest errors', () => {
    let report: any = { _id: 'r', artifactErrors: [] };
    for (let index = 0; index < MAX_ARTIFACT_ERRORS + 3; index += 1) {
      report = withArtifactError(report, { stage: 'document_v2', message: `e${index}`, at: index });
    }
    expect(report.artifactErrors).toHaveLength(MAX_ARTIFACT_ERRORS);
    expect(report.artifactErrors[MAX_ARTIFACT_ERRORS - 1].message).toBe(`e${MAX_ARTIFACT_ERRORS + 2}`);
  });
});
