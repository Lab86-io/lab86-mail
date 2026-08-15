import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  loadProofMatches,
  type ProofMatchCandidate,
  ProofOfferMatchSummary,
  submitMailProof,
} from '../components/thread/ProofOffer';

const candidate: ProofMatchCandidate = {
  workId: 'passport/work',
  workTitle: 'Renew passport',
  outcome: 'The passport is renewed',
  proofId: 'confirmation',
  proofWhat: 'The application confirmation arrived',
  gate: 'confirmed',
  outstanding: [{ id: 'confirmation', what: 'The application confirmation arrived' }],
};

describe('mail proof offer', () => {
  test('renders the exact matched proof as a tentative question', () => {
    const html = renderToStaticMarkup(createElement(ProofOfferMatchSummary, { match: candidate }));

    expect(html).toContain('Does this settle something you are carrying?');
    expect(html).toContain('The application confirmation arrived');
    expect(html).toContain('Renew passport');
  });

  test('an unchecked candidate renders as an unverified suggestion, never a claim', () => {
    const html = renderToStaticMarkup(
      createElement(ProofOfferMatchSummary, { match: { ...candidate, gate: 'unchecked' } }),
    );
    expect(html).toContain('Unverified match');
    expect(html).toContain('shares words with');
    expect(html).not.toContain('Albatross matched it to');
  });

  test('asks the server for candidates with the thread identity for class filtering', async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const matches = await loadProofMatches(
      {
        subject: 'Application received',
        snippet: 'Your application was received.',
        accountId: 'personal-mail',
        providerThreadId: 'thread-7',
      },
      async (url, init) => {
        request = { url, body: JSON.parse(String(init.body)) };
        return Response.json({ ok: true, candidates: [candidate] });
      },
    );

    expect(request?.url).toBe('/api/albatross/proof-matches');
    expect(request?.body).toMatchObject({
      subject: 'Application received',
      accountId: 'personal-mail',
      providerThreadId: 'thread-7',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].workTitle).toBe('Renew passport');
  });

  test('a failed candidates request renders as silence, never as an error', async () => {
    const matches = await loadProofMatches(
      { subject: 'Anything', snippet: null, accountId: 'a', providerThreadId: 't' },
      async () => Response.json({ ok: false, error: 'nope' }, { status: 500 }),
    );
    expect(matches).toEqual([]);
  });

  test('files the selected proof without sending a client-authored trust level', async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    await submitMailProof(
      {
        workId: candidate.workId,
        workTitle: candidate.workTitle,
        threadId: 'thread-7',
        accountId: 'personal-mail',
        subject: 'Application received',
        snippet: 'Your application was received.',
        proofId: 'confirmation',
        proofWhat: 'The application confirmation arrived',
        timezone: 'America/New_York',
      },
      async (url, init) => {
        request = { url, body: JSON.parse(String(init.body)) };
        return Response.json({ ok: true, evidenceId: 'evidence-1' });
      },
    );

    expect(request?.url).toBe('/api/albatross/work/passport%2Fwork/proof');
    expect(request?.body).toMatchObject({
      claim: 'The application confirmation arrived',
      title: 'Application received',
      sourceKind: 'mail_thread',
      sourceId: 'thread-7',
      accountId: 'personal-mail',
      proofId: 'confirmation',
    });
    expect(request?.body).not.toHaveProperty('trust');
  });

  test('surfaces filing errors from the proof route', async () => {
    await expect(
      submitMailProof(
        {
          workId: candidate.workId,
          workTitle: candidate.workTitle,
          threadId: 'thread-7',
          accountId: 'personal-mail',
          subject: 'Application received',
          timezone: 'UTC',
        },
        async () => Response.json({ error: 'Mail proof could not be verified.' }, { status: 400 }),
      ),
    ).rejects.toThrow('Mail proof could not be verified.');
  });
});
