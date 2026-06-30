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
  operations: {
    record: 'operations.record',
  },
};

const mutationCalls: Array<{ fn: string; args: any }> = [];
const operationCalls: any[] = [];
let approvalFixture: any = null;
let sequence = 0;

async function convexMutationMock(fn: string, args: any) {
  mutationCalls.push({ fn, args });
  sequence += 1;
  if (fn === apiMock.albatrossWork.createProject) return `project_${sequence}`;
  if (fn === apiMock.albatrossWork.createSprint) return `sprint_${sequence}`;
  if (fn === apiMock.albatrossWork.enqueueApproval) return `approval_${sequence}`;
  if (fn === apiMock.albatrossWork.recordPlanApplication) return `application_${sequence}`;
  if (fn === apiMock.albatrossWork.decideApproval) {
    return {
      ok: true,
      approval: { ...approvalFixture, status: args.status, decisionNote: args.decisionNote },
    };
  }
  return { ok: true };
}

async function convexQueryMock(fn: string, args: any) {
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
  if (tool.name === 'tasks_create_card') {
    return { ok: true, cardId: `card_${sequence}`, operationId: `operation_card_${sequence}` };
  }
  if (tool.name === 'save_draft') {
    return {
      ok: true,
      draft: { _id: `draft_${sequence}`, account: args.account || 'jakob@example.test' },
      operationId: `operation_draft_${sequence}`,
    };
  }
  if (tool.name === 'send_message') return { ok: true, messageId: `message_${sequence}` };
  if (tool.name === 'calendar_rsvp_event') return { ok: true, eventId: args.eventId, status: args.status };
  return { ok: true };
}

beforeEach(() => {
  mutationCalls.length = 0;
  operationCalls.length = 0;
  approvalFixture = null;
  sequence = 0;
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexMutation: convexMutationMock as any,
    convexQuery: convexQueryMock as any,
    recordOperation: recordOperationMock as any,
    newOperationBatchId: () => 'batch_mocked',
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
  });

  test('approval queue tools list, reject, undo, and protect expired or unsupported approvals', async () => {
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

    const rejected = await runTool(albatross.albatrossRejectAction.handler, {
      approvalId: 'approval_pending',
      reason: 'User rejected.',
    });
    expect(rejected.ok).toBe(true);
    expect(mutationCalls.at(-1)?.args).toMatchObject({ status: 'rejected', decisionNote: 'User rejected.' });

    const undone = await runTool(albatross.albatrossUndoApproval.handler, { approvalId: 'approval_pending' });
    expect(undone.ok).toBe(true);
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
