import { describe, expect, test } from 'bun:test';
import {
  AREA_ARTIFACT_DOCUMENT_MAX,
  areaArtifactHtmlForWrite,
  assertAreaArtifactDocumentSize,
  encodedAreaArtifactDocumentSize,
} from '../lib/albatross/area-artifact-storage';
import {
  AREA_PULSE_SYSTEM_PROMPT,
  areaArtifactRevision,
  buildAreaArtifactContext,
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
  mcpItems: [
    {
      externalId: 'github:pull_request:Lab86-io/lab86-mail#123',
      server: 'github',
      kind: 'pull_request',
      title: 'Ship proactive Area evidence',
      summary: 'Connect repository activity to Albatross.',
      state: 'merged',
      author: 'jakob',
      repository: 'Lab86-io/lab86-mail',
      organization: 'Lab86-io',
      url: 'https://github.com/Lab86-io/lab86-mail/pull/123',
      occurredAt: 70,
      linkStatus: 'candidate',
      reason: 'context match to Studio',
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
    expect(context.connectedActivity[0]).toMatchObject({
      server: 'github',
      kind: 'pull_request',
      repository: 'Lab86-io/lab86-mail',
      state: 'merged',
      assignment: 'candidate',
    });
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

  test('scopes the next-day attention budget to the named Area', () => {
    const focused = buildAreaArtifactContext({
      ...home,
      dailyAlignment: {
        localDate: '2026-07-25',
        tomorrowIntent: 'Tomorrow I will spend one hour on one Studio task, then enjoy the lake.',
      },
    });
    expect(focused.nextDayIntent).toMatchObject({
      appliesToArea: true,
      mode: 'light',
      requestedItems: 1,
      requestedMinutes: 60,
    });

    const unrelated = buildAreaArtifactContext({
      ...home,
      dailyAlignment: {
        localDate: '2026-07-25',
        tomorrowIntent: 'Spend one hour on Card Hunt.',
      },
    });
    expect(unrelated.nextDayIntent?.appliesToArea).toBe(false);
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

  test('pulse prompt keeps intent priority, uncertainty, and no-inferred-completion explicit', () => {
    expect(AREA_PULSE_SYSTEM_PROMPT).toContain('Declared Work');
    expect(AREA_PULSE_SYSTEM_PROMPT).toContain('Never say work is done unless');
    expect(AREA_PULSE_SYSTEM_PROMPT).toContain('Candidate context is uncertain');
    expect(AREA_PULSE_SYSTEM_PROMPT).toContain('prose: at most 3 sentences');
    expect(AREA_PULSE_SYSTEM_PROMPT).toContain('Never write the word "AI"');
  });
});

describe('Area artifact HTML boundary', () => {
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
    expect(normalized).toContain('id="lab86-area-fonts"');
    expect(normalized).toContain('id="lab86-area-font-contract"');
    expect(normalized).toContain('var(--brief-font-display');
    expect(normalized).toContain('var(--brief-font-body');
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

describe('Area pulse pipeline', () => {
  test('writes generating, then the ready document, HTML fallback, and pulse', async () => {
    const writes: Array<{ args: any }> = [];
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => ({
        ...home,
        area: { ...home.area, name: `Studio & <Lab> "A" 'B'` },
      })) as any,
      convexMutation: (async (_ref: unknown, args: any) => {
        writes.push({ args });
      }) as any,
      generateTextForCurrentUser: (async (options: any) => {
        expect(options.feature).toBe('albatross_area_pulse');
        return {
          text: JSON.stringify({
            lastChange: 'Review was booked for the studio.',
            nextMove: 'Write the artifact.',
            openQuestion: '',
            prose: 'The studio is moving. One task is open. Ship the intent layer next.',
          }),
        };
      }) as any,
    });
    try {
      const result = await generateAreaLivingBrief({
        userId: 'user_1',
        areaId: 'area_1',
        force: true,
      });

      expect(result).toMatchObject({
        status: 'ready',
        artifactSource: 'document-v2',
        lede: 'Review was booked for the studio.',
        summary: 'The studio is moving. One task is open. Ship the intent layer next.',
        pulse: { nextMove: 'Write the artifact.', openQuestion: '' },
      });
      expect(result.document.regions.map((region: any) => region.id)).toEqual([
        'lede',
        'pulse',
        'ask',
        'open-work',
      ]);
      expect(writes.map((write) => write.args.status ?? 'pulse')).toEqual(['generating', 'ready', 'pulse']);
      expect(writes[1].args.artifactHtml).toContain('Studio &amp; &lt;Lab&gt; &quot;A&quot; &#39;B&#39;');
      expect(writes[1].args.artifactHtml).toContain('Content-Security-Policy');
      expect(writes[2].args.pulse.prose).toBe(
        'The studio is moving. One task is open. Ship the intent layer next.',
      );
    } finally {
      restore();
    }
  });

  test('reuses a matching ready edition without writing or calling the model', async () => {
    const basedOnRevision = areaArtifactRevision(buildAreaArtifactContext(home));
    const livingBrief = {
      status: 'ready',
      artifactHtml: '<!doctype html><html><body>existing</body></html>',
      basedOnRevision,
    };
    let touched = false;
    let queryCount = 0;
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => {
        queryCount += 1;
        return queryCount === 1 ? { ...home, livingBrief } : null;
      }) as any,
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

  test('a bad model reply degrades to the deterministic pulse and still lands ready', async () => {
    const writes: any[] = [];
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => home) as any,
      convexMutation: (async (_ref: unknown, args: any) => {
        writes.push(args);
      }) as any,
      generateTextForCurrentUser: (async () => ({ text: 'not JSON' })) as any,
    });
    try {
      const result = await generateAreaLivingBrief({ userId: 'user_1', areaId: 'area_1', force: true });
      expect(result.status).toBe('ready');
      expect(result.pulse.model).toBe('local');
      expect(result.pulse.prose).toBe('Studio has 1 active Work item and 1 open task.');
      expect(writes.map((write) => write.status ?? 'pulse')).toEqual(['generating', 'ready', 'pulse']);
    } finally {
      restore();
    }
  });

  test('propagates a living-index query failure without writing partial state', async () => {
    const writes: any[] = [];
    let queryCount = 0;
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => {
        queryCount += 1;
        if (queryCount === 2) throw new Error('pulse unavailable');
        return home;
      }) as any,
      convexMutation: (async (_ref: unknown, args: any) => {
        writes.push(args);
      }) as any,
    });
    try {
      await expect(
        generateAreaLivingBrief({ userId: 'user_1', areaId: 'area_1', force: true }),
      ).rejects.toThrow('pulse unavailable');
      expect(writes).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('records an error when the ready write fails', async () => {
    const writes: any[] = [];
    const restore = setAreaLivingBriefDependenciesForTest({
      convexQuery: (async () => home) as any,
      convexMutation: (async (_ref: unknown, args: any) => {
        writes.push(args);
        if (args.status === 'ready') throw new Error('store full');
      }) as any,
      generateTextForCurrentUser: (async () => ({ text: '{}' })) as any,
    });
    try {
      await expect(
        generateAreaLivingBrief({ userId: 'user_1', areaId: 'area_1', force: true }),
      ).rejects.toThrow('store full');
      expect(writes.map((write) => write.status)).toEqual(['generating', 'ready', 'error']);
      expect(writes[2].error).toContain('store full');
    } finally {
      restore();
    }
  });
});
