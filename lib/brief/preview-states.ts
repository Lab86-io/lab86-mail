// The stubbed reads behind /dev/brief-preview?state=. Each state is one thing
// the Today page can show. Every name here is invented, and no request leaves
// the browser for a brief read. Development only.

import { letterBriefDocumentFixture } from '../shared/brief-document-fixtures';
import type { BriefPendingEdition, BriefViewResponse, BriefWebEdition } from './web-view';

export type BriefPreviewState = 'first-load' | 'on-the-way' | 'plain-letter' | 'swap' | 'nothing';

const SWAP_AFTER_MS = 3_000;

function editionBase(id: string, ageMs: number): BriefWebEdition {
  return {
    _id: id,
    kind: 'morning',
    generatedAt: Date.now() - ageMs,
    title: 'Daily Brief',
    status: 'ready',
    services: ['gmail', 'calendar'],
    stats: { noise: 42, overflow: 2 },
    sections: {
      overflow: [
        {
          account: 'account-a',
          threadId: 'backlog-1',
          subject: 'Vendor contract renewal',
          whyItMatters: 'Lars Whitfield asks for a date for the renewal call.',
        },
        {
          account: 'account-a',
          threadId: 'backlog-2',
          subject: 'Office move schedule',
          whyItMatters: 'Ines Valcourt shares the new floor plan.',
        },
      ],
    },
  };
}

/** One edition with a document of its own: the form that a finished edition takes. */
export function previewDocumentEdition(id: string, ageMs: number): BriefWebEdition {
  return {
    ...editionBase(id, ageMs),
    artifactSource: 'document-v2',
    artifactStatus: 'ready',
    document: { ...letterBriefDocumentFixture, generatedAt: Date.now() - ageMs },
  };
}

/** The row of a new edition while it composes: lanes, and no document yet. */
export function previewPlainLetterEdition(id: string): BriefWebEdition {
  const line = (threadId: string, subject: string, sender: string, whyItMatters: string) => ({
    account: 'account-a',
    threadId,
    subject,
    sender,
    whyItMatters,
  });
  return {
    ...editionBase(id, 0),
    artifactSource: 'deterministic',
    artifactStatus: 'composing',
    narrative: 'Maya Okafor needs a decision on the launch budget before the review at 2:00.',
    prose: {
      lede: 'Maya Okafor needs a decision on the launch budget before the review at 2:00.',
      weekAhead: 'The team review is on Thursday. Leave Wednesday afternoon for preparation.',
    },
    sections: {
      ...editionBase(id, 0).sections,
      answer: [
        line('t1', 'Launch budget approval', 'Maya Okafor', 'Maya needs your approval before the review.'),
        line('t2', 'Hiring plan numbers', 'Theo Marchetti', 'Theo asks you to confirm the headcount.'),
      ],
      today: [
        line('t3', 'Support handoff', 'Priya Nandakumar', 'The support owner changes at the end of the day.'),
      ],
      know: [line('t4', 'Quarter summary', 'Lars Whitfield', 'The summary is out, with no action for you.')],
      calendar: [],
    },
  };
}

function viewFor(state: BriefPreviewState, startedAt: number): BriefViewResponse {
  const writing: BriefPendingEdition = { reportId: 'new-edition', phase: 'writing' };
  const composing: BriefPendingEdition = { reportId: 'new-edition', phase: 'composing' };
  const hourAgo = 3_600_000;
  switch (state) {
    case 'on-the-way':
      return {
        stamp: 'new-edition|partial||',
        pending: writing,
        revision: 'preview-last',
        report: previewDocumentEdition('last-edition', hourAgo),
      };
    case 'plain-letter':
      return {
        stamp: 'new-edition|ready|composing|',
        pending: composing,
        revision: 'preview-plain',
        report: previewPlainLetterEdition('new-edition'),
      };
    case 'swap':
      return Date.now() - startedAt < SWAP_AFTER_MS
        ? {
            stamp: 'new-edition|partial||',
            pending: writing,
            revision: 'preview-last',
            report: previewDocumentEdition('last-edition', hourAgo),
          }
        : {
            stamp: 'idle',
            pending: null,
            revision: 'preview-new',
            report: previewDocumentEdition('new-edition', 0),
          };
    case 'nothing':
      return {
        stamp: 'new-edition|partial||',
        pending: { ...writing, progress: { stage: 'Reading mail', done: 2, total: 5 } },
        revision: null,
        report: null,
      };
    default:
      return { stamp: 'idle', pending: null, revision: null, report: null };
  }
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** A fetch that answers every read of the Today page from the state. Other URLs pass through. */
export function briefPreviewFetch(state: BriefPreviewState, passThrough: typeof fetch): typeof fetch {
  const startedAt = Date.now();
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://preview.test');
    if (url.pathname === '/api/brief/view') {
      if (init?.method !== 'POST') {
        const { stamp, pending } = viewFor(state, startedAt);
        return json({ stamp, pending });
      }
      // The first load stays on its skeleton: this read never lands.
      if (state === 'first-load') return new Promise<Response>(() => undefined);
      return json(viewFor(state, startedAt));
    }
    if (url.pathname === '/api/mobile/briefs/resolve') return json({ ok: true, entities: [] });
    if (url.pathname === '/api/tools/get_brief_sources')
      return json({
        ok: true,
        result: { health: { sources: [], attention: 0, line: 'Sources: Gmail synced 4 min ago.' } },
      });
    if (url.pathname.startsWith('/api/tools/')) return json({ ok: true, result: { reports: [], items: [] } });
    if (url.pathname.startsWith('/api/'))
      return json({ ok: true, items: [], handoffs: [], preparations: [] });
    return passThrough(input, init);
  };
}
