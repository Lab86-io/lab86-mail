#!/usr/bin/env bun
import { generateDailyReport } from '../lib/mail/daily-report';

const kind = process.argv[2] === 'morning' || process.argv[2] === 'evening' ? process.argv[2] : 'manual';

try {
  const report = await generateDailyReport({ kind, includeCalendar: true });
  console.log(
    JSON.stringify(
      {
        ok: true,
        id: report._id,
        kind: report.kind,
        generatedAt: report.generatedAt,
        scannedThreads: report.stats.scannedThreads,
        trackedThreads: report.stats.trackedThreads,
      },
      null,
      2,
    ),
  );
} catch (err: any) {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exit(1);
}
