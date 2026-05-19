import { spawn } from 'node:child_process';

const GOG_BIN = process.env.MAIL_OS_GOG_BIN || '/home/jjalangtry/.local/bin/lab86-gog';

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
}

/**
 * Spawn lab86-gog once per call. Bun + Node make this fast enough that a
 * persistent pool is more complexity than it's worth for v2.0 — we can swap
 * this for a pooled worker later by changing only this module.
 */
export async function runGog(args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(GOG_BIN, args, {
      env: process.env,
      timeout: options.timeoutMs ?? 60_000,
    });
    let stdout = '';
    let stderr = '';
    const max = 32 * 1024 * 1024;
    let received = 0;
    child.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received > max) {
        child.kill();
        reject(new Error('gog stdout too large'));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    if (options.stdin) child.stdin.end(options.stdin);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        const message = stderr.trim() || stdout.trim() || `gog exited ${code}`;
        const err = new Error(message);
        (err as any).code = code;
        reject(err);
      }
    });
  });
}

export async function runGogJson<T = any>(args: string[], options: RunOptions = {}): Promise<T | null> {
  const out = await runGog(args, options);
  if (!out) return null;
  return JSON.parse(out) as T;
}
