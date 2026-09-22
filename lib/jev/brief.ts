import type { SmartCategory } from '../shared/types';
import { hasObligation, type JevAssessment, type JevCorrection, type JevPreferences } from './contract';

export function briefAttention(input: {
  assessment?: JevAssessment | null;
  smart?: SmartCategory | null;
  preferences: JevPreferences;
  correction?: JevCorrection;
  now: number;
  waitingSince: number;
  fallbackReply: boolean;
  fallbackBulk?: 'promotion' | 'newsletter';
  tracked: boolean;
  previouslySurfaced?: boolean;
  changePreviouslySurfaced?: boolean;
}) {
  const { assessment, smart, preferences, correction } = input;
  const excluded =
    correction?.brief === 'exclude' || (smart?.model === 'user_rule' && smart.primary === 'noise');
  const included =
    correction?.brief === 'include' || (smart?.model === 'user_rule' && smart.primary === 'main');
  const reply = assessment ? hasObligation(assessment, 'reply') : input.fallbackReply;
  const action = assessment ? hasObligation(assessment, 'action') : false;
  const waiting = assessment ? hasObligation(assessment, 'waiting') : false;
  const followUp = waiting && input.now - input.waitingSince >= preferences.followUpDays * 86400_000;
  const change = Boolean(assessment?.meaningfulChange && preferences.briefAccountChanges);
  const purpose = assessment?.purpose || input.fallbackBulk;
  const bulk = purpose === 'promotion' || purpose === 'newsletter';
  const allowBulk = purpose === 'promotion' ? preferences.briefPromotions : preferences.briefNewsletters;
  const eligible =
    !excluded &&
    (included ||
      (bulk
        ? allowBulk && !input.previouslySurfaced
        : reply || action || followUp || (change && !input.changePreviouslySurfaced) || input.tracked));
  return {
    eligible,
    reply: !excluded && reply,
    action: !excluded && action,
    waiting: !excluded && waiting,
    followUp: !excluded && followUp,
    change: !excluded && change,
  };
}
