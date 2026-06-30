import { describe, expect, test } from 'bun:test';
import {
  AREA_LENSES,
  applyReviewDecision,
  areasStats,
  buildAreaDetail,
  buildAreaLens,
  buildAreaLensCounts,
  buildAreaSummaries,
  buildIntentContextPack,
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
  draftedFactKey,
  draftSetupFact,
  intentsStats,
  looksLikeMultipleIntents,
  parseIntent,
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

  test('setup progress counts verified or explicitly confirmed context only', () => {
    const candidateOnly = buildSetupStep('area_relationship');
    expect(candidateOnly).not.toBeNull();
    expect(candidateOnly?.slots.find((slot) => slot.kind === 'person')?.candidateCount).toBeGreaterThan(0);
    expect(candidateOnly?.slots.find((slot) => slot.kind === 'person')?.filled).toBe(false);
    expect(candidateOnly?.started).toBe(false);

    const confirmedSeed = buildSetupStep('area_relationship', {
      confirmedFactIds: new Set(['fact_relationship_lease_candidate']),
    });
    expect(confirmedSeed?.slots.find((slot) => slot.kind === 'person')?.filled).toBe(true);
    expect(confirmedSeed?.started).toBe(true);

    const verifiedDraft = {
      areaId: 'area_schedule',
      kind: 'domain' as const,
      value: 'calendar.example',
      status: 'verified' as const,
      reason: 'Added in setup.',
    };
    const candidateDraft = {
      areaId: 'area_schedule',
      kind: 'person' as const,
      value: 'Morgan handles scheduling.',
      status: 'candidate' as const,
      reason: 'Held to confirm.',
    };
    const withDrafts = buildSetupStep('area_schedule', { drafts: [verifiedDraft, candidateDraft] });
    expect(withDrafts?.slots.find((slot) => slot.kind === 'domain')?.filled).toBe(true);
    expect(withDrafts?.slots.find((slot) => slot.kind === 'person')?.filled).toBe(false);

    const withConfirmedDraft = buildSetupStep('area_schedule', {
      drafts: [candidateDraft],
      confirmedFactIds: new Set([draftedFactKey(candidateDraft)]),
    });
    expect(withConfirmedDraft?.slots.find((slot) => slot.kind === 'person')?.filled).toBe(true);

    const progress = summarizeSetupProgress({ drafts: [verifiedDraft] });
    expect(progress.startedAreas).toBeGreaterThan(buildSetupPlan().filter((step) => step.started).length);
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

  test('repo URL identity matching respects path boundaries', () => {
    const matched = classifyArtifact({
      kind: 'mcpItem',
      id: 'mcp_boundary_positive',
      text: 'Pull request',
      url: 'https://github.com/cardhunt/app/pull/9',
    });
    expect(matched.primary?.areaId).toBe('area_cardhunt');
    expect(matched.primary?.status).toBe('verified');

    const siblingPath = classifyArtifact({
      kind: 'mcpItem',
      id: 'mcp_boundary_negative',
      text: 'Pull request',
      url: 'https://github.com/cardhunt/application/pull/9',
    });
    expect(siblingPath.primary?.areaId).not.toBe('area_cardhunt');
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

  test('events lens ignores rejected calendar links', () => {
    const rejectedCalendarLink = {
      id: 'link_test_rejected_calendar',
      areaId: 'area_music',
      artifactKind: 'calendarEvent' as const,
      artifactId: 'cal_cardhunt_demo',
      role: 'primary',
      status: 'rejected' as const,
      confidence: 0.1,
      reason: 'Rejected during test.',
    };
    const eventIds = buildAreaLens('area_music', 'events', {
      areaArtifactLinks: [rejectedCalendarLink],
    }).map((item) => item.id);
    expect(eventIds).toContain('cal_banjo_practice');
    expect(eventIds).not.toContain('cal_cardhunt_demo');
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

describe('Intent parser, context packs, and grounded plans', () => {
  test('CardHunt new-job input becomes area setup context, not tasks', () => {
    const parsed = parseIntent(
      'I started a new job at CardHunt. My manager is Andrew and most of the work is buyer onboarding.',
    );

    expect(parsed.classification).toBe('area_setup');
    expect(parsed.likelyAreaId).toBe('area_cardhunt');
    expect(parsed.projectNeed).toBe('context_update');
    expect(parsed.candidateFactIds).toContain('fact_cardhunt_manager_candidate');
    expect(parsed.intent.questions.map((question) => question.id)).toContain('q_confirm_andrew');
    expect(parsed.plan.digitalActions.every((action) => action.kind !== 'task')).toBe(true);
    expect(parsed.plan.proposedArtifacts.some((artifact) => artifact.kind === 'email_draft')).toBe(true);
    expect(parsed.contextPack.verified.some((item) => item.id === 'fact_cardhunt_domain_verified')).toBe(
      true,
    );
    expect(
      parsed.contextPack.candidate.find((item) => item.id === 'fact_cardhunt_manager_candidate')?.status,
    ).toBe('candidate');
  });

  test('tax intent becomes a Money obligation with official source refs and progress questions', () => {
    const parsed = parseIntent('Fuck, I need to file my taxes by April 15 and I have no idea what is done.');

    expect(parsed.classification).toBe('obligation');
    expect(parsed.likelyAreaId).toBe('area_money');
    expect(parsed.projectNeed).toBe('project');
    expect(parsed.intent.questions.map((question) => question.id)).toContain('q_tax_progress');
    expect(parsed.candidateFactIds).toContain('fact_money_tax_deadline_candidate');
    expect(parsed.plan.sourceRefs.some((ref) => ref.url?.includes('irs.gov'))).toBe(true);
    expect(parsed.plan.proposedArtifacts.map((artifact) => artifact.kind)).toContain('calendar_event');
  });

  test('Passport alone asks for route details instead of assuming renewal or progress', () => {
    const parsed = parseIntent('Passport');

    expect(parsed.classification).toBe('obligation');
    expect(parsed.likelyAreaId).toBe('area_trip');
    expect(parsed.projectNeed).toBe('unknown');
    expect(parsed.intent.questions.map((question) => question.id)).toContain('q_passport_goal');
    expect(parsed.plan.status).toBe('blocked_on_questions');
    expect(parsed.plan.digitalActions).toHaveLength(0);
    expect(parsed.plan.physicalActions).toHaveLength(0);
    expect(parsed.plan.sourceRefs.some((ref) => ref.url?.includes('travel.state.gov'))).toBe(true);
    const assumedText = [
      ...parsed.intent.assumptions,
      ...parsed.plan.physicalActions,
      ...parsed.plan.digitalActions.map((a) => a.title),
    ].join(' ');
    expect(assumedText.toLowerCase()).not.toContain('renewal');
    expect(assumedText.toLowerCase()).not.toContain('expiration');
    expect(assumedText.toLowerCase()).not.toContain('in hand');
  });

  test('context packs cover no-results, candidate-only, conflicts, and artifact search', () => {
    const passport = buildIntentContextPack('Passport');
    expect(
      [...passport.verified, ...passport.candidate].some((item) => item.id === 'thread_passport_old'),
    ).toBe(true);

    const cardhunt = buildIntentContextPack('CardHunt Andrew buyer onboarding');
    expect(cardhunt.verified.some((item) => item.id === 'fact_cardhunt_repo_verified')).toBe(true);
    expect(cardhunt.candidate.some((item) => item.id === 'fact_cardhunt_manager_candidate')).toBe(true);

    const candidateOnly = buildIntentContextPack('Lease decision with Alex');
    expect(candidateOnly.verified).toHaveLength(0);
    expect(candidateOnly.candidate.some((item) => item.id === 'fact_relationship_lease_candidate')).toBe(
      true,
    );

    const conflict = buildIntentContextPack('CardHunt launch was finished on June 20');
    expect(conflict.contradictions.some((item) => item.id === 'fact_cardhunt_old_status_rejected')).toBe(
      true,
    );
    expect(conflict.questions).toHaveLength(0);

    const noResults = buildIntentContextPack('Hydroponic tomatoes in the greenhouse');
    expect(noResults.noResults).toBe(true);
  });

  test('a captured thought parses through the same pane contract as a seeded intent', () => {
    // Issue #79: the Intent pane renders fresh captures through parseIntent rather
    // than a dead raw panel, so a captured thought must yield the same parsed
    // object (identity preserved, area/scope inferred, a draft plan, no project
    // inflation for a habit) the pane reads from.
    const captured = createCapturedIntent(
      'I want to learn banjo without turning it into a lifestyle app',
      'text',
      'intent_capture_banjo',
      '2026-06-30T12:00:00.000Z',
    );
    const parsed = parseIntent(captured);

    expect(parsed.intent.id).toBe('intent_capture_banjo');
    expect(parsed.classification).toBe('habit');
    expect(parsed.likelyAreaId).toBe('area_music');
    expect(parsed.projectNeed).toBe('task_only');
    expect(parsed.plan.intentId).toBe('intent_capture_banjo');
    expect(parsed.plan.proposedArtifacts.some((artifact) => artifact.kind === 'task')).toBe(true);
    expect(parsed.plan.proposedArtifacts.every((artifact) => artifact.kind !== 'project')).toBe(true);
    expect(parsed.plan.readyToApply).toBe(false);
  });

  test('every parsed intent creates a draft plan object without applying it', () => {
    for (const raw of [
      'Passport',
      'Review the CardHunt buyer onboarding before tomorrow',
      'I actually want to learn banjo this summer',
      'Random loose thought that needs a next action',
    ]) {
      const parsed = parseIntent(raw);
      expect(parsed.plan.intentId).toBe(parsed.intent.id);
      expect(parsed.plan.status.length).toBeGreaterThan(0);
      expect(parsed.plan.readyToApply).toBe(false);
    }
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
