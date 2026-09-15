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
