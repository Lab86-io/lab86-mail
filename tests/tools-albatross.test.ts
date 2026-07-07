import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as albatross from '../lib/tools/albatross';
import { runTool } from './tools/harness';

const apiMock = {
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
  albatross: {
    getArea: 'albatross.getArea',
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
let approvalFixture: any = null;
let connectedAccountsFixture: any[] = [];
let areaFixture: any = null;
let sequence = 0;

async function convexMutationMock(fn: string, args: any) {
  mutationCalls.push({ fn, args });
  sequence += 1;
  if (fn === apiMock.albatrossWork.createProject) return `project_${sequence}`;
  if (fn === apiMock.albatrossWork.createSprint) return `sprint_${sequence}`;
  if (fn === apiMock.albatrossWork.enqueueApproval) return `approval_${sequence}`;
  if (fn === apiMock.albatrossWork.recordPlanApplication) return `application_${sequence}`;
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
  if (fn === apiMock.accounts.listConnectedAccounts) return connectedAccountsFixture;
  if (fn === apiMock.albatross.getArea) return areaFixture;
  if (fn === apiMock.albatrossWork.listApprovals)
    return [{ approvalId: 'approval_pending', status: args.status }];
  if (fn === apiMock.albatrossWork.getApproval) return approvalFixture;
  if (fn === apiMock.albatrossWork.listProjects) return [{ projectId: 'project_live', status: args.status }];
  if (fn === apiMock.albatrossWork.getProjectPane) return { project: { projectId: args.projectId } };
  if (fn === apiMock.albatrossWork.listSprints) return [{ sprintId: 'sprint_live', status: args.status }];
  return null;
}

async function recordOperationMock(input: any) {
  operationCalls.push(input);
  return `operation_${operationCalls.length}`;
}

async function invokeToolMock(tool: any, args: any) {
  sequence += 1;
  approvalOrder.push(`tool:${tool.name}`);
  toolInvocations.push({ tool: tool.name, args });
  if (tool.name === 'tasks_create_card') {
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
  approvalFixture = null;
  connectedAccountsFixture = [];
  areaFixture = null;
  sequence = 0;
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexMutation: convexMutationMock as any,
    convexQuery: convexQueryMock as any,
    recordOperation: recordOperationMock as any,
    newOperationBatchId: () => 'batch_mocked',
    undoOperation: undoOperationMock as any,
    invokeTool: invokeToolMock as any,
  });
});

afterAll(() => {
  albatross.__setAlbatrossToolDepsForTest();
});

describe('Albatross tools', () => {
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
    const pane = await runTool(albatross.albatrossGetProjectPane.handler, { projectId: project.projectId });
    const sprints = await runTool(albatross.albatrossListSprints.handler, {
      projectId: project.projectId,
      status: 'active',
    });

    expect(project.operationId).toBe('operation_1');
    expect(sprint.operationId).toBe('operation_2');
    expect(projects.projects[0].projectId).toBe('project_live');
    expect(pane.pane.project.projectId).toBe(project.projectId);
    expect(sprints.sprints[0].sprintId).toBe('sprint_live');
    expect(operationCalls.map((call) => call.inverse?.kind)).toEqual([
      'albatross.archive_project',
      'albatross.archive_sprint',
    ]);
    await runTool(albatross.albatrossCreateSprint.handler, {
      title: 'Fallback batch sprint',
      status: 'planned',
    });
    expect(operationCalls.at(-1)?.batchId).toBe('batch_mocked');
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

    await expect(
      runTool(albatross.albatrossUndoApproval.handler, { approvalId: 'approval_pending' }),
    ).rejects.toThrow(/did not record an undoable/);

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
    const undone = await runTool(albatross.albatrossUndoApproval.handler, { approvalId: 'approval_rsvp' });
    expect(undone.ok).toBe(true);
    expect(undoCalls).toEqual([{ userId: 'test_user_tools', operationId: approvedRsvp.result.operationId }]);
    expect(mutationCalls.at(-1)?.args.status).toBe('undone');

    approvalFixture = {
      approvalId: 'approval_old',
      status: 'approved',
      toolName: 'send_message',
      undoExpiresAt: Date.now() - 1,
    };
    await expect(
      runTool(albatross.albatrossUndoApproval.handler, { approvalId: 'approval_old' }),
    ).rejects.toThrow(/Undo window expired/);
  });

  test('preview undo unresolved returns artifacts whose operations were undone', async () => {
    const result = await runTool(albatross.albatrossPreviewUndoUnresolved.handler, {
      application: {
        artifacts: [
          { kind: 'project', id: 'project_1', title: 'Project' },
          { kind: 'task', id: 'task_1', title: 'Task' },
        ],
      },
      operations: [
        { status: 'undone', target: { kind: 'project', id: 'project_1' } },
        { status: 'applied', target: { kind: 'task', id: 'task_1' } },
      ],
    });

    expect(result.unresolved).toEqual([{ kind: 'project', id: 'project_1', title: 'Project' }]);
  });

  test('tools require an authenticated user', async () => {
    await expect(
      runTool(albatross.albatrossListProjects.handler, { limit: 1 }, { userId: undefined }),
    ).rejects.toThrow(/Not authenticated/);
  });
});
