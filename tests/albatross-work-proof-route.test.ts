import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkProofPost } from '../app/api/albatross/work/[workId]/proof/route';

const user = {
  userId: 'proof-user',
  email: 'proof@example.test',
  name: 'Proof User',
  source: 'clerk' as const,
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/work/work-1/proof', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies(state = 'active') {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    attachProof: mock(async () => 'evidence-1'),
    workDetail: mock(async () => ({ work: { workState: state } })),
    mailThread: mock(async () => ({ _id: 'thread-1' })),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, body: unknown) {
  return createWorkProofPost(deps as any)(request(body), {
    params: Promise.resolve({ workId: 'work-1' }),
  });
}

const manualProof = {
  claim: 'The form was submitted',
  title: 'Submission receipt',
  sourceKind: 'manual',
  sourceId: 'manual-1',
  trust: 'confirmed',
};

describe('Albatross Work proof route', () => {
  test('rejects missing details and values outside the complete source and trust unions', async () => {
    for (const body of [{}, { ...manualProof, sourceKind: 'email' }, { ...manualProof, trust: 'trusted' }]) {
      const deps = dependencies();
      const response = await invoke(deps, body);
      expect(response.status).toBe(400);
      expect(deps.attachProof).not.toHaveBeenCalled();
    }
  });

  test('accepts every declared source kind with a validated trust value', async () => {
    const sourceKinds = [
      'calendar_event',
      'task',
      'chat',
      'question_answer',
      'area_fact',
      'github_issue',
      'github_pull_request',
      'github_project',
      'github_project_item',
      'github_commit',
      'mcp_item',
      'manual',
    ];
    for (const sourceKind of sourceKinds) {
      const deps = dependencies('done');
      expect((await invoke(deps, { ...manualProof, sourceKind })).status).toBe(200);
      expect(deps.attachProof).toHaveBeenCalledTimes(1);
    }
  });

  test('derives observed trust only after the mail thread is verified for the account', async () => {
    const deps = dependencies('done');
    const response = await invoke(deps, {
      ...manualProof,
      sourceKind: 'mail_thread',
      sourceId: 'thread-1',
      accountId: '  person@example.test  ',
      trust: 'confirmed',
    });

    expect(response.status).toBe(200);
    expect(deps.mailThread).toHaveBeenCalledWith({
      userId: user.userId,
      accountId: 'person@example.test',
      providerThreadId: 'thread-1',
    });
    expect(deps.attachProof).toHaveBeenCalledWith(expect.objectContaining({ trust: 'observed' }));
    expect(deps.attachProof).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'person@example.test' }),
    );

    const missing = dependencies();
    missing.mailThread.mockImplementation(async () => null);
    expect(
      (
        await invoke(missing, {
          ...manualProof,
          sourceKind: 'mail_thread',
          accountId: 'person@example.test',
        })
      ).status,
    ).toBe(400);
    expect(missing.attachProof).not.toHaveBeenCalled();
  });

  test('closed work skips replanning', async () => {
    const deps = dependencies('done');
    const response = await invoke(deps, manualProof);

    expect(await response.json()).toEqual({
      ok: true,
      evidenceId: 'evidence-1',
      closed: true,
      replanned: false,
      replanStatus: 'not_needed',
    });
  });

  test('open work queues replanning after the evidence is durable', async () => {
    const deps = dependencies('active');
    const response = await invoke(deps, manualProof);

    expect(await response.json()).toEqual({
      ok: true,
      evidenceId: 'evidence-1',
      closed: false,
      replanned: false,
      replanStatus: 'queued',
    });
  });
});
