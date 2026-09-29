import { envFlag, isDevelopmentRuntime } from '@/lib/hosted/controls';

/**
 * Rollout flags for the editor work. Each flag is independent. In development both
 * default on; production requires an explicit opt-in.
 * An explicit `true` or `false` in the environment always wins.
 */
function flag(name: string) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return isDevelopmentRuntime();
  return envFlag(name);
}

/** Themed, compact Collabora chrome with Albatross controls. */
export function isThemedOfficeChromeEnabled() {
  return flag('OFFICE_THEMED_CHROME');
}

/** Version 2 slide authoring: rich elements, deck themes, designed generation. */
export function isDeckV2AuthoringEnabled() {
  return flag('DECK_V2_AUTHORING');
}

/**
 * Client-side view of the authoring flag. Public variables are inlined per
 * build. Set `NEXT_PUBLIC_DECK_V2_AUTHORING` explicitly for production builds.
 * Development defaults on.
 */
export function isDeckV2AuthoringEnabledOnClient() {
  const raw = process.env.NEXT_PUBLIC_DECK_V2_AUTHORING;
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'development';
  return raw === '1' || raw === 'true' || raw === 'yes';
}
