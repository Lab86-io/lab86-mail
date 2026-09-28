import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMailAttachmentsPost } from '../app/api/cron/mail-attachments/route';

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/cron/mail-attachments', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function deps(authorized = true) {
  const tasks: Array<() => Promise<unknown>> = [];
  return {
    tasks,
    deps: {
      isInternalCronRequest: mock(() => authorized),
      drainMailAttachmentQueue: mock(async (_userId: string): Promise<any> => ({ claimed: 1 })),
      defer: mock((task: () => Promise<unknown>) => {
        tasks.push(task);
      }),
    },
  };
}

describe('mail attachment cron route', () => {
  test('refuses a caller without the internal secret', async () => {
    const { deps: d } = deps(false);
    const res = await createMailAttachmentsPost(d)(post({ userId: 'u1' }));
    expect(res.status).toBe(401);
    expect(d.defer).not.toHaveBeenCalled();
  });

  test('requires a userId', async () => {
    const { deps: d } = deps();
    for (const body of ['not json', {}, { userId: '   ' }, { userId: 7 }, { userId: 'u'.repeat(241) }])
      expect((await createMailAttachmentsPost(d)(post(body))).status).toBe(400);
    expect(d.defer).not.toHaveBeenCalled();
  });

  test('answers at once and drains the queue of the user after the response', async () => {
    const { deps: d, tasks } = deps();
    const res = await createMailAttachmentsPost(d)(post({ userId: ' u1 ' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, started: true });
    expect(d.drainMailAttachmentQueue).not.toHaveBeenCalled();
    await tasks[0]();
    expect(d.drainMailAttachmentQueue).toHaveBeenCalledWith('u1');
  });

  test('a failed drain goes to the log', async () => {
    const { deps: d, tasks } = deps();
    d.drainMailAttachmentQueue.mockImplementation(async () => {
      throw new Error('boom');
    });
    const errors = mock(() => undefined);
    const original = console.error;
    console.error = errors;
    try {
      await createMailAttachmentsPost(d)(post({ userId: 'u1' }));
      await tasks[0]();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
