import { describe, expect, test } from 'bun:test';
import {
  AREA_ARTIFACT_DOCUMENT_MAX,
  areaArtifactHtmlForWrite,
  assertAreaArtifactDocumentSize,
  encodedAreaArtifactDocumentSize,
} from '../lib/albatross/area-artifact-storage';
import {
  AREA_ARTIFACT_SYSTEM,
  areaArtifactRevision,
  buildAreaArtifactContext,
  extractAreaArtifactHtml,
  generateAreaLivingBrief,
  normalizeAreaArtifactHtml,
  setAreaLivingBriefDependenciesForTest,
} from '../lib/albatross/area-living-brief';

const home = {
  area: { _id: 'area_1', name: 'Studio', kind: 'project', description: 'The product studio.' },
  plans: [
    {
      intentId: 'work_1',
      title: 'Ship the intent layer',
      status: 'captured',
      planStatus: 'ready',
      outcome: 'A useful release',
      summary: 'Build and verify it.',
      updatedAt: 10,
    },
  ],
  projects: [
    {
      projectId: 'project_1',
      sourceIntentId: 'work_1',
      title: 'Albatross',
      status: 'active',
      taskCount: 4,
      completedTaskCount: 1,
      updatedAt: 20,
    },
  ],
  tasks: [{ cardId: 'card_1', title: 'Write the artifact', completedAt: null, dueAt: 30, updatedAt: 20 }],
  events: [{ accountId: 'acct', providerEventId: 'event_1', title: 'Review', startAt: 40, endAt: 50 }],
  mail: [
    {
      accountId: 'acct',
      providerThreadId: 'thread_1',
      subject: 'Artifact feedback',
      fromAddress: 'a@example.test',
      lastDate: 60,
      snippet: 'Please review',
      linkStatus: 'candidate',
    },
  ],
  places: [],
  facts: {
    verified: [{ kind: 'domain', value: 'example.test' }],
    candidate: [{ _id: 'fact_1', kind: 'person', value: 'Maybe the owner' }],
  },
  counts: { plans: 1, projects: 1 },
};

describe('Area artifact data contract', () => {
  test('scopes actionable IDs and keeps candidate context segregated', () => {
    const context = buildAreaArtifactContext(home, 1_000);
    expect(context.area.areaId).toBe('area_1');
    expect(context.work[0]?.workId).toBe('work_1');
    expect(context.projects[0]?.sourceWorkId).toBe('work_1');
    expect(context.mail[0]).toMatchObject({
      accountId: 'acct',
      threadId: 'thread_1',
      assignment: 'candidate',
    });
    expect(context.context.verified[0]?.value).toBe('example.test');
    expect(context.context.candidates[0]?.value).toBe('Maybe the owner');
    expect(context.actions.discussArea.payload.areaId).toBe('area_1');
  });

  test('carries real sprint and place details without inventing missing values', () => {
    const context = buildAreaArtifactContext({
      ...home,
      projects: [
        {
          ...home.projects[0],
          activeSprint: { title: 'Launch week', status: 'active', endAt: 1_900_000_000_000 },
        },
      ],
      places: [
        {
          name: 'Studio',
          detail: 'Second floor',
          address: '1 Main Street',
          hoursText: '9–5',
          website: 'https://example.test',
        },
      ],
    });
    expect(context.projects[0]?.activeSprint).toMatchObject({
      title: 'Launch week',
      status: 'active',
      endAt: 1_900_000_000_000,
    });
    expect(context.places[0]).toEqual({
      name: 'Studio',
      detail: 'Second floor',
      address: '1 Main Street',
      hoursText: '9–5',
      website: 'https://example.test',
    });
  });

  test('revision changes with source state but not edition time', () => {
    const one = buildAreaArtifactContext(home, 1_000);
    const later = buildAreaArtifactContext(home, 9_000);
    expect(areaArtifactRevision(one)).toBe(areaArtifactRevision(later));
    const changed = buildAreaArtifactContext(
      { ...home, plans: [{ ...home.plans[0], outcome: 'A different outcome' }] },
      9_000,
    );
    expect(areaArtifactRevision(changed)).not.toBe(areaArtifactRevision(one));
  });

  test('prompt makes creativity, intent priority, uncertainty, and no-inferred-completion explicit', () => {
    expect(AREA_ARTIFACT_SYSTEM).toContain('Be creative');
    expect(AREA_ARTIFACT_SYSTEM).toContain('Treat the whole page as a canvas');
    expect(AREA_ARTIFACT_SYSTEM).toContain('Do not output a generic dashboard');
    expect(AREA_ARTIFACT_SYSTEM).toContain('Declared Work');
    expect(AREA_ARTIFACT_SYSTEM).toContain('Never say work is done unless');
    expect(AREA_ARTIFACT_SYSTEM).toContain('context.candidates are uncertain hypotheses');
    expect(AREA_ARTIFACT_SYSTEM).toContain('data-area-capture');
    expect(AREA_ARTIFACT_SYSTEM).toContain('Do not write any JavaScript');
  });
});

describe('Area artifact HTML boundary', () => {
  test('extracts complete documents from raw or fenced model output', () => {
    const document = `<!doctype html><html><head><title>Area</title></head><body>${'x'.repeat(180)}</body></html>`;
    expect(extractAreaArtifactHtml(document)).toBe(document);
    expect(extractAreaArtifactHtml(`preface\n\`\`\`html\n${document}\n\`\`\``)).toBe(document);
    expect(extractAreaArtifactHtml('<html><body>short</body>')).toBeNull();
  });

  test('strips model executable surfaces and installs a restrictive CSP', () => {
    const raw = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body onload="steal()"><script>steal()</script><iframe src="https://evil.test"></iframe><a href="javascript:steal()">x</a><button formaction="data:text/html,evil">go</button>${'x'.repeat(220)}</body></html>`;
    const normalized = normalizeAreaArtifactHtml(raw);
    expect(normalized).toContain('Content-Security-Policy');
    expect(normalized).toContain("default-src 'none'");
    expect(normalized).toContain("connect-src 'none'");
    expect(normalized).not.toContain('steal()');
    expect(normalized).not.toContain('<iframe');
    expect(normalized).not.toContain('default-src *');
    expect(normalized).not.toContain('http-equiv="refresh"');
    expect(normalized).toContain('href="#"');
    expect(normalized).toContain('formaction="#"');
  });
});

describe('Area artifact persistence boundary', () => {
  test('replaces only explicit ready values and preserves the last good edition otherwise', () => {
    expect(areaArtifactHtmlForWrite('ready', '<html>new</html>', '<html>old</html>')).toBe(
      '<html>new</html>',
    );
    expect(areaArtifactHtmlForWrite('ready', '', '<html>old</html>')).toBe('');
    expect(areaArtifactHtmlForWrite('ready', undefined, '<html>old</html>')).toBe('<html>old</html>');
    expect(areaArtifactHtmlForWrite('generating', '<html>ignored</html>', '<html>old</html>')).toBe(
      '<html>old</html>',
    );
    expect(areaArtifactHtmlForWrite('error', '<html>ignored</html>', '<html>old</html>')).toBe(
      '<html>old</html>',
    );
  });

  test('measures and rejects the complete encoded document atomically', () => {
    const within = { artifactHtml: 'é'.repeat(1_000), sourceRefs: [], status: 'ready' };
    expect(encodedAreaArtifactDocumentSize(within)).toBeGreaterThan(within.artifactHtml.length);
    expect(() => assertAreaArtifactDocumentSize(within)).not.toThrow();
    expect(() =>
      assertAreaArtifactDocumentSize({
        artifactHtml: 'x'.repeat(AREA_ARTIFACT_DOCUMENT_MAX),
        sourceRefs: [{ id: 'metadata-is-part-of-the-bound' }],
        status: 'ready',
      }),
    ).toThrow('Area artifact document exceeds the maximum size.');
  });
});

describe('Area artifact composition pipeline', () => {
  test('reuses a matching ready edition without writing or calling the model', async () => {
    const basedOnRevision = areaArtifactRevision(buildAreaArtifactContext(home));
    const livingBrief = {
      status: 'ready',
      artifactHtml: '<!doctype html><html><body>existing</body></html>',
      basedOnRevision,
    };
    let touched = false;
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => ({ ...home, livingBrief })) as any,
      convexMutation: (async () => {
        touched = true;
      }) as any,
      generateTextForCurrentUser: (async () => {
        touched = true;
        throw new Error('should not compose');
      }) as any,
    });
    try {
      await expect(generateAreaLivingBrief({ userId: 'user_1', areaId: 'area_1' })).resolves.toBe(
        livingBrief,
      );
      expect(touched).toBe(false);
    } finally {
      restore();
    }
  });

  test('persists generating then ready for a complete creative edition', async () => {
    const writes: any[] = [];
    const document = `<!doctype html><html><head><title>Studio</title></head><body>${'edition '.repeat(40)}</body></html>`;
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => home) as any,
      convexMutation: (async (_ref: unknown, args: any) => {
        writes.push(args);
      }) as any,
      generateTextForCurrentUser: (async () => ({ text: document })) as any,
    });
    try {
      const result = await generateAreaLivingBrief({
        userId: 'user_1',
        userEmail: 'owner@example.test',
        userName: 'Owner',
        areaId: 'area_1',
        force: true,
      });
      expect(result.status).toBe('ready');
      expect(result.artifactHtml).toContain('Content-Security-Policy');
      expect(writes.map((write) => write.status)).toEqual(['generating', 'ready']);
      expect(writes[1].artifactHtml).toContain('<title>Studio</title>');
    } finally {
      restore();
    }
  });

  test('records an error while preserving the original generation failure', async () => {
    const writes: any[] = [];
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => home) as any,
      convexMutation: (async (_ref: unknown, args: any) => {
        writes.push(args);
      }) as any,
      generateTextForCurrentUser: (async () => ({ text: 'not an HTML document' })) as any,
    });
    try {
      await expect(
        generateAreaLivingBrief({ userId: 'user_1', areaId: 'area_1', force: true }),
      ).rejects.toThrow('complete Area HTML document');
      expect(writes.map((write) => write.status)).toEqual(['generating', 'error']);
      expect(writes[1].error).toContain('complete Area HTML document');
    } finally {
      restore();
    }
  });
});
