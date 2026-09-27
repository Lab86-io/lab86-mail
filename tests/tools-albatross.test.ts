import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as albatross from '../lib/tools/albatross';
import { invokeTool } from '../lib/tools/registry';
import { runTool } from './tools/harness';

const apiMock = {
  albatrossReplies: { recordProgress: 'albatrossReplies.recordProgress' },
  albatrossWork: {
    createProject: 'albatross.createProject',
    updateProject: 'albatross.updateProject',
    linkArtifact: 'albatross.linkArtifact',
    createSprint: 'albatross.createSprint',
    updateSprint: 'albatross.updateSprint',
    listSprints: 'albatross.listSprints',
    enqueueApproval: 'albatross.enqueueApproval',
    listApprovals: 'albatross.listApprovals',
    getApproval: 'albatross.getApproval',
    decideApproval: 'albatross.decideApproval',
    claimApproval: 'albatross.claimApproval',
    recordPlanApplication: 'albatross.recordPlanApplication',
    listPlanApplications: 'albatross.listPlanApplications',
    getProjectPane: 'albatross.getProjectPane',
    listProjects: 'albatross.listProjects',
  },
  boards: {
    listMyBoards: 'boards.listMyBoards',
    ensureDefaultBoard: 'boards.ensureDefaultBoard',
    getBoard: 'boards.getBoard',
    createCard: 'boards.createCard',
  },
  accounts: {
    listConnectedAccounts: 'accounts.listConnectedAccounts',
  },
  calendarData: {
    listCalendars: 'calendarData.listCalendars',
    getSyncStates: 'calendarData.getSyncStates',
  },
  albatross: {
    getArea: 'albatross.getArea',
  },
  albatrossRoutines: {
    create: 'albatrossRoutines.create',
    listForProject: 'albatrossRoutines.listForProject',
    setConsent: 'albatrossRoutines.setConsent',
    runNow: 'albatrossRoutines.runNow',
  },
  albatrossWorkV2: {
    workDetail: 'albatrossWorkV2.workDetail',
    completeWork: 'albatrossWorkV2.completeWork',
    attachProof: 'albatrossWorkV2.attachProof',
    answerQuestion: 'albatrossWorkV2.answerQuestion',
    setAgentState: 'albatrossWorkV2.setAgentState',
    completeEvidenceReconcile: 'albatrossWorkV2.completeEvidenceReconcile',
    upsertQuestion: 'albatrossWorkV2.upsertQuestion',
  },
  albatrossIntents: {
    markPlanApplied: 'albatrossIntents.markPlanApplied',
  },
  operations: {
    record: 'operations.record',
  },
};

const mutationCalls: Array<{ fn: string; args: any }> = [];
const operationCalls: any[] = [];
const undoCalls: any[] = [];
const approvalOrder: string[] = [];
const toolInvocations: Array<{ tool: string; args: any }> = [];
const queryFailures = new Set<string>();
const failingCardTitles = new Set<string>();
let approvalFixture: any = null;
let connectedAccountsFixture: any[] = [];
let areaFixture: any = null;
let workDetailFixture: any = null;
let generatedPlanIdFixture = 'plan_revised';
let evidenceAtDuringPlanFixture: number | undefined;
let sequence = 0;

async function convexMutationMock(fn: string, args: any) {
  mutationCalls.push({ fn, args });
  sequence += 1;
  if (fn === apiMock.albatrossWorkV2.completeWork) return { state: 'done', title: 'Monro' };
  if (fn === apiMock.albatrossReplies.recordProgress) {
    workDetailFixture.evidence = [
      ...(workDetailFixture.evidence || []),
      {
        claim: args.claim,
        title: 'Progress reported in Albatross chat',
        sourceKind: 'chat',
        trust: 'confirmed',
      },
    ];
    if (args.waitingForReply) workDetailFixture.work.workState = 'waiting';
    return { state: workDetailFixture.work.workState || 'active' };
  }
  if (fn === apiMock.albatrossWorkV2.attachProof && workDetailFixture) {
    workDetailFixture = {
      ...workDetailFixture,
      evidence: [
        ...(workDetailFixture.evidence || []),
        {
          _id: `evidence_${sequence}`,
          claim: args.claim,
          title: args.title,
          summary: args.summary,
          limits: args.limits,
          sourceKind: args.sourceKind,
          trust: args.trust,
          url: args.url,
        },
      ],
    };
  }
  if (fn === apiMock.albatrossWorkV2.answerQuestion && workDetailFixture) {
    workDetailFixture = {
      ...workDetailFixture,
      questions: (workDetailFixture.questions || []).map((question: any) =>
        String(question._id) === String(args.questionId)
          ? { ...question, status: 'answered', answer: args.answer }
          : question,
      ),
    };
  }
  if (fn === apiMock.albatrossWork.createProject) return `project_${sequence}`;
  if (fn === apiMock.albatrossWork.createSprint) return `sprint_${sequence}`;
  if (fn === apiMock.albatrossWork.enqueueApproval) return `approval_${sequence}`;
  if (fn === apiMock.albatrossWork.recordPlanApplication) return `application_${sequence}`;
  if (fn === apiMock.albatrossRoutines.create) return `routine_${sequence}`;
  if (fn === apiMock.albatrossWork.claimApproval) {
    approvalOrder.push('claimApproval');
    approvalFixture = { ...approvalFixture, status: 'claiming' };
    return { ok: true, approval: approvalFixture };
  }
  if (fn === apiMock.albatrossWork.decideApproval) {
    approvalFixture = {
      ...approvalFixture,
      status: args.status,
      decisionNote: args.decisionNote,
      result: args.result ?? approvalFixture?.result,
      undoExpiresAt: args.undoExpiresAt ?? approvalFixture?.undoExpiresAt,
    };
    return {
      ok: true,
      approval: approvalFixture,
    };
  }
  return { ok: true };
}

async function convexQueryMock(fn: string, args: any) {
  if (queryFailures.has(fn)) throw new Error(`Query failed: ${fn}`);
  if (fn === apiMock.accounts.listConnectedAccounts) return connectedAccountsFixture;
  if (fn === apiMock.calendarData.listCalendars)
    return connectedAccountsFixture.map((account, index) => ({
      accountId: account.accountId,
      providerCalendarId: `calendar-${index}`,
      isPrimary: index === 0,
      readOnly: false,
    }));
  if (fn === apiMock.calendarData.getSyncStates)
    return connectedAccountsFixture.map((account) => ({ accountId: account.accountId, status: 'idle' }));
  if (fn === apiMock.albatross.getArea) return areaFixture;
  if (fn === apiMock.albatrossWork.listApprovals)
    return [{ approvalId: 'approval_pending', status: args.status }];
  if (fn === apiMock.albatrossWork.getApproval) return approvalFixture;
  if (fn === apiMock.albatrossWork.listProjects) return [{ projectId: 'project_live', status: args.status }];
  if (fn === apiMock.albatrossWork.getProjectPane) return { project: { projectId: args.projectId } };
  if (fn === apiMock.albatrossWork.listSprints) return [{ sprintId: 'sprint_live', status: args.status }];
  if (fn === apiMock.albatrossRoutines.listForProject)
    return [{ routineId: 'routine_1', projectId: args.projectId }];
  if (fn === apiMock.albatrossWorkV2.workDetail) return workDetailFixture;
  if (fn === apiMock.albatrossWork.listPlanApplications) return [];
  return null;
}

async function recordOperationMock(input: any) {
  operationCalls.push(input);
  return `operation_${operationCalls.length}`;
}

async function invokeToolMock(tool: any, args: any, ctx?: any) {
  sequence += 1;
  approvalOrder.push(`tool:${tool.name}`);
  toolInvocations.push({ tool: tool.name, args });
  if (tool.name === 'albatross_apply_intent_plan') {
    return tool.handler(args, ctx);
  }
  if (tool.name === 'tasks_create_card') {
    if (failingCardTitles.has(args.title)) throw new Error('Board write failed');
    return { ok: true, cardId: `card_${sequence}`, operationId: `operation_card_${sequence}` };
  }
  if (tool.name === 'calendar_create_event') {
    return {
      ok: true,
      eventId: `event_${sequence}`,
      calendarId: 'cal_primary',
      operationId: `operation_event_${sequence}`,
    };
  }
  if (tool.name === 'save_draft') {
    return {
      ok: true,
      draft: { _id: `draft_${sequence}`, account: args.account || 'jakob@example.test' },
      operationId: `operation_draft_${sequence}`,
    };
  }
  if (tool.name === 'document_create') {
    return {
      ok: true,
      documentId: `document_${sequence}`,
      title: args.title,
      kind: args.kind,
      revision: 1,
      openPath: `/?view=files&document=document_${sequence}`,
      operationId: `operation_document_${sequence}`,
    };
  }
  if (tool.name === 'send_message') return { ok: true, messageId: `message_${sequence}` };
  if (tool.name === 'calendar_rsvp_event') {
    return {
      ok: true,
      eventId: args.eventId,
      status: args.status,
      operationId: `operation_rsvp_${sequence}`,
    };
  }
  return { ok: true };
}

async function undoOperationMock(userId: string, operationId: string) {
  undoCalls.push({ userId, operationId });
  return { undone: operationId, surface: 'calendar' };
}

beforeEach(() => {
  mutationCalls.length = 0;
  operationCalls.length = 0;
  undoCalls.length = 0;
  approvalOrder.length = 0;
  toolInvocations.length = 0;
  queryFailures.clear();
  failingCardTitles.clear();
  approvalFixture = null;
  connectedAccountsFixture = [];
  areaFixture = null;
  workDetailFixture = null;
  generatedPlanIdFixture = 'plan_revised';
  evidenceAtDuringPlanFixture = undefined;
  sequence = 0;
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexMutation: convexMutationMock as any,
    convexQuery: convexQueryMock as any,
    recordOperation: recordOperationMock as any,
    newOperationBatchId: () => 'batch_mocked',
    undoOperation: undoOperationMock as any,
    invokeTool: invokeToolMock as any,
    generateIntentPlan: (async () => {
      if (workDetailFixture?.work?._id === 'work_passport') {
        if (!(workDetailFixture.evidence || []).some((row: any) => row.sourceKind === 'chat')) {
          throw new Error('Planner did not receive recorded progress.');
        }
        if (!(workDetailFixture.questions || []).some((row: any) => row.status === 'answered')) {
          throw new Error('Planner did not receive the persisted question answer.');
        }
      }
      if (evidenceAtDuringPlanFixture !== undefined && workDetailFixture?.work) {
        workDetailFixture = {
          ...workDetailFixture,
          work: { ...workDetailFixture.work, lastEvidenceAt: evidenceAtDuringPlanFixture },
        };
      }
      workDetailFixture = {
        ...workDetailFixture,
        plan: {
          _id: 'plan_revised',
          outcome: 'Passport renewed',
          digitalActions: [
            { actionKey: 'form', kind: 'task', title: 'Complete DS-82' },
            { actionKey: 'mail', kind: 'task', title: 'Mail the application' },
            {
              actionKey: 'form-hold',
              kind: 'calendar_event',
              title: 'Complete DS-82 form',
              account: 'acct_primary',
              startIso: '2026-08-12T17:00:00.000Z',
              endIso: '2026-08-12T17:45:00.000Z',
            },
          ],
        },
      };
      return { planId: generatedPlanIdFixture, title: 'Renew passport', outcome: 'Passport renewed' };
    }) as any,
  });
});

afterAll(() => {
  albatross.__setAlbatrossToolDepsForTest();
});

describe('Albatross plan apply failures (WRK-4, WRK-1)', () => {
  const plan = {
    id: 'plan_partial',
    outcome: 'Moved in',
    digitalActions: [
      { kind: 'task', key: 'step-1', actionKey: 'a1', title: 'Book the truck' },
      { kind: 'task', key: 'step-2', actionKey: 'a2', title: 'Pack the kitchen' },
      {
        kind: 'document',
        key: 'step-3',
        actionKey: 'a3',
        title: 'Moving checklist',
        documentKind: 'doc',
        instructions: 'List',
      },
    ],
  };

  test('a failed step keeps the created artifacts recorded and reports the failure', async () => {
    failingCardTitles.add('Pack the kitchen');
    await expect(
      runTool(albatross.albatrossApplyIntentPlan.handler, {
        intentId: 'intent_move',
        projectMode: 'task_only',
        plan,
      }),
    ).rejects.toThrow('1 failed: Pack the kitchen (Board write failed)');
    const recorded = mutationCalls.find((call) => call.fn === apiMock.albatrossWork.recordPlanApplication);
    expect(recorded?.args.status).toBe('partially_applied');
    expect(recorded?.args.artifacts.map((artifact: any) => artifact.actionKey)).toEqual(['a1', 'a3']);
    expect(recorded?.args.unresolvedArtifacts).toContainEqual(
      expect.objectContaining({ actionKey: 'a2', reason: 'failed' }),
    );
    // The recorded document keeps its id, so the plan binds it (WRK-5).
    expect(recorded?.args.artifacts[1]).toMatchObject({ kind: 'document', stepKey: 'step-3' });
  });

  test('nothing is recorded when no step could be created', async () => {
    failingCardTitles.add('Book the truck');
    await expect(
      runTool(albatross.albatrossApplyIntentPlan.handler, {
        intentId: 'intent_move',
        projectMode: 'task_only',
        plan: { ...plan, digitalActions: [plan.digitalActions[0]] },
      }),
    ).rejects.toThrow('Could not apply the plan: Board write failed');
    expect(mutationCalls.some((call) => call.fn === apiMock.albatrossWork.recordPlanApplication)).toBe(false);
  });

  test('a plan task carries its Work id as source.intentId', async () => {
    await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_move',
      projectMode: 'task_only',
      plan: { ...plan, digitalActions: [plan.digitalActions[0]] },
    });
    const card = toolInvocations.find((call) => call.tool === 'tasks_create_card');
    expect(card?.args.source).toMatchObject({
      kind: 'chat',
      externalId: 'intent_move',
      intentId: 'intent_move',
    });
  });
});

describe('Albatross tools', () => {
  test('creates a timezone-aware routine without silently enabling notifications', async () => {
    const result = await runTool(albatross.albatrossCreateRoutine.handler, {
      projectId: 'project_health',
      areaId: 'area_personal',
      title: 'Evening food reflection',
      purpose: 'Build enough evidence to estimate calories without pretending observation is certainty.',
      kind: 'checkin',
      cadence: 'daily',
      localTime: '20:30',
      activation: 'active',
      questionTemplate: {
        prompt: 'What did you eat today?',
        responseKind: 'text',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'active',
      notification: 'asks_once_after_first_checkin',
    });
    expect(mutationCalls[0]).toMatchObject({
      fn: apiMock.albatrossRoutines.create,
      args: {
        projectId: 'project_health',
        timezone: 'America/New_York',
        consent: 'enabled',
        notification: { enabled: false, channel: 'in_app' },
      },
    });

    const consent = await runTool(albatross.albatrossSetRoutineConsent.handler, {
      routineId: result.routineId,
      consent: 'enabled',
      localTime: '21:00',
      notificationEnabled: true,
      notificationChannel: 'in_app',
    });
    expect(consent.ok).toBeTrue();
    expect(mutationCalls.at(-1)).toMatchObject({
      fn: apiMock.albatrossRoutines.setConsent,
      args: {
        routineId: result.routineId,
        consent: 'enabled',
        localTime: '21:00',
        timezone: 'America/New_York',
        notificationEnabled: true,
        notificationChannel: 'in_app',
      },
    });
  });

  test('does not promise a notification-consent question for task-only routines', async () => {
    const result = await runTool(albatross.albatrossCreateRoutine.handler, {
      projectId: 'project_home',
      title: 'Tidy one room',
      kind: 'task',
      cadence: 'weekdays',
      localTime: '18:00',
      activation: 'active',
      taskTemplate: { title: 'Tidy one room for 15 minutes' },
    });

    expect(result.notification).toBe('not_requested_for_task_only');
    expect(mutationCalls[0]?.args.notification.enabled).toBe(false);
  });

  test('apply_intent_plan creates project/task/draft artifacts, queues approvals, links artifacts, and records the application', async () => {
    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_tax',
      intentText: 'Get taxes unstuck',
      areaId: 'area_money',
      account: 'jakob@example.test',
      projectMode: 'project',
      projectTitle: 'Tax cleanup',
      plan: {
        id: 'plan_tax',
        outcome: 'Know exactly what remains and schedule the work.',
        sourceRefs: [{ kind: 'intent', id: 'intent_tax', label: 'Raw tax intent' }],
        digitalActions: [
          {
            kind: 'task',
            key: 'step-1',
            title: 'List missing tax docs',
            priority: 1,
            description: 'Find W-2, 1099, and brokerage records.',
          },
          {
            kind: 'email_draft',
            title: 'Draft CPA note',
            to: 'cpa@example.test',
            body: 'I am collecting records and will send the missing list.',
          },
          {
            kind: 'email_send',
            key: 'step-3',
            title: 'Send CPA note',
            to: 'cpa@example.test',
            body: 'I am collecting records and will send the missing list.',
          },
          {
            kind: 'calendar_rsvp',
            title: 'Reply to tax review invite',
            calendarId: 'cal_1',
            eventId: 'evt_1',
            rsvpStatus: 'yes',
          },
          { kind: 'area_fact', title: 'CPA prefers secure upload' },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.projectId).toMatch(/^project_/);
    expect(result.operations.map((operation: any) => operation.tool)).toContain('albatross_create_project');
    expect(result.operations.map((operation: any) => operation.tool)).toContain('tasks_create_card');
    expect(result.operations.map((operation: any) => operation.tool)).toContain('save_draft');
    expect(result.approvals).toHaveLength(2);
    expect(result.unresolved).toHaveLength(1);

    // Plan step keys ride through to created operations and approvals so the
    // dossier can map its task cards back to real board cards.
    const taskOperation = result.operations.find((operation: any) => operation.tool === 'tasks_create_card');
    expect(taskOperation).toMatchObject({ stepKey: 'step-1', kind: 'task' });
    expect(taskOperation.artifactId).toBeTruthy();
    const draftOperation = result.operations.find((operation: any) => operation.tool === 'save_draft');
    expect(draftOperation.stepKey).toBeUndefined();
    const sendApproval = result.approvals.find((approval: any) => approval.stepKey === 'step-3');
    expect(sendApproval).toMatchObject({ kind: 'email_send' });

    const createdProject = mutationCalls.find((call) => call.fn === apiMock.albatrossWork.createProject);
    expect(createdProject?.args).toMatchObject({
      userId: 'test_user_tools',
      externalId: 'intent:intent_tax',
      title: 'Tax cleanup',
      areaId: 'area_money',
    });
    expect(
      mutationCalls.filter((call) => call.fn === apiMock.albatrossWork.linkArtifact).length,
    ).toBeGreaterThanOrEqual(3);
    expect(mutationCalls.filter((call) => call.fn === apiMock.albatrossWork.enqueueApproval)).toHaveLength(2);
    expect(
      mutationCalls.find((call) => call.fn === apiMock.albatrossWork.recordPlanApplication)?.args,
    ).toMatchObject({
      intentId: 'intent_tax',
      status: 'partially_applied',
    });
    expect(operationCalls.some((call) => call.inverse?.kind === 'albatross.archive_project')).toBe(true);
  });

  test('apply_intent_plan auto-derives a project from a 3-task plan and links every card so the Projects lens can count them', async () => {
    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_move',
      intentText: 'we are moving to rochester in september',
      intentTitle: 'Plan the Rochester move',
      projectMode: 'auto',
      plan: {
        id: 'plan_move',
        outcome: 'The move is planned end to end.',
        digitalActions: [
          { kind: 'task', key: 'step-1', title: 'Book movers' },
          { kind: 'task', key: 'step-2', title: 'Give landlord notice' },
          { kind: 'task', key: 'step-3', title: 'Change address everywhere' },
        ],
      },
    });

    expect(result.ok).toBe(true);
    // No model-declared projectTitle — the multi-step heuristic still made an
    // epic, named after the intent (root cause of invisible projects).
    expect(result.projectId).toMatch(/^project_/);
    const createdProject = mutationCalls.find((call) => call.fn === apiMock.albatrossWork.createProject);
    expect(createdProject?.args.title).toBe('Plan the Rochester move');

    // Every created card is linked to the project with the exact link shape
    // listProjectsWithProgress counts (artifactKind 'task' + cardId), plus the
    // source intent link — live n-of-m progress depends on these rows.
    const links = mutationCalls.filter((call) => call.fn === apiMock.albatrossWork.linkArtifact);
    const taskLinks = links.filter((call) => call.args.artifactKind === 'task');
    expect(taskLinks).toHaveLength(3);
    for (const link of taskLinks) {
      expect(link.args.projectId).toBe(result.projectId);
      expect(link.args.artifactId).toMatch(/^card_/);
      expect(link.args.sourceIntentId).toBe('intent_move');
    }
    expect(links.filter((call) => call.args.artifactKind === 'intent')).toHaveLength(1);
  });

  test('apply_intent_plan creates and links a private document artifact through the shared document tool', async () => {
    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_brief',
      intentText: 'Prepare the launch brief',
      areaId: 'area_launch',
      projectMode: 'project',
      projectTitle: 'Launch readiness',
      plan: {
        id: 'plan_brief',
        outcome: 'The team has an editable launch brief.',
        digitalActions: [
          {
            kind: 'document',
            key: 'step-document',
            title: 'Launch decision brief',
            documentKind: 'doc',
            instructions: 'Draft the source-grounded launch decision brief.',
            sourceRefs: [{ kind: 'intent', id: 'intent_brief' }],
          },
        ],
      },
    });

    const invocation = toolInvocations.find((call) => call.tool === 'document_create');
    expect(invocation?.args).toMatchObject({
      kind: 'doc',
      title: 'Launch decision brief',
      instructions: 'Draft the source-grounded launch decision brief.',
    });
    const operation = result.operations.find((entry: any) => entry.kind === 'document');
    expect(operation).toMatchObject({
      stepKey: 'step-document',
      artifactId: expect.stringMatching(/^document_/),
    });
    expect(
      mutationCalls.find((call) => call.fn === apiMock.albatrossWork.recordPlanApplication)?.args.artifacts,
    ).toContainEqual(expect.objectContaining({ kind: 'document', id: operation.artifactId }));
    expect(
      mutationCalls.find(
        (call) => call.fn === apiMock.albatrossWork.linkArtifact && call.args.artifactKind === 'document',
      )?.args,
    ).toMatchObject({ artifactId: operation.artifactId, projectId: result.projectId });
  });

  test('apply_intent_plan falls back to the first connected account so calendar events and drafts execute instead of stalling unresolved', async () => {
    connectedAccountsFixture = [
      { accountId: 'acct_disconnected', status: 'disconnected' },
      { accountId: 'acct_primary', status: 'connected', email: 'jakob@example.test' },
    ];
    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_trip',
      intentTitle: 'Plan the fall trip',
      projectMode: 'project',
      plan: {
        id: 'plan_trip',
        outcome: 'Trip booked and confirmed.',
        digitalActions: [
          { kind: 'task', key: 'step-1', title: 'Compare flight prices' },
          {
            kind: 'calendar_event',
            key: 'step-2',
            title: 'Booking session',
            startIso: '2026-07-09T15:00:00.000Z',
            endIso: '2026-07-09T16:00:00.000Z',
          },
          {
            kind: 'email_draft',
            key: 'step-3',
            title: 'Draft hotel inquiry',
            to: 'frontdesk@example.test',
            body: 'Do you have availability the second week of September?',
          },
        ],
      },
    });

    // Nothing unresolved: the account gap used to silently drop events/drafts.
    expect(result.unresolved).toHaveLength(0);
    const eventInvocation = toolInvocations.find((call) => call.tool === 'calendar_create_event');
    expect(eventInvocation?.args.account).toBe('acct_primary');
    const draftInvocation = toolInvocations.find((call) => call.tool === 'save_draft');
    expect(draftInvocation?.args.account).toBe('acct_primary');

    // The event and draft link to the project under the kinds the progress
    // query counts (calendarEvent feeds eventCount).
    const links = mutationCalls.filter((call) => call.fn === apiMock.albatrossWork.linkArtifact);
    const kinds = links.map((call) => call.args.artifactKind);
    expect(kinds).toContain('calendarEvent');
    expect(kinds).toContain('emailDraft');

    // Step keys ride through per kind so appliedSteps can record
    // cardId/eventId/draftId for the dossier.
    const eventOperation = result.operations.find(
      (operation: any) => operation.tool === 'calendar_create_event',
    );
    expect(eventOperation).toMatchObject({ stepKey: 'step-2', kind: 'calendar_event' });
    expect(eventOperation.artifactId).toMatch(/^event_/);
    const draftOperation = result.operations.find((operation: any) => operation.tool === 'save_draft');
    expect(draftOperation).toMatchObject({ stepKey: 'step-3', kind: 'email_draft' });
    expect(draftOperation.artifactId).toMatch(/^draft_/);
  });

  test('apply_intent_plan routes cards to the intent area’s linked board when one exists', async () => {
    areaFixture = { _id: 'area_move', name: 'Rochester move', status: 'active', boardId: 'board_area_move' };
    await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_move',
      areaId: 'area_move',
      projectMode: 'task_only',
      plan: {
        digitalActions: [{ kind: 'task', key: 'step-1', title: 'Book movers' }],
      },
    });
    const cardInvocation = toolInvocations.find((call) => call.tool === 'tasks_create_card');
    expect(cardInvocation?.args.boardId).toBe('board_area_move');
  });

  test('apply_intent_plan leaves the board unset (default board) when the intent has no area board', async () => {
    areaFixture = null;
    await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_loose',
      areaId: 'area_unknown',
      projectMode: 'task_only',
      plan: { digitalActions: [{ kind: 'task', key: 'step-1', title: 'One-off errand' }] },
    });
    const cardInvocation = toolInvocations.find((call) => call.tool === 'tasks_create_card');
    expect(cardInvocation?.args.boardId).toBeUndefined();
  });

  test('apply_intent_plan keeps safe task execution available when account and area lookups fail', async () => {
    queryFailures.add(apiMock.accounts.listConnectedAccounts);
    queryFailures.add(apiMock.albatross.getArea);

    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_resilient',
      areaId: 'area_unavailable',
      projectMode: 'task_only',
      plan: { digitalActions: [{ kind: 'task', key: 'step-1', title: 'Keep moving' }] },
    });

    expect(result.unresolved).toHaveLength(0);
    const taskInvocation = toolInvocations.find((call) => call.tool === 'tasks_create_card');
    expect(taskInvocation).toBeDefined();
    expect(taskInvocation?.args.boardId).toBeUndefined();
  });

  test('account resolution keeps a connected fallback when calendar lookup fails', async () => {
    connectedAccountsFixture = [{ accountId: 'healthy', status: 'connected' }];
    queryFailures.add(apiMock.calendarData.listCalendars);

    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_mail_fallback',
      projectMode: 'task_only',
      plan: {
        digitalActions: [
          {
            kind: 'email_draft',
            key: 'draft-1',
            title: 'Draft the inquiry',
            to: 'office@example.test',
            body: 'Are appointments available?',
          },
        ],
      },
    });

    expect(result.unresolved).toHaveLength(0);
    expect(toolInvocations.find((call) => call.tool === 'save_draft')?.args.account).toBe('healthy');
  });

  test('apply_intent_plan records queued status when nothing can be executed yet', async () => {
    const result = await runTool(albatross.albatrossApplyIntentPlan.handler, {
      intentId: 'intent_blocked',
      projectMode: 'task_only',
      plan: {
        digitalActions: [
          { kind: 'email_send', title: 'Missing send details', to: 'person@example.test' },
          { kind: 'area_fact', title: 'Candidate context only' },
        ],
      },
    });

    expect(result.operations).toHaveLength(0);
    expect(result.approvals).toHaveLength(0);
    expect(result.unresolved).toHaveLength(2);
    expect(
      mutationCalls.find((call) => call.fn === apiMock.albatrossWork.recordPlanApplication)?.args.status,
    ).toBe('queued');
  });

  test('project and sprint tools use Convex rows plus undoable operations', async () => {
    const project = await runTool(albatross.albatrossCreateProject.handler, {
      externalId: 'intent:demo',
      title: 'Buyer onboarding launch',
      outcome: 'Ship the first launch checklist.',
      areaId: 'area_cardhunt',
      sourceIntentId: 'intent_cardhunt',
      operationBatchId: 'batch_project',
    });
    const sprint = await runTool(albatross.albatrossCreateSprint.handler, {
      projectId: project.projectId,
      title: 'Launch week',
      goal: 'Close onboarding gaps',
      status: 'active',
      operationBatchId: 'batch_project',
    });
    const projects = await runTool(albatross.albatrossListProjects.handler, { status: 'active' });
    const updated = await runTool(albatross.albatrossUpdateProject.handler, {
      projectId: project.projectId,
      status: 'paused',
    });
    const pane = await runTool(albatross.albatrossGetProjectPane.handler, { projectId: project.projectId });
    const sprints = await runTool(albatross.albatrossListSprints.handler, {
      projectId: project.projectId,
      status: 'active',
    });

    expect(project.operationId).toBe('operation_1');
    expect(sprint.operationId).toBe('operation_2');
    expect(updated.operationId).toBe('operation_3');
    expect(projects.projects[0].projectId).toBe('project_live');
    expect(pane.pane.project.projectId).toBe(project.projectId);
    expect(sprints.sprints[0].sprintId).toBe('sprint_live');
    expect(operationCalls.map((call) => call.inverse?.kind)).toEqual([
      'albatross.archive_project',
      'albatross.archive_sprint',
      'albatross.restore_project_status',
    ]);
    expect(mutationCalls.find((call) => call.fn === apiMock.albatrossWork.updateProject)?.args).toMatchObject(
      {
        projectId: project.projectId,
        status: 'paused',
      },
    );
    await runTool(albatross.albatrossCreateSprint.handler, {
      title: 'Fallback batch sprint',
      status: 'planned',
    });
    expect(operationCalls.at(-1)?.batchId).toBe('batch_mocked');
  });

  test('routine tools list a project routines and run one now as the user', async () => {
    const listed = await runTool(albatross.albatrossListRoutines.handler, { projectId: 'project_live' });
    expect(listed.routines).toEqual([{ routineId: 'routine_1', projectId: 'project_live' }]);
    const ran = await runTool(albatross.albatrossRunRoutineNow.handler, { routineId: 'routine_1' });
    expect(ran).toEqual({ ok: true });
    expect(mutationCalls.find((call) => call.fn === apiMock.albatrossRoutines.runNow)?.args).toMatchObject({
      routineId: 'routine_1',
    });
  });

  test('approval queue tools claim before execution, reject, undo provider operations, and protect unsupported approvals', async () => {
    const listed = await runTool(albatross.albatrossListApprovalQueue.handler, {
      status: 'pending',
      limit: 5,
    });
    expect(listed.approvals[0]).toMatchObject({ approvalId: 'approval_pending', status: 'pending' });

    approvalFixture = {
      approvalId: 'approval_pending',
      status: 'pending',
      toolName: 'external_action',
      toolArgs: {},
      operationBatchId: 'batch_approval',
      undoExpiresAt: Date.now() + 5_000,
    };
    await expect(
      runTool(albatross.albatrossApproveAction.handler, { approvalId: 'approval_pending' }),
    ).rejects.toThrow(/Approval tool not allowed/);
    expect(mutationCalls.some((call) => call.fn === apiMock.albatrossWork.claimApproval)).toBe(false);

    approvalFixture = {
      approvalId: 'approval_pending',
      status: 'pending',
      toolName: 'send_message',
      toolArgs: {
        account: 'jakob@example.test',
        to: 'cpa@example.test',
        subject: 'Tax docs',
        body: 'I will send the missing list.',
      },
      operationBatchId: 'batch_approval',
      undoExpiresAt: Date.now() + 5_000,
    };
    const approved = await runTool(albatross.albatrossApproveAction.handler, {
      approvalId: 'approval_pending',
    });
    expect(approved.result.messageId).toMatch(/^message_/);
    expect(approved.approval.status).toBe('approved');
    expect(mutationCalls.map((call) => call.fn)).toContain(apiMock.albatrossWork.claimApproval);
    expect(approvalOrder.indexOf('claimApproval')).toBeLessThan(approvalOrder.indexOf('tool:send_message'));
    expect(mutationCalls.at(-1)?.args.undoExpiresAt).toBeUndefined();

    approvalFixture = {
      approvalId: 'approval_reject',
      status: 'pending',
      toolName: 'send_message',
      toolArgs: {},
    };
    const rejected = await runTool(albatross.albatrossRejectAction.handler, {
      approvalId: 'approval_reject',
      reason: 'User rejected.',
    });
    expect(rejected.ok).toBe(true);
    expect(mutationCalls.at(-1)?.args).toMatchObject({ status: 'rejected', decisionNote: 'User rejected.' });

    approvalFixture = {
      approvalId: 'approval_rsvp',
      status: 'pending',
      toolName: 'calendar_rsvp_event',
      toolArgs: {
        account: 'jakob@example.test',
        calendarId: 'cal_1',
        eventId: 'evt_1',
        status: 'yes',
      },
      operationBatchId: 'batch_approval',
    };
    const approvedRsvp = await runTool(albatross.albatrossApproveAction.handler, {
      approvalId: 'approval_rsvp',
    });
    expect(approvedRsvp.result.operationId).toMatch(/^operation_rsvp_/);
    expect(mutationCalls.at(-1)?.args.undoExpiresAt).toBeGreaterThan(Date.now());
  });

  test('records user-confirmed progress with source evidence, then versions the same Work plan', async () => {
    workDetailFixture = {
      work: {
        _id: 'work_passport',
        title: 'Renew passport',
        rawText: 'Renew my passport',
        primaryProjectId: 'project_passport',
      },
      plan: {
        _id: 'plan_old',
        outcome: 'Passport renewed',
        digitalActions: [
          { actionKey: 'photos', kind: 'task', title: 'Buy passport photos' },
          { actionKey: 'form', kind: 'task', title: 'Complete DS-82' },
        ],
      },
      questions: [{ _id: 'question_1', status: 'pending', prompt: 'Did you buy photos?' }],
      evidence: [],
    };

    const recorded = await runTool(albatross.albatrossRecordProgress.handler, {
      workId: 'work_passport',
      claim: 'I already bought the passport photo package.',
      questionAnswers: [{ questionId: 'question_1', answer: 'Yes, it is purchased.' }],
      evidence: [
        {
          sourceKind: 'mail_thread',
          sourceId: 'receipt_thread',
          accountId: 'personal',
          title: 'Passport photo receipt',
          summary: 'Purchase confirmation from the photo service.',
          trust: 'observed',
        },
      ],
    });

    expect(recorded).toMatchObject({
      ok: true,
      workId: 'work_passport',
      evidenceRecorded: 2,
      questionsAnswered: 1,
    });
    const proofWrites = mutationCalls.filter((call) => call.fn === apiMock.albatrossWorkV2.attachProof);
    expect(proofWrites).toHaveLength(1);
    expect(
      mutationCalls.find((call) => call.fn === apiMock.albatrossReplies.recordProgress)?.args.claim,
    ).toBe('I already bought the passport photo package.');
    expect(proofWrites[0].args).toMatchObject({
      sourceKind: 'mail_thread',
      sourceId: 'receipt_thread',
      trust: 'observed',
      settleContract: false,
    });
    expect(mutationCalls.some((call) => call.fn === apiMock.albatrossWorkV2.answerQuestion)).toBe(true);

    const revised = await runTool(albatross.albatrossReplanWork.handler, {
      workId: 'work_passport',
      reason: 'Photos are already purchased.',
    });
    expect(revised).toMatchObject({
      ok: true,
      workId: 'work_passport',
      planId: 'plan_revised',
      currentStep: 'Complete DS-82',
      removedSteps: ['Buy passport photos'],
      addedSteps: ['Mail the application', 'Complete DS-82 form'],
      actionsApplied: 3,
      calendarEventsCreated: 1,
      needsInput: false,
    });
    expect(mutationCalls.some((call) => call.fn === apiMock.albatrossIntents.markPlanApplied)).toBe(true);
    expect(
      mutationCalls.some(
        (call) => call.fn === apiMock.albatrossWorkV2.setAgentState && call.args.agentState === 'idle',
      ),
    ).toBe(true);
    expect(mutationCalls.some((call) => call.fn === apiMock.albatrossWork.createProject)).toBe(false);
    expect(toolInvocations.find((call) => call.tool === 'albatross_apply_intent_plan')?.args).toMatchObject({
      existingProjectId: 'project_passport',
      projectMode: 'task_only',
    });
    expect(toolInvocations.some((call) => call.tool === 'calendar_create_event')).toBe(true);
  });

  test('reads compact Work context and refuses a missing Work', async () => {
    workDetailFixture = {
      work: {
        _id: 'work_context',
        title: 'Renew passport',
        rawText: 'Get the passport renewed',
        workState: 'active',
        primaryAreaId: 'area_personal',
      },
      plan: {
        _id: 'plan_context',
        outcome: 'Passport renewed',
        summary: 'The photo package is purchased.',
        status: 'ready',
        digitalActions: [{ key: 'form', actionKey: 'form', kind: 'task', title: 'Complete DS-82' }],
        physicalActions: [{ title: 'Mail the application' }],
      },
      questions: [
        { _id: 'question_open', status: 'pending', prompt: 'Standard or expedited?' },
        { _id: 'question_done', status: 'answered', prompt: 'Do you have photos?' },
      ],
      evidence: [
        {
          _id: 'evidence_receipt',
          claim: 'Photos were purchased',
          title: 'Photo receipt',
          summary: 'Paid receipt',
          limits: 'Does not prove the photos were delivered.',
          sourceKind: 'mail_thread',
          trust: 'observed',
          url: 'https://mail.test/thread',
        },
      ],
    };

    const result = await runTool(albatross.albatrossGetWorkContext.handler, {
      workId: 'work_context',
    });
    expect(result.context).toMatchObject({
      work: { id: 'work_context', state: 'active', areaId: 'area_personal' },
      plan: { id: 'plan_context', outcome: 'Passport renewed' },
      questions: [{ id: 'question_open', prompt: 'Standard or expedited?' }],
      evidence: [{ id: 'evidence_receipt', sourceKind: 'mail_thread' }],
    });

    workDetailFixture = null;
    await expect(
      runTool(albatross.albatrossGetWorkContext.handler, { workId: 'work_missing' }),
    ).rejects.toThrow(/not found/i);
  });

  test('a replan that needs one answer returns to idle without creating premature actions', async () => {
    workDetailFixture = {
      work: {
        _id: 'work_passport_question',
        title: 'Renew passport',
        rawText: 'Renew my passport',
      },
      plan: {
        _id: 'plan_old',
        outcome: 'Passport renewed',
        digitalActions: [{ actionKey: 'form', kind: 'task', title: 'Complete DS-82' }],
      },
      questions: [
        {
          _id: 'question_speed',
          legacyQuestionId: 'speed',
          status: 'pending',
          prompt: 'Standard or expedited processing?',
          options: [{ id: 'standard', label: 'Standard', description: 'Lower fee' }],
        },
      ],
      evidence: [],
    };

    const result = await runTool(albatross.albatrossReplanWork.handler, {
      workId: 'work_passport_question',
      reason: 'The processing speed changes the remaining plan.',
    });

    expect(result).toMatchObject({ needsInput: true, actionsApplied: 0, calendarEventsCreated: 0 });
    expect(mutationCalls).toContainEqual({
      fn: apiMock.albatrossWorkV2.upsertQuestion,
      args: expect.objectContaining({
        workId: 'work_passport_question',
        legacyQuestionId: 'speed',
        prompt: 'Standard or expedited processing?',
        options: [{ id: 'standard', label: 'Standard', description: 'Lower fee' }],
      }),
    });
    expect(
      mutationCalls.some(
        (call) => call.fn === apiMock.albatrossWorkV2.setAgentState && call.args.agentState === 'idle',
      ),
    ).toBe(true);
    expect(toolInvocations.some((call) => call.tool === 'albatross_apply_intent_plan')).toBe(false);
  });

  test('explicit replanning acknowledges only the evidence watermark it started with', async () => {
    workDetailFixture = {
      work: {
        _id: 'work_evidence_race',
        title: 'Renew passport',
        rawText: 'Renew my passport',
        lastEvidenceAt: 100,
      },
      plan: { _id: 'plan_old', outcome: 'Passport renewed', digitalActions: [] },
      questions: [],
      evidence: [],
    };
    evidenceAtDuringPlanFixture = 200;

    await runTool(albatross.albatrossReplanWork.handler, {
      workId: 'work_evidence_race',
      reason: 'A receipt was attached.',
    });

    expect(workDetailFixture.work.lastEvidenceAt).toBe(200);
    expect(mutationCalls).toContainEqual({
      fn: apiMock.albatrossWorkV2.completeEvidenceReconcile,
      args: { userId: 'test_user_tools', workId: 'work_evidence_race', evidenceAt: 100 },
    });
  });

  test('replan rejects a generated revision that cannot be loaded', async () => {
    workDetailFixture = {
      work: { _id: 'work_missing_revision', title: 'Renew passport', rawText: 'Renew my passport' },
      plan: { _id: 'plan_old', digitalActions: [] },
      questions: [],
      evidence: [],
    };
    generatedPlanIdFixture = 'plan_missing';

    await expect(
      runTool(albatross.albatrossReplanWork.handler, {
        workId: 'work_missing_revision',
        reason: 'Refresh the plan.',
      }),
    ).rejects.toThrow(/could not be loaded/);
  });

  test('tools require an authenticated user', async () => {
    await expect(
      runTool(albatross.albatrossListProjects.handler, { limit: 1 }, { userId: undefined }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test('default execution account skips stale grants and prefers a primary writable calendar', () => {
    expect(
      albatross.selectDefaultExecutionAccount(
        [
          { accountId: 'stale', status: 'connected' },
          { accountId: 'healthy', status: 'connected' },
        ],
        [
          { accountId: 'stale', isPrimary: true, readOnly: false },
          { accountId: 'healthy', isPrimary: true, readOnly: false },
        ],
        [
          { accountId: 'stale', status: 'unauthorized' },
          { accountId: 'healthy', status: 'idle' },
        ],
      ),
    ).toBe('healthy');
    expect(
      albatross.selectDefaultExecutionAccount(
        [{ accountId: 'healthy', status: 'connected' }],
        [{ accountId: 'healthy', readOnly: false }],
        [],
      ),
    ).toBe('healthy');
    expect(
      albatross.selectDefaultExecutionAccount([{ accountId: 'mail-only', status: 'connected' }], [], []),
    ).toBe('mail-only');
    expect(
      albatross.selectDefaultExecutionAccount(
        [{ accountId: 'stale', status: 'connected' }],
        [],
        [{ accountId: 'stale', status: 'unauthorized' }],
      ),
    ).toBeUndefined();
  });
});

test('explicit completion uses the atomic transition and never generates a plan', async () => {
  const result = await runTool((args, ctx) => invokeTool(albatross.albatrossCompleteWork, args, ctx), {
    workId: 'monro',
    claim: 'The tire is repaired.',
  });
  expect(result).toMatchObject({ ok: true, state: 'done', workId: 'monro' });
  expect(mutationCalls).toHaveLength(1);
  expect(mutationCalls[0].fn).toBe(apiMock.albatrossWorkV2.completeWork);
  expect(toolInvocations).toHaveLength(0);
});

test('a completed outcome makes a replan a harmless no-op before writing agent state', async () => {
  workDetailFixture = { work: { _id: 'monro', title: 'Monro', workState: 'done', status: 'done' } };
  const result = await runTool((args, ctx) => invokeTool(albatross.albatrossReplanWork, args, ctx), {
    workId: 'monro',
    reason: 'The outcome is done',
  });
  expect(result).toMatchObject({ ok: true, changed: false, actionsApplied: 0 });
  expect(mutationCalls).toHaveLength(0);
});

test('a failed optional attachment returns saved progress and an attachment warning', async () => {
  workDetailFixture = { work: { _id: 'monro', workState: 'active', status: 'ready' } };
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexQuery: convexQueryMock as any,
    convexMutation: (async (fn: any, args: any) => {
      if (args.sourceKind === 'mail_thread') throw new Error('Missing provider thread');
      return convexMutationMock(fn, args);
    }) as any,
  });
  const result: any = await runTool((args, ctx) => invokeTool(albatross.albatrossRecordProgress, args, ctx), {
    workId: 'monro',
    claim: 'Appointment booked',
    evidence: [{ sourceKind: 'mail_thread', sourceId: 'mail:account:thread', title: 'Booking' }],
  });
  expect(result).toMatchObject({ ok: true, evidenceRecorded: 1, state: 'active' });
  expect(result.warnings[0]).toContain('Booking');
  expect(workDetailFixture.evidence).toHaveLength(1);
});

test('a reply watch is saved through chat and waiting Work cannot be replanned', async () => {
  workDetailFixture = { work: { _id: 'llc', workState: 'active' } };
  const waitingForReply = {
    accountId: 'personal',
    threadId: 'jolie-thread',
    requirement: 'Advice about the LLC',
  };
  const result: any = await runTool((args, ctx) => invokeTool(albatross.albatrossRecordProgress, args, ctx), {
    workId: 'llc',
    claim: 'I sent Jolie an email; waiting on her reply.',
    waitingForReply,
  });
  expect(result).toMatchObject({ ok: true, state: 'waiting', evidenceRecorded: 1 });
  expect(result.summary).toContain('Waiting for the reply');
  expect(mutationCalls[0]).toMatchObject({
    fn: apiMock.albatrossReplies.recordProgress,
    args: { waitingForReply },
  });
  const mutationCount = mutationCalls.length;
  const replan = await runTool(albatross.albatrossReplanWork.handler, { workId: 'llc', reason: 'Waiting' });
  expect(replan.changed).toBe(false);
  expect(mutationCalls).toHaveLength(mutationCount);
});

test('a missing mail account cannot prevent saving the authoritative progress report', async () => {
  workDetailFixture = { work: { _id: 'llc', workState: 'active' } };
  const result: any = await runTool((args, ctx) => invokeTool(albatross.albatrossRecordProgress, args, ctx), {
    workId: 'llc',
    claim: 'Email sent',
    evidence: [{ sourceKind: 'mail_thread', sourceId: 'thread-with-no-account', title: 'Sent email' }],
  });
  expect(result).toMatchObject({ ok: true, evidenceRecorded: 1 });
  expect(result.warnings[0]).toContain('progress report is saved');
  expect(mutationCalls).toHaveLength(1);
});

test('a failed question or post-save refresh returns saved progress without a misleading tool failure', async () => {
  workDetailFixture = { work: { _id: 'llc', workState: 'active' } };
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexMutation: (async (fn: any, args: any) => {
      if (fn === apiMock.albatrossWorkV2.answerQuestion) throw new Error('Stale question');
      return convexMutationMock(fn, args);
    }) as any,
    convexQuery: (async () => {
      throw new Error('Refresh unavailable');
    }) as any,
  });
  const result: any = await runTool((args, ctx) => invokeTool(albatross.albatrossRecordProgress, args, ctx), {
    workId: 'llc',
    claim: 'Email sent',
    questionAnswers: [{ questionId: 'stale', answer: 'Yes' }],
  });
  expect(result).toMatchObject({ ok: true, state: 'active', questionsAnswered: 0 });
  expect(result.warnings).toHaveLength(2);
  expect(workDetailFixture.evidence).toHaveLength(1);
});

test('a failed authoritative write remains a failure and never claims to have saved a watch', async () => {
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexMutation: (async () => {
      throw new Error('Storage unavailable');
    }) as any,
  });
  await expect(
    runTool((args, ctx) => invokeTool(albatross.albatrossRecordProgress, args, ctx), {
      workId: 'llc',
      claim: 'Email sent',
    }),
  ).rejects.toThrow('Storage unavailable');
});
