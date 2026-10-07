import { describe, expect, mock, test } from 'bun:test';

// The question answer route reads its collaborators from modules, so this
// file mocks them in a child process and keeps the mocks out of other files.
if (process.env.STEP_RUN_ANSWER_ROUTE_TEST !== '1') {
  test('the answer route runs with isolated module fixtures', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, STEP_RUN_ANSWER_ROUTE_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 30_000);
} else {
  let answered: Record<string, unknown> = {};
  let waitingRunId: string | null = null;
  const resumeRunForAnswer = mock(async (_input: unknown) => waitingRunId);
  const advanceWork = mock(async (_input: unknown) => ({ advanced: true }));
  const answerQuestion = mock(async (_args: unknown) => answered);

  const auth = await import('../lib/auth/current-user');
  mock.module('../lib/auth/current-user', () => ({
    ...auth,
    requireCurrentUser: async () => ({ userId: 'user-1', email: 'u@example.com', name: 'U' }),
  }));
  const rateLimit = await import('../lib/rate-limit');
  mock.module('../lib/rate-limit', () => ({
    ...rateLimit,
    enforceUserRateLimit: async () => ({ ok: true }),
  }));
  const convex = await import('../lib/hosted/convex');
  mock.module('../lib/hosted/convex', () => ({
    ...convex,
    convexMutation: async (_fn: unknown, args: unknown) => answerQuestion(args),
  }));
  mock.module('../lib/albatross/step-run-start', () => ({ resumeRunForAnswer }));
  mock.module('../lib/albatross/work-orchestrator', () => ({ advanceWork }));

  const { NextRequest } = await import('next/server');
  const { POST } = await import('../app/api/albatross/work/questions/[questionId]/answer/route');
  const context = { params: Promise.resolve({ questionId: 'question-1' }) };
  const answer = (body: unknown) =>
    POST(
      new NextRequest('http://localhost/api/albatross/work/questions/question-1/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      context,
    );

  describe('POST /api/albatross/work/questions/[questionId]/answer', () => {
    test('an answer to a waiting run resumes the run and does not move the plan', async () => {
      answered = { workId: 'work-1', shouldAdvance: true };
      waitingRunId = 'run-2';
      const response = await answer({ answer: ' Monday ', answeredOptionId: 'mon' });
      expect(await response.json()).toEqual({
        ok: true,
        status: 'answered',
        workId: 'work-1',
        shouldAdvance: true,
        runId: 'run-2',
      });
      expect(answerQuestion.mock.calls.at(-1)?.[0]).toMatchObject({
        userId: 'user-1',
        questionId: 'question-1',
        answer: 'Monday',
        answeredOptionId: 'mon',
      });
      expect(resumeRunForAnswer).toHaveBeenCalledWith({
        userId: 'user-1',
        workId: 'work-1',
        questionId: 'question-1',
        answer: 'Monday',
      });
      expect(advanceWork).not.toHaveBeenCalled();
    });

    test('without a waiting run the plan moves as before', async () => {
      answered = { workId: 'work-1', shouldAdvance: true };
      waitingRunId = null;
      const response = await answer({ answer: 'Tuesday', timezone: 'America/New_York' });
      expect(await response.json()).toEqual({
        ok: true,
        workId: 'work-1',
        shouldAdvance: true,
        advanced: true,
      });
      expect(advanceWork).toHaveBeenCalledTimes(1);
      expect(advanceWork.mock.calls[0][0]).toMatchObject({ workId: 'work-1', timezone: 'America/New_York' });
    });

    test('an empty answer is 400', async () => {
      const response = await answer({ answer: '   ' });
      expect(response.status).toBe(400);
    });
  });
}
