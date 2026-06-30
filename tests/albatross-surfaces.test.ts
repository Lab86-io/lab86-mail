import { describe, expect, test } from 'bun:test';
import {
  AREA_LENSES,
  applyReviewDecision,
  areasStats,
  buildAreaDetail,
  buildAreaLens,
  buildAreaLensCounts,
  buildAreaSummaries,
  buildIntentWorkbench,
  buildNoiseRules,
  buildRecentCorrections,
  buildReviewDetail,
  buildReviewQueue,
  buildSetupPlan,
  buildSetupStep,
  classifyArtifact,
  classifyThread,
  contextReviewItems,
  createCapturedIntent,
  draftSetupFact,
  intentsStats,
  looksLikeMultipleIntents,
  pickIntentCaptureLabel,
  resolveArtifact,
  reviewDecisionOptions,
  splitIntentText,
  summarizeSetupProgress,
  toClassifierArtifact,
  unassignedStats,
} from '../components/albatross/surface-data';

describe('Areas surface selectors', () => {
  test('area summaries are sorted by priority and expose fact roll-ups', () => {
    const summaries = buildAreaSummaries();
    expect(summaries.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < summaries.length; i += 1) {
      expect(summaries[i].area.priority).toBeGreaterThanOrEqual(summaries[i - 1].area.priority);
    }
    const cardhunt = summaries.find((s) => s.area.id === 'area_cardhunt');
    expect(cardhunt?.factCounts.verified).toBeGreaterThan(0);
    expect(cardhunt?.factCounts.rejected).toBeGreaterThan(0);
  });

  test('area detail groups facts by status and only verified facts carry confirmations', () => {
    const detail = buildAreaDetail('area_cardhunt');
    expect(detail).not.toBeNull();
    expect(detail?.facts.verified.length).toBeGreaterThan(0);
    expect(detail?.facts.candidate.length).toBeGreaterThan(0);
    expect(detail?.facts.rejected.length).toBeGreaterThan(0);
    for (const fact of detail?.facts.verified ?? []) {
      expect(fact.confirmationRefs.length).toBeGreaterThan(0);
    }
    for (const fact of detail?.facts.candidate ?? []) {
      expect(fact.confirmationRefs.length).toBe(0);
    }
  });

  test('linked artifacts resolve to a human title and a confidence in range', () => {
    const detail = buildAreaDetail('area_cardhunt');
    expect(detail?.links.length ?? 0).toBeGreaterThan(0);
    for (const { link, title } of detail?.links ?? []) {
      expect(title.length).toBeGreaterThan(0);
      expect(link.confidence).toBeGreaterThanOrEqual(0);
      expect(link.confidence).toBeLessThanOrEqual(1);
    }
  });

  test('area detail surfaces projects scoped to the area', () => {
    const detail = buildAreaDetail('area_cardhunt');
    expect(detail?.projects.length ?? 0).toBeGreaterThan(0);
    expect(detail?.projects.every((project) => project.areaId === 'area_cardhunt')).toBe(true);
  });

  test('unknown area id returns null', () => {
    expect(buildAreaDetail('area_does_not_exist')).toBeNull();
  });
});

describe('Area setup helpers', () => {
  test('setup plan is resumable, area-first, and tracks progress', () => {
    const plan = buildSetupPlan();
    expect(plan.length).toBeGreaterThanOrEqual(10);
    expect(plan[0].area.kind).toBe('work');

    const cardhunt = buildSetupStep('area_cardhunt');
    expect(cardhunt).not.toBeNull();
    expect(cardhunt?.responsibilityPrompt).toContain('CardHunt');
    expect(cardhunt?.slots.find((slot) => slot.kind === 'domain')?.verifiedCount).toBeGreaterThan(0);
    expect(cardhunt?.slots.find((slot) => slot.kind === 'person')?.candidateCount).toBeGreaterThan(0);
    expect(cardhunt?.complete).toBe(true);

    const progress = summarizeSetupProgress(plan);
    expect(progress.totalAreas).toBe(plan.length);
    expect(progress.totalSlots).toBe(plan.length * 7);
    expect(progress.ratio).toBeGreaterThan(0);
    expect(progress.ratio).toBeLessThanOrEqual(1);
  });

  test('setup drafts verify typed identifiers but keep people as candidates', () => {
    expect(draftSetupFact('area_cardhunt', 'person', 'Andrew')?.status).toBe('candidate');
    expect(draftSetupFact('area_cardhunt', 'domain', 'cardhunt.example')?.status).toBe('verified');
    expect(draftSetupFact('area_cardhunt', 'repo', '   ')).toBeNull();
  });
});

describe('Area-aware classifier', () => {
  test('verified identity signals assign mail to exactly one primary area', () => {
    const result = classifyThread('thread_cardhunt_launch');
    expect(result?.primary?.areaId).toBe('area_cardhunt');
    expect(result?.primary?.status).toBe('verified');
    expect(result?.primary?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result?.secondary).toHaveLength(0);
  });

  test('trusted provenance beats soft text matches for linked artifacts', () => {
    const artifact = toClassifierArtifact('mcpItem', 'mcp_cardhunt_pr_442');
    expect(artifact).not.toBeNull();

    const result = classifyArtifact(artifact!);
    expect(result.primary?.areaId).toBe('area_cardhunt');
    expect(result.primary?.status).toBe('verified');
    expect(result.primary?.reason).toBe('Linked by a trusted source');
  });

  test('low-confidence and noisy artifacts route to Unassigned', () => {
    expect(
      classifyArtifact({
        kind: 'mailThread',
        id: 'thread_unknown',
        text: 'a random promo with no known area context',
        senderEmail: 'blast@example.net',
      }).primary,
    ).toBeNull();

    const noisyCardhunt = classifyArtifact({
      kind: 'mailThread',
      id: 'thread_noisy_cardhunt',
      text: 'CardHunt coupon blast',
      senderEmail: 'offers@cardhunt.example',
      smartPrimary: 'noise',
    });
    expect(noisyCardhunt.primary).toBeNull();
    expect(noisyCardhunt.unassignedReason).toContain('below the confidence bar');
  });
});

describe('Area lenses', () => {
  test('lens counts mirror the items each lens returns', () => {
    const counts = buildAreaLensCounts('area_cardhunt');
    for (const lens of AREA_LENSES) {
      expect(counts[lens.key]).toBe(buildAreaLens('area_cardhunt', lens.key).length);
    }
  });

  test('lenses separate replies, tasks, people, files, and open loops', () => {
    expect(buildAreaLens('area_cardhunt', 'needs_reply').map((item) => item.id)).toContain(
      'link_cardhunt_launch_primary',
    );
    expect(buildAreaLens('area_cardhunt', 'tasks').map((item) => item.id)).toContain(
      'task_cardhunt_review_onboarding',
    );
    expect(buildAreaLens('area_cardhunt', 'people').some((item) => item.title.includes('Andrew'))).toBe(true);
    expect(buildAreaLens('area_cardhunt', 'files_links').map((item) => item.id)).toContain(
      'mcp_cardhunt_pr_442',
    );
    expect(buildAreaLens('area_cardhunt', 'open_loops').some((item) => item.status === 'candidate')).toBe(
      true,
    );
  });
});

describe('Intents surface selectors', () => {
  test('workbench pairs an intent with its plan and human-gated approvals', () => {
    const bench = buildIntentWorkbench('intent_salvage_day');
    expect(bench).not.toBeNull();
    expect(bench?.plan?.intentId).toBe('intent_salvage_day');
    expect(bench?.approvals.length).toBeGreaterThan(0);
    for (const approval of bench?.approvals ?? []) {
      expect(approval.requiresHumanApproval).toBe(true);
    }
  });

  test('a blocked intent exposes its open questions and an empty plan', () => {
    const bench = buildIntentWorkbench('intent_passport_one_word');
    expect(bench?.plan?.status).toBe('blocked_on_questions');
    expect(bench?.openQuestionCount).toBeGreaterThan(0);
    expect(bench?.plan?.digitalActions.length).toBe(0);
  });

  test('unknown intent id returns null', () => {
    expect(buildIntentWorkbench('intent_missing')).toBeNull();
  });
});

describe('Unassigned surface selectors', () => {
  test('review queue resolves artifacts and candidate area names', () => {
    const queue = buildReviewQueue();
    expect(queue.length).toBeGreaterThanOrEqual(4);
    const recruiter = queue.find((row) => row.item.id === 'review_recruiter');
    expect(recruiter?.artifact.title.length).toBeGreaterThan(0);
    expect(recruiter?.candidateAreas).toContain('Job Search');
    expect(recruiter?.item.suggestedActions).toContain('create_area');
  });

  test('review detail resolves candidate areas and the fact a decision would settle', () => {
    const detail = buildReviewDetail('review_cardhunt_andrew_relationship');
    expect(detail).not.toBeNull();
    expect(detail?.artifact.title.length).toBeGreaterThan(0);
    expect(detail?.candidateAreas.some((area) => area.name === 'CardHunt')).toBe(true);
    expect(detail?.candidateFacts.map((fact) => fact.id)).toContain('fact_cardhunt_manager_candidate');
    expect(detail?.candidateFacts.every((fact) => fact.status === 'candidate')).toBe(true);
  });

  test('a mail-backed review item carries its thread; unknown ids return null', () => {
    expect(buildReviewDetail('review_recruiter')?.thread?.id).toBe('thread_recruiter_founder');
    expect(buildReviewDetail('review_missing')).toBeNull();
  });

  test('noise rules and recent corrections are derived from the seed', () => {
    expect(buildNoiseRules().every((fact) => fact.kind === 'sender_rule')).toBe(true);
    expect(buildRecentCorrections().every((event) => event.kind === 'context_review')).toBe(true);
  });
});

describe('Review decision effects', () => {
  test('suggested actions preview durable context changes before commit', () => {
    const recruiter = contextReviewItems.find((item) => item.id === 'review_recruiter');
    expect(recruiter).toBeDefined();

    const effects = reviewDecisionOptions(recruiter!);
    expect(effects.map((effect) => effect.action)).toContain('create_area');
    expect(effects.map((effect) => effect.action)).toContain('assign_area');
    expect(effects.every((effect) => typeof effect.persistsContext === 'boolean')).toBe(true);

    const assign = applyReviewDecision(recruiter!, 'assign_area', 'area_job_search');
    expect(assign.recordKind).toBe('areaArtifactLink');
    expect(assign.targetAreaName).toBe('Job Search');
    expect(assign.goingForward).toContain('Job Search');
  });

  test('fact decisions preserve the human confirmation boundary', () => {
    const relationship = contextReviewItems.find((item) => item.id === 'review_cardhunt_andrew_relationship');
    expect(relationship).toBeDefined();

    expect(applyReviewDecision(relationship!, 'verify_fact').recordKind).toBe('verifiedFact');
    const rejected = applyReviewDecision(relationship!, 'reject_fact');
    expect(rejected.recordKind).toBe('rejectedFact');
    expect(rejected.danger).toBe(true);
    expect(applyReviewDecision(relationship!, 'ask_later').persistsContext).toBe(false);
  });
});

describe('Intent capture helpers', () => {
  test('capture labels rotate deterministically', () => {
    expect(pickIntentCaptureLabel(0)).toBe('New Intent');
    expect(pickIntentCaptureLabel(5)).toBe('New Intent');
    expect(pickIntentCaptureLabel(-1)).toBe('Unload Thought');
  });

  test('raw dumps split only when strong separators are present', () => {
    const text = 'File passport renewal\nCheck CardHunt onboarding; and then practice banjo';
    expect(looksLikeMultipleIntents(text)).toBe(true);
    expect(splitIntentText(text)).toEqual([
      'File passport renewal',
      'Check CardHunt onboarding',
      'practice banjo',
    ]);
    expect(splitIntentText('one loose thought without separators')).toEqual([
      'one loose thought without separators',
    ]);
  });

  test('captured intents stay raw until classification later', () => {
    const intent = createCapturedIntent(
      '  Get tax docs together  ',
      'text',
      'intent-capture-test',
      '2026-06-30T12:00:00.000Z',
    );
    expect(intent.rawInput).toBe('Get tax docs together');
    expect(intent.status).toBe('captured');
    expect(intent.classification).toBe('capture');
    expect(intent.likelyAreaId).toBe('');
    expect(intent.captured).toBe(true);
  });
});

describe('Surface stats', () => {
  test('each surface reports four non-negative stat tiles', () => {
    for (const stats of [areasStats(), intentsStats(), unassignedStats()]) {
      expect(stats.length).toBe(4);
      for (const stat of stats) {
        expect(stat.label.length).toBeGreaterThan(0);
        expect(stat.value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('resolveArtifact falls back to the id for unknown artifacts', () => {
    expect(resolveArtifact('mailThread', 'thread_missing').title).toBe('thread_missing');
  });
});
