import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
};

const SECRET = 'albatross-work-runtime-secret';
const caller = { internalSecret: SECRET, userId: 'work_runtime_user' };
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

describe('albatrossWork auth resolution', () => {
  test('internal secret path requires a userId and rejects bad secrets', async () => {
    const t = newHarness();
    await expect(
      t.mutation(api.albatrossWork.createProject, { internalSecret: 'wrong', userId: 'u', title: 'X' }),
    ).rejects.toThrow(/Invalid Convex internal secret/);
    await expect(
      t.mutation(api.albatrossWork.createProject, { internalSecret: SECRET, title: 'X' }),
    ).rejects.toThrow(/userId required/);
    await expect(t.query(api.albatrossWork.listProjects, {})).rejects.toThrow(/Not authenticated/);
  });

  test('identity path resolves the Clerk subject', async () => {
    const t = newHarness();
    const asUser = t.withIdentity({ subject: 'identity_user' });
    const projectId = await asUser.mutation(api.albatrossWork.createProject, { title: 'Mine' });
    const rows = await asUser.query(api.albatrossWork.listProjects, {});
    expect(rows.map((row) => row._id)).toEqual([projectId]);
    // A different caller cannot see or touch it.
    const stranger = t.withIdentity({ subject: 'other_user' });
    expect(await stranger.query(api.albatrossWork.listProjects, {})).toEqual([]);
    await expect(
      stranger.mutation(api.albatrossWork.updateProject, { projectId, title: 'Stolen' }),
    ).rejects.toThrow(/Project not found/);
  });
});

describe('project lifecycle', () => {
  test('createProject upserts by externalId instead of duplicating', async () => {
    const t = newHarness();
    const first = await t.mutation(api.albatrossWork.createProject, {
      ...caller,
      externalId: 'proj-ext-1',
      title: 'Original title',
      outcome: 'Ship it',
      areaId: 'area_1',
    });
    const second = await t.mutation(api.albatrossWork.createProject, {
      ...caller,
      externalId: 'proj-ext-1',
      title: 'Updated title',
    });
    expect(second).toBe(first);
    const rows = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Updated title');
  });

  test('blank titles fall back instead of storing empty strings', async () => {
    const t = newHarness();
    await t.mutation(api.albatrossWork.createProject, { ...caller, title: '   ' });
    const rows = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(rows[0].title).toBe('Untitled project');
  });

  test('updateProject transition into done records exactly one completion event', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, {
      ...caller,
      title: 'Finishable',
      areaId: 'area_done',
      sourceIntentId: 'intent_done',
    });
    await t.mutation(api.albatrossWork.updateProject, { ...caller, projectId, status: 'done' });
    // Re-marking done is not a transition and must not double-log.
    await t.mutation(api.albatrossWork.updateProject, { ...caller, projectId, status: 'done' });
    const events = await t.run((ctx) => ctx.db.query('completionEvents').collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      artifactKind: 'project',
      artifactId: String(projectId),
      areaId: 'area_done',
      intentId: 'intent_done',
    });
    const [project] = await t.query(api.albatrossWork.listProjects, { ...caller, status: 'done' });
    expect(project.completedAt).toBeGreaterThan(0);
  });

  test('updateProject rejects an active sprint from another project', async () => {
    const t = newHarness();
    const projectA = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'A' });
    const projectB = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'B' });
    const sprintId = await t.mutation(api.albatrossWork.createSprint, {
      ...caller,
      projectId: projectB,
      title: 'B sprint',
    });
    await expect(
      t.mutation(api.albatrossWork.updateProject, {
        ...caller,
        projectId: projectA,
        activeSprintId: sprintId,
      }),
    ).rejects.toThrow(/must belong to this project/);
    await t.mutation(api.albatrossWork.updateProject, {
      ...caller,
      projectId: projectB,
      activeSprintId: sprintId,
      outcome: 'refined',
    });
    const projects = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(projects.find((p) => p._id === projectB)?.activeSprintId).toBe(sprintId);
  });

  test('listProjects filters by area and respects the limit clamp', async () => {
    const t = newHarness();
    await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'P1', areaId: 'area_x' });
    await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'P2', areaId: 'area_y' });
    await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'P3', areaId: 'area_x' });
    const byArea = await t.query(api.albatrossWork.listProjects, { ...caller, areaId: 'area_x' });
    expect(byArea.map((p) => p.title).sort()).toEqual(['P1', 'P3']);
    const limited = await t.query(api.albatrossWork.listProjects, { ...caller, limit: 0 });
    expect(limited).toHaveLength(1);
  });
});

describe('artifact links', () => {
  test('linkArtifact dedupes per project and validates artifactId', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Linky' });
    await expect(
      t.mutation(api.albatrossWork.linkArtifact, {
        ...caller,
        projectId,
        artifactKind: 'task',
        artifactId: '   ',
      }),
    ).rejects.toThrow(/artifactId required/);
    const first = await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'mailThread',
      artifactId: 'thread_1',
      role: 'primary',
      title: 'A thread',
    });
    const second = await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'mailThread',
      artifactId: 'thread_1',
      title: 'Renamed thread',
    });
    expect(second).toBe(first);
    const links = await t.run((ctx) => ctx.db.query('albatrossProjectLinks').collect());
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe('Renamed thread');
    // Same artifact may link to a different project, though.
    const other = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Other' });
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId: other,
      artifactKind: 'mailThread',
      artifactId: 'thread_1',
    });
    expect(await t.run((ctx) => ctx.db.query('albatrossProjectLinks').collect())).toHaveLength(2);
  });
});

describe('sprint lifecycle', () => {
  test('creating an active sprint promotes it to the project activeSprintId', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Sprinty' });
    const sprintId = await t.mutation(api.albatrossWork.createSprint, {
      ...caller,
      projectId,
      externalId: 'sprint-ext',
      title: 'Week 1',
      status: 'active',
      startAt: 100,
      endAt: 200,
    });
    let projects = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(projects[0].activeSprintId).toBe(sprintId);

    // Upsert by externalId to closed detaches it from the project.
    const same = await t.mutation(api.albatrossWork.createSprint, {
      ...caller,
      projectId,
      externalId: 'sprint-ext',
      title: 'Week 1 closed',
      status: 'closed',
    });
    expect(same).toBe(sprintId);
    projects = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(projects[0].activeSprintId).toBeUndefined();
    const sprints = await t.query(api.albatrossWork.listSprints, { ...caller, projectId });
    expect(sprints).toHaveLength(1);
    expect(sprints[0].title).toBe('Week 1 closed');
    expect(sprints[0].closedAt).toBeGreaterThan(0);
  });

  test('updateSprint activation and closure keep the project pointer honest', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Pointer' });
    const sprintId = await t.mutation(api.albatrossWork.createSprint, {
      ...caller,
      projectId,
      title: 'Planned sprint',
    });
    await t.mutation(api.albatrossWork.updateSprint, { ...caller, sprintId, status: 'active', goal: 'Go' });
    let projects = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(projects[0].activeSprintId).toBe(sprintId);
    await t.mutation(api.albatrossWork.updateSprint, { ...caller, sprintId, status: 'archived' });
    projects = await t.query(api.albatrossWork.listProjects, { ...caller });
    expect(projects[0].activeSprintId).toBeUndefined();
    const sprints = await t.query(api.albatrossWork.listSprints, { ...caller, status: 'archived' });
    expect(sprints.map((s) => s._id)).toEqual([sprintId]);
  });
});

describe('approval queue', () => {
  async function seedApproval(t: ReturnType<typeof newHarness>, overrides: Record<string, unknown> = {}) {
    return t.mutation(api.albatrossWork.enqueueApproval, {
      ...caller,
      kind: 'email_send',
      title: 'Send the update email',
      detail: 'To the team',
      toolName: 'save_draft',
      toolArgs: { draftId: 'd1' },
      ...overrides,
    });
  }

  test('claim then approve, and undo only inside the window', async () => {
    const t = newHarness();
    const approvalId = await seedApproval(t);
    const claimed = await t.mutation(api.albatrossWork.claimApproval, { ...caller, approvalId });
    expect(claimed.approval.status).toBe('claiming');
    await expect(t.mutation(api.albatrossWork.claimApproval, { ...caller, approvalId })).rejects.toThrow(
      /already claiming/,
    );
    const decided = await t.mutation(api.albatrossWork.decideApproval, {
      ...caller,
      approvalId,
      status: 'approved',
      undoExpiresAt: Date.now() + 60_000,
      result: { ok: true },
    });
    expect(decided.approval.status).toBe('approved');
    // The undo window is clamped server-side to at most 10s out.
    expect(decided.approval.undoExpiresAt).toBeLessThanOrEqual(Date.now() + 10_000);
    const undone = await t.mutation(api.albatrossWork.decideApproval, {
      ...caller,
      approvalId,
      status: 'undone',
    });
    expect(undone.approval.status).toBe('undone');
  });

  test('terminal approvals reject re-decision and undo requires the window', async () => {
    const t = newHarness();
    const approvalId = await seedApproval(t);
    await t.mutation(api.albatrossWork.decideApproval, { ...caller, approvalId, status: 'rejected' });
    await expect(
      t.mutation(api.albatrossWork.decideApproval, { ...caller, approvalId, status: 'approved' }),
    ).rejects.toThrow(/already rejected/);
    await expect(
      t.mutation(api.albatrossWork.decideApproval, { ...caller, approvalId, status: 'undone' }),
    ).rejects.toThrow(/Only approved actions/);

    const noWindow = await seedApproval(t, { title: 'No undo window' });
    await t.mutation(api.albatrossWork.decideApproval, {
      ...caller,
      approvalId: noWindow,
      status: 'approved',
    });
    await expect(
      t.mutation(api.albatrossWork.decideApproval, { ...caller, approvalId: noWindow, status: 'undone' }),
    ).rejects.toThrow(/Undo window expired/);
  });

  test('listApprovals defaults to the live queue and filters by status/intent', async () => {
    const t = newHarness();
    const pending = await seedApproval(t, { intentId: 'intent_a' });
    const claiming = await seedApproval(t, { title: 'Second' });
    await t.mutation(api.albatrossWork.claimApproval, { ...caller, approvalId: claiming });
    const rejected = await seedApproval(t, { title: 'Third' });
    await t.mutation(api.albatrossWork.decideApproval, {
      ...caller,
      approvalId: rejected,
      status: 'rejected',
    });

    const queue = await t.query(api.albatrossWork.listApprovals, { ...caller });
    expect(queue.map((a) => a._id).sort()).toEqual([pending, claiming].sort());

    const rejectedRows = await t.query(api.albatrossWork.listApprovals, { ...caller, status: 'rejected' });
    expect(rejectedRows.map((a) => a._id)).toEqual([rejected]);

    const byIntent = await t.query(api.albatrossWork.listApprovals, { ...caller, intentId: 'intent_a' });
    expect(byIntent.map((a) => a._id)).toEqual([pending]);

    expect(await t.query(api.albatrossWork.getApproval, { ...caller, approvalId: pending })).toMatchObject({
      _id: pending,
      status: 'pending',
    });
    expect(
      await t.query(api.albatrossWork.getApproval, {
        internalSecret: SECRET,
        userId: 'someone_else',
        approvalId: pending,
      }),
    ).toBeNull();
  });
});

describe('plan applications', () => {
  test('recordPlanApplication validates ids and listPlanApplications filters by intent', async () => {
    const t = newHarness();
    await expect(
      t.mutation(api.albatrossWork.recordPlanApplication, {
        ...caller,
        intentId: '  ',
        operationBatchId: 'batch_1',
        status: 'applied',
        artifacts: [],
        operationIds: [],
        pendingApprovalIds: [],
        unresolvedArtifacts: [],
      }),
    ).rejects.toThrow(/intentId required/);
    await expect(
      t.mutation(api.albatrossWork.recordPlanApplication, {
        ...caller,
        intentId: 'intent_1',
        operationBatchId: '  ',
        status: 'applied',
        artifacts: [],
        operationIds: [],
        pendingApprovalIds: [],
        unresolvedArtifacts: [],
      }),
    ).rejects.toThrow(/operationBatchId required/);

    await t.mutation(api.albatrossWork.recordPlanApplication, {
      ...caller,
      intentId: 'intent_1',
      operationBatchId: 'batch_1',
      status: 'applied',
      artifacts: [{ kind: 'task', id: 'card_1' }],
      operationIds: ['op_1'],
      pendingApprovalIds: [],
      unresolvedArtifacts: [],
    });
    await t.mutation(api.albatrossWork.recordPlanApplication, {
      ...caller,
      intentId: 'intent_2',
      operationBatchId: 'batch_2',
      status: 'queued',
      artifacts: [],
      operationIds: [],
      pendingApprovalIds: ['appr_1'],
      unresolvedArtifacts: [{ kind: 'mailThread' }],
    });
    const all = await t.query(api.albatrossWork.listPlanApplications, { ...caller });
    expect(all).toHaveLength(2);
    const one = await t.query(api.albatrossWork.listPlanApplications, { ...caller, intentId: 'intent_2' });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ status: 'queued', pendingApprovalIds: ['appr_1'] });
  });
});

describe('reporting and progress queries', () => {
  type Harness = ReturnType<typeof newHarness>;

  async function seedCard(
    t: Harness,
    input: { title: string; completedAt?: number; dueAt?: number; userId?: string },
  ) {
    return t.run(async (ctx) => {
      const ts = Date.now();
      const owner = input.userId ?? caller.userId;
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: owner,
        title: `Board for ${input.title}`,
        createdAt: ts,
        updatedAt: ts,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Doing',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      const cardId = await ctx.db.insert('cards', {
        boardId,
        columnId,
        userId: owner,
        title: input.title,
        order: 0,
        completedAt: input.completedAt,
        dueAt: input.dueAt,
        createdAt: ts,
        updatedAt: ts,
      });
      return { cardId, boardId };
    });
  }

  test('listProjectsWithProgress counts linked tasks/intents/events and completed cards', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Progress' });
    const done = await seedCard(t, { title: 'Done card', completedAt: Date.now() });
    const open = await seedCard(t, { title: 'Open card' });
    const foreign = await seedCard(t, { title: 'Foreign card', completedAt: Date.now(), userId: 'other' });
    for (const cardId of [done.cardId, open.cardId, foreign.cardId]) {
      await t.mutation(api.albatrossWork.linkArtifact, {
        ...caller,
        projectId,
        artifactKind: 'task',
        artifactId: String(cardId),
      });
    }
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'task',
      artifactId: 'not-a-card-id',
    });
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'intent',
      artifactId: 'intent_1',
    });
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'calendarEvent',
      artifactId: 'event_1',
    });
    const [row] = await t.query(api.albatrossWork.listProjectsWithProgress, { ...caller });
    expect(row).toMatchObject({
      title: 'Progress',
      taskCount: 4,
      completedTaskCount: 1,
      intentCount: 1,
      eventCount: 1,
    });
  });

  test('projectTasks resolves live cards with column names and drops dead links', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Tasks' });
    const live = await seedCard(t, { title: 'Live card', dueAt: 123 });
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'task',
      artifactId: String(live.cardId),
    });
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'task',
      artifactId: 'ghost-card',
    });
    const tasks = await t.query(api.albatrossWork.projectTasks, { ...caller, projectId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      cardId: live.cardId,
      boardId: live.boardId,
      title: 'Live card',
      dueAt: 123,
      columnName: 'Doing',
    });
  });

  test('projectProgressSummary splits periods and only rates events with due dates', async () => {
    const t = newHarness();
    const ts = Date.now();
    const day = 86_400_000;
    await t.run(async (ctx) => {
      const base = { userId: caller.userId, artifactKind: 'task' as const, createdAt: ts };
      // This period: one on time, one late, one with no due date.
      await ctx.db.insert('completionEvents', {
        ...base,
        artifactId: 'on_time',
        completedAt: ts - day,
        dueAt: ts,
      });
      await ctx.db.insert('completionEvents', {
        ...base,
        artifactId: 'late',
        completedAt: ts - day,
        dueAt: ts - 2 * day,
      });
      await ctx.db.insert('completionEvents', { ...base, artifactId: 'no_due', completedAt: ts - 2 * day });
      // Prior period.
      await ctx.db.insert('completionEvents', { ...base, artifactId: 'prior', completedAt: ts - 10 * day });
    });
    const summary = await t.query(api.albatrossWork.projectProgressSummary, { ...caller, sinceDays: 7 });
    expect(summary).toEqual({ completedThisPeriod: 3, completedPriorPeriod: 1, onTimeRate: 0.5 });

    // A window with no due-dated completions reports no rate at all.
    const t2 = newHarness();
    await t2.run(async (ctx) => {
      await ctx.db.insert('completionEvents', {
        userId: caller.userId,
        artifactKind: 'intent',
        artifactId: 'only',
        completedAt: Date.now(),
        createdAt: Date.now(),
      });
    });
    const bare = await t2.query(api.albatrossWork.projectProgressSummary, { ...caller });
    expect(bare.completedThisPeriod).toBe(1);
    expect(bare.onTimeRate).toBeUndefined();
  });

  test('getProjectPane aggregates links, sprints, approvals, and applications', async () => {
    const t = newHarness();
    const projectId = await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Pane' });
    const card = await seedCard(t, { title: 'Pane card' });
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'task',
      artifactId: String(card.cardId),
    });
    // Dead task link without a title is filtered from tasks entirely.
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'task',
      artifactId: 'ghost',
    });
    // Dead task link WITH a title survives as a card-less task entry.
    await t.mutation(api.albatrossWork.linkArtifact, {
      ...caller,
      projectId,
      artifactKind: 'task',
      artifactId: 'ghost-titled',
      title: 'Ghost with title',
    });
    await t.mutation(api.albatrossWork.createSprint, { ...caller, projectId, title: 'Pane sprint' });
    await t.mutation(api.albatrossWork.enqueueApproval, {
      ...caller,
      kind: 'external_action',
      title: 'Pane approval',
      projectId,
      toolName: 'noop',
      toolArgs: {},
    });
    await t.mutation(api.albatrossWork.recordPlanApplication, {
      ...caller,
      intentId: 'pane_intent',
      projectId,
      operationBatchId: 'pane_batch',
      status: 'applied',
      artifacts: [],
      operationIds: [],
      pendingApprovalIds: [],
      unresolvedArtifacts: [],
    });
    const pane = await t.query(api.albatrossWork.getProjectPane, { ...caller, projectId });
    expect(pane.project.title).toBe('Pane');
    expect(pane.links).toHaveLength(3);
    expect(pane.tasks).toHaveLength(2);
    expect(pane.tasks.some((item) => item.card === null && item.link.title === 'Ghost with title')).toBe(
      true,
    );
    expect(pane.sprints.map((s) => s.title)).toEqual(['Pane sprint']);
    expect(pane.approvals.map((a) => a.title)).toEqual(['Pane approval']);
    expect(pane.applications.map((a) => a.operationBatchId)).toEqual(['pane_batch']);
  });

  test('dailyReportContext returns recent work plus active areas only', async () => {
    const t = newHarness();
    await t.mutation(api.albatrossWork.createProject, { ...caller, title: 'Context project' });
    await t.mutation(api.albatrossWork.createSprint, { ...caller, title: 'Context sprint' });
    await t.mutation(api.albatrossWork.enqueueApproval, {
      ...caller,
      kind: 'provider_write',
      title: 'Context approval',
      toolName: 'noop',
      toolArgs: {},
    });
    await t.mutation(api.albatrossWork.recordPlanApplication, {
      ...caller,
      intentId: 'ctx_intent',
      operationBatchId: 'ctx_batch',
      status: 'partially_applied',
      artifacts: [],
      operationIds: [],
      pendingApprovalIds: [],
      unresolvedArtifacts: [],
    });
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('areas', {
        userId: caller.userId,
        name: 'Active area',
        kind: 'life',
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.insert('areas', {
        userId: caller.userId,
        name: 'Archived area',
        kind: 'life',
        status: 'archived',
        createdAt: ts,
        updatedAt: ts,
      });
    });
    const context = await t.query(api.albatrossWork.dailyReportContext, { ...caller, limit: 10 });
    expect(context.projects.map((p) => p.title)).toEqual(['Context project']);
    expect(context.sprints.map((s) => s.title)).toEqual(['Context sprint']);
    expect(context.approvals.map((a) => a.title)).toEqual(['Context approval']);
    expect(context.applications.map((a) => a.intentId)).toEqual(['ctx_intent']);
    expect(context.areas.map((a) => a.name)).toEqual(['Active area']);
  });
});
