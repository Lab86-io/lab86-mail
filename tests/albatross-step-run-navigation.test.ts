import { describe, expect, test } from 'bun:test';
import {
  openDocumentPath,
  openSavedDraft,
  openWorkPage,
  performNextBehaviour,
  type StepRunNavigatorDeps,
  webUrl,
} from '../lib/albatross/step-run-navigation';

function fakeDeps(drafts: any[] = []) {
  const calls: Array<[string, unknown]> = [];
  const views: string[] = [];
  const patches: Record<string, unknown>[] = [];
  const deps: StepRunNavigatorDeps = {
    getState: () => ({
      compose: { nonce: 3 },
      setPrimaryView: (view) => {
        views.push(view);
      },
      setPendingOpenCardId: (id) => {
        calls.push(['card', id]);
      },
      setSelectedWorkId: (id) => {
        calls.push(['work', id]);
      },
    }),
    setState: (patch) => {
      patches.push(patch);
    },
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { drafts };
    },
    openWindow: (url) => {
      calls.push(['open', url]);
    },
    pushPath: (path) => {
      calls.push(['push', path]);
    },
    dispatch: (eventName) => {
      calls.push(['event', eventName]);
    },
  };
  return { deps, calls, views, patches };
}

const draft = {
  _id: 'd1',
  account: 'jakob@lab86.io',
  to: 'claims@insurer.example',
  cc: '',
  subject: 'Dispute of claim 44-2031',
  body: 'Hello',
  threadId: 't9',
  inReplyToMessageId: 'm9',
  updatedAt: 1,
};

describe('a saved draft opens in the composer', () => {
  test('the composer gets the fields, the account, the anchor, and the same draft id', async () => {
    const { deps, calls, patches } = fakeDeps([draft]);
    expect(await openSavedDraft(deps, 'd1', 'jakob@lab86.io')).toBe(true);
    expect(calls[0]).toEqual(['list_drafts', { account: 'jakob@lab86.io' }]);
    expect(patches[0]).toEqual({
      compose: {
        mode: 'new',
        anchorThreadId: 't9',
        anchorMessageId: 'm9',
        anchorAccount: 'jakob@lab86.io',
        prefill: {
          to: 'claims@insurer.example',
          cc: '',
          bcc: undefined,
          subject: 'Dispute of claim 44-2031',
          body: 'Hello',
          draftId: 'd1',
        },
        nonce: 4,
      },
    });
  });

  test('no account or no such draft opens nothing', async () => {
    const { deps, patches } = fakeDeps([draft]);
    expect(await openSavedDraft(deps, 'd1', null)).toBe(false);
    expect(await openSavedDraft(deps, 'other', 'jakob@lab86.io')).toBe(false);
    expect(patches).toHaveLength(0);
  });
});

describe('a document opens in Files', () => {
  test('by its openPath, or by id, and never from a foreign url', () => {
    const { deps, calls, views } = fakeDeps();
    expect(openDocumentPath(deps, '/?view=files&document=doc_1', null)).toBe(true);
    expect(calls).toEqual([
      ['push', '/?view=files&document=doc_1'],
      ['event', 'lab86-mail:files-navigate'],
    ]);
    expect(views).toEqual(['files']);
    // The id alone, and the old /files/<id> form, become the link Files reads.
    expect(openDocumentPath(deps, null, 'doc 2')).toBe(true);
    expect(calls[2]).toEqual(['push', '/?view=files&document=doc%202']);
    expect(openDocumentPath(deps, '/files/doc_4', null)).toBe(true);
    expect(calls.at(-2)).toEqual(['push', '/?view=files&document=doc_4']);
    // A Word file opens in the Word editor.
    expect(openDocumentPath(deps, '/?view=files&office=word_1', 'word_1')).toBe(true);
    expect(calls.at(-2)).toEqual(['push', '/?view=files&office=word_1']);
    expect(openDocumentPath(deps, 'https://evil.example/x?document=doc_9', null)).toBe(false);
    // A protocol-relative path is another origin: it falls back to the id.
    expect(openDocumentPath(deps, '//evil.example/x', null)).toBe(false);
    expect(openDocumentPath(deps, '/\\evil.example/x', 'doc_3')).toBe(true);
    expect(calls.at(-2)).toEqual(['push', '/?view=files&document=doc_3']);
  });
});

describe('only web pages open in a new window', () => {
  test('webUrl keeps http and https and refuses everything else', () => {
    expect(webUrl(' https://x.example/a ')).toBe('https://x.example/a');
    expect(webUrl('http://x.example')).toBe('http://x.example');
    expect(webUrl('javascript:alert(1)')).toBeNull();
    expect(webUrl('data:text/html,hi')).toBeNull();
    expect(webUrl('not a url')).toBeNull();
    expect(webUrl(null)).toBeNull();
  });

  test('open_url refuses a script URL', async () => {
    const { deps, calls } = fakeDeps();
    expect(await performNextBehaviour({ kind: 'open_url', url: 'javascript:alert(1)' }, deps)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('performNextBehaviour', () => {
  test('routes each behaviour and reports what it could not do', async () => {
    const { deps, calls, views } = fakeDeps();
    const done: string[] = [];
    const surface = {
      showBrowser: () => done.push('browser'),
      showQuestion: (id: string | null) => done.push(`question:${id}`),
      markDone: () => done.push('done'),
      showArtifacts: () => done.push('artifacts'),
      resume: () => done.push('resume'),
    };
    expect(await performNextBehaviour({ kind: 'open_approval', id: 'ap' }, deps, surface)).toBe(true);
    expect(
      await performNextBehaviour({ kind: 'open_document', url: null, id: 'doc_hours' }, deps, surface),
    ).toBe(true);
    expect(await performNextBehaviour({ kind: 'open_url', url: 'https://x.y' }, deps, surface)).toBe(true);
    expect(await performNextBehaviour({ kind: 'open_card', id: 'c1' }, deps, surface)).toBe(true);
    expect(await performNextBehaviour({ kind: 'show_browser' }, deps, surface)).toBe(true);
    expect(await performNextBehaviour({ kind: 'show_question', id: 'q1' }, deps, surface)).toBe(true);
    expect(await performNextBehaviour({ kind: 'mark_done' }, deps, surface)).toBe(true);
    expect(await performNextBehaviour({ kind: 'show_artifacts' }, deps, surface)).toBe(true);
    expect(await performNextBehaviour({ kind: 'resume' }, deps, surface)).toBe(true);
    expect(views).toEqual(['notifications', 'files', 'tasks']);
    expect(calls).toEqual([
      ['push', '/?view=files&document=doc_hours'],
      ['event', 'lab86-mail:files-navigate'],
      ['open', 'https://x.y'],
      ['card', 'c1'],
    ]);
    expect(done).toEqual(['browser', 'question:q1', 'done', 'artifacts', 'resume']);
  });

  test('a surface without the handler returns false, so the caller can say so', async () => {
    const { deps } = fakeDeps();
    expect(await performNextBehaviour({ kind: 'show_browser' }, deps)).toBe(false);
    expect(await performNextBehaviour({ kind: 'resume' }, deps, {})).toBe(false);
    expect(await performNextBehaviour({ kind: 'open_draft', id: 'd1', accountId: 'a' }, deps)).toBe(false);
  });

  test('the Brief opens the Work page', () => {
    const { deps, calls, views } = fakeDeps();
    openWorkPage(deps, 'work_1');
    expect(views).toEqual(['albatrosses']);
    expect(calls).toEqual([['work', 'work_1']]);
  });
});
