import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type OpenWork, ProofOfferMatchSummary, submitMailProof } from '../components/thread/ProofOffer';
import { proofCandidatesForMail } from '../lib/albatross/proof-match';

const work: OpenWork = {
  _id: 'passport/work',
  title: 'Renew passport',
  contract: {
    outcome: 'The passport is renewed',
    proofs: [{ id: 'confirmation', what: 'The application confirmation arrived' }],
  },
};

describe('mail proof offer', () => {
  test('renders the exact matched proof as a tentative question', () => {
    const match = proofCandidatesForMail(
      [{ ...work, outcome: work.contract?.outcome, proofs: work.contract?.proofs }],
      'Your passport application confirmation arrived',
    )[0];
    if (!match) throw new Error('Expected a proof match.');
    const html = renderToStaticMarkup(createElement(ProofOfferMatchSummary, { match }));

    expect(html).toContain('Does this settle something you are carrying?');
    expect(html).toContain('The application confirmation arrived');
    expect(html).toContain('Renew passport');
  });

  test('files the selected proof without sending a client-authored trust level', async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    await submitMailProof(
      {
        work,
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
      sourceKind: 'mail_thread',
      sourceId: 'thread-7',
      accountId: 'personal-mail',
      proofId: 'confirmation',
    });
    expect(request?.body).not.toHaveProperty('trust');
  });

  test('renders nothing when ranking finds no plausible Work and surfaces filing errors', async () => {
    expect(
      proofCandidatesForMail(
        [{ ...work, outcome: work.contract?.outcome, proofs: work.contract?.proofs }],
        'Completely unrelated newsletter',
      ),
    ).toEqual([]);

    await expect(
      submitMailProof(
        {
          work,
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
