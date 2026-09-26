// Optional surfaces that a user turns on in Settings, Advanced. The choice is
// stored on the server (a per-user pref), so web, iOS, and macOS agree.
//
// Files and the Office editors are optional. A new account starts with Files
// off; an account that already has documents starts with Files on. The first
// read decides once and stores the answer, so a document made later (for
// example a Work deliverable) does not turn Files on by itself.

import { runWithAiRequestContext } from '../ai/context';
import { getPref, setPref } from '../store/prefs';
import { api, convexQuery } from './convex';

const FILES_PREF = 'filesSurface';

export interface Surfaces {
  files: boolean;
}

export interface SurfaceDependencies {
  readPref(userId: string): Promise<string | null>;
  writePref(userId: string, value: 'on' | 'off'): Promise<void>;
  hasDocuments(userId: string): Promise<boolean>;
}

function asUser<T>(userId: string, run: () => Promise<T>) {
  return runWithAiRequestContext({ userId, agent: 'user' }, run);
}

export const surfaceDefaults: SurfaceDependencies = {
  readPref: (userId) => asUser(userId, () => getPref(FILES_PREF)),
  writePref: (userId, value) => asUser(userId, () => setPref(FILES_PREF, value)),
  hasDocuments: (userId) => convexQuery<boolean>((api as any).accounts.hasDocuments, { userId }),
};

export async function resolveSurfaces(
  userId: string,
  deps: SurfaceDependencies = surfaceDefaults,
): Promise<Surfaces> {
  const stored = await deps.readPref(userId);
  if (stored === 'on' || stored === 'off') return { files: stored === 'on' };
  const files = await deps.hasDocuments(userId);
  await deps.writePref(userId, files ? 'on' : 'off');
  return { files };
}

export async function setFilesSurface(
  userId: string,
  enabled: boolean,
  deps: SurfaceDependencies = surfaceDefaults,
): Promise<Surfaces> {
  await deps.writePref(userId, enabled ? 'on' : 'off');
  return { files: enabled };
}
