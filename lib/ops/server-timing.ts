// The Server-Timing header of a request: stage names and milliseconds, so the
// browser's network panel can show where the time went. Stage names are fixed
// words. Never put a user value, an id, or a mail subject in one.

export function createServerTiming(now: () => number = () => performance.now()) {
  const stages: Array<{ name: string; ms: number }> = [];
  return {
    async measure<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      const startedAt = now();
      try {
        return await run();
      } finally {
        stages.push({ name, ms: Math.max(0, now() - startedAt) });
      }
    },
    header() {
      return stages.map((stage) => `${stage.name};dur=${stage.ms.toFixed(1)}`).join(', ');
    },
    apply<R extends { headers: Headers }>(response: R): R {
      const value = stages.length ? this.header() : '';
      if (value) response.headers.set('Server-Timing', value);
      return response;
    },
  };
}
