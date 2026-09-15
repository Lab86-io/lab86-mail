import { envFlag, isStagingRuntime } from '@/lib/hosted/controls';

/**
 * Rollout flags for the editor work. Each flag is independent. On staging both
 * default on; elsewhere both default off until the staging release is verified.
 * An explicit `true` or `false` in the environment always wins.
 */
function flag(name: string, host?: string | null) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return isStagingRuntime(host);
  return envFlag(name);
}

/** Themed, compact Collabora chrome with Albatross controls. */
export function isThemedOfficeChromeEnabled(host?: string | null) {
  return flag('OFFICE_THEMED_CHROME', host);
}

/** Version 2 slide authoring: rich elements, deck themes, designed generation. */
export function isDeckV2AuthoringEnabled(host?: string | null) {
  return flag('DECK_V2_AUTHORING', host);
}

/**
 * Client-side view of the authoring flag. Public variables are inlined per
 * build, and staging and production are separate builds, so each environment
 * sets `NEXT_PUBLIC_DECK_V2_AUTHORING`. Development defaults on.
 */
export function isDeckV2AuthoringEnabledOnClient() {
  const raw = process.env.NEXT_PUBLIC_DECK_V2_AUTHORING;
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'development';
  return raw === '1' || raw === 'true' || raw === 'yes';
}
