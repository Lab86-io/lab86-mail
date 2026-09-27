// Next types process.env.NODE_ENV as required and read-only. Tests build
// partial environments and switch NODE_ENV, so they use these two helpers.

/** A partial environment for code that takes an env object. */
export function testEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

/** Sets or clears one variable on the real process.env, NODE_ENV included. */
export function setProcessEnv(key: string, value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}
