import { execa } from 'execa';

const GOG_BIN = process.env.LAB86_MAIL_GOG_BIN || process.env.MAIL_OS_GOG_BIN || '/home/jjalangtry/.local/bin/lab86-gog';

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
}

export async function runGog(args: string[], options: RunOptions = {}): Promise<string> {
  try {
    const result = await execa(GOG_BIN, args, {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      input: options.stdin,
      env: process.env,
      // Use 'pipe' so we can read stdout while preserving its UTF-8 string form.
      stdout: 'pipe',
      stderr: 'pipe',
      reject: true,
    });
    return result.stdout.trim();
  } catch (err: any) {
    // execa surfaces failures with a rich ExecaError shape (stdout/stderr/
    // exitCode/shortMessage). We normalize to a plain Error with the most
    // informative message available.
    if (err && (err.stderr !== undefined || err.exitCode !== undefined || err.shortMessage)) {
      const stderr = err.stderr ? String(err.stderr).trim() : '';
      const stdout = err.stdout ? String(err.stdout).trim() : '';
      const msg = stderr || stdout || err.shortMessage || err.message || 'gog failed';
      const wrapped = new Error(msg);
      (wrapped as any).code = err.exitCode ?? null;
      throw wrapped;
    }
    throw err;
  }
}

export async function runGogJson<T = any>(args: string[], options: RunOptions = {}): Promise<T | null> {
  const out = await runGog(args, options);
  if (!out) return null;
  return JSON.parse(out) as T;
}
