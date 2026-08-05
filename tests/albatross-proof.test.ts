import { describe, expect, test } from 'bun:test';
import {
  type EvidenceLike,
  evidenceSourceLabel,
  latestProof,
  PROOF_LEVEL_LABEL,
  proofLevel,
  proofSummary,
} from '../lib/albatross/proof';

// Proof is the claim the product rests on: not that it remembers an intention,
// but that it can tell whether the outcome happened. These pin what the user is
// told, and — just as importantly — what they are never told.

const at = (day: number, trust: EvidenceLike['trust'], sourceKind = 'mail_thread'): EvidenceLike => ({
  title: `evidence ${day}`,
  sourceKind,
  occurredAt: day,
  trust,
});

describe('proofLevel', () => {
  test('nothing seen means no claim at all', () => {
    expect(proofLevel([])).toBe('none');
  });

  test('the ladder climbs observed → inferred → confirmed', () => {
    expect(proofLevel([at(1, 'observed')])).toBe('seen');
    expect(proofLevel([at(1, 'inferred')])).toBe('likely');
    expect(proofLevel([at(1, 'confirmed')])).toBe('confirmed');
  });

  test('the strongest evidence wins, whatever order it arrives in', () => {
    expect(proofLevel([at(1, 'observed'), at(2, 'confirmed'), at(3, 'inferred')])).toBe('confirmed');
    expect(proofLevel([at(3, 'inferred'), at(1, 'observed')])).toBe('likely');
  });

  test('rejected evidence never raises the claim', () => {
    expect(proofLevel([at(1, 'rejected')])).toBe('none');
    expect(proofLevel([at(1, 'rejected'), at(2, 'observed')])).toBe('seen');
  });
});

describe('latestProof', () => {
  test('is the most recent usable row, not the most recent row', () => {
    const rows = [at(10, 'observed'), at(30, 'rejected'), at(20, 'inferred')];
    expect(latestProof(rows)?.occurredAt).toBe(20);
  });

  test('is null when everything was ruled out', () => {
    expect(latestProof([at(1, 'rejected')])).toBeNull();
    expect(latestProof([])).toBeNull();
  });
});

describe('proofSummary', () => {
  test('says so plainly when nothing has proved anything', () => {
    expect(proofSummary([])).toBe(PROOF_LEVEL_LABEL.none);
    expect(proofSummary([at(1, 'rejected')])).toBe(PROOF_LEVEL_LABEL.none);
  });

  test('names the level and where the proof came from', () => {
    expect(proofSummary([at(1, 'confirmed', 'mail_thread')])).toBe('Confirmed done · an email');
    expect(proofSummary([at(1, 'observed', 'calendar_event')])).toBe('Something happened · a calendar event');
  });

  test('names the row that actually carries the claim, not just the newest', () => {
    // Live defect: the level came from the strongest row and the source from
    // the newest, so the line read "Confirmed done · a calendar event" while
    // the calendar event proved nothing and an email did the confirming.
    const summary = proofSummary([at(1, 'confirmed', 'mail_thread'), at(9, 'observed', 'calendar_event')]);
    expect(summary).toBe('Confirmed done · an email');
  });

  test('uses the newest row that carries the level, when several do', () => {
    const summary = proofSummary([at(1, 'confirmed', 'calendar_event'), at(5, 'confirmed', 'mail_thread')]);
    expect(summary).toBe('Confirmed done · an email');
  });

  test('falls back to the newest usable row when the level has no matching kind', () => {
    // 'reported' is not one of the three trusts the ladder reads, so the level
    // stays 'seen' from the observed row and the source comes from it too.
    const summary = proofSummary([at(1, 'observed', 'question_answer')]);
    expect(summary).toBe('Something happened · your answer');
  });

  test('never quotes a score', () => {
    const summary = proofSummary([at(1, 'inferred'), at(2, 'observed')]);
    expect(summary).not.toMatch(/\d/);
    expect(summary.toLowerCase()).not.toContain('confidence');
    expect(summary.toLowerCase()).not.toContain('%');
  });
});

describe('evidenceSourceLabel', () => {
  test('translates every stored source kind into ordinary words', () => {
    for (const kind of [
      'mail_thread',
      'calendar_event',
      'task',
      'chat',
      'question_answer',
      'area_fact',
      'github_issue',
      'github_pull_request',
      'github_commit',
      'mcp_item',
      'manual',
    ]) {
      const label = evidenceSourceLabel(kind);
      expect(label).toBeTruthy();
      expect(label).not.toContain('_');
    }
  });

  test('an unknown kind still reads as something a person could parse', () => {
    expect(evidenceSourceLabel('some_future_connector')).toBe('A connected service');
  });
});
