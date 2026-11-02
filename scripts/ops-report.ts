/**
 * The ops signals report: failure rates, run latency, brief stages, and web
 * speed for the last 24 hours and 7 days. See docs/ops-signals.md.
 *
 * READ ONLY. It calls Convex queries and writes nothing. The rows hold counts,
 * fixed names, and tool names, so the output holds no personal data.
 *
 * Usage (with the environment of the Railway `web` service):
 *   railway run --environment production --service web -- bun scripts/ops-report.ts
 *
 * Environment: NEXT_PUBLIC_CONVEX_URL (or CONVEX_URL), LAB86_CONVEX_INTERNAL_SECRET.
 */
import { api, convexQuery } from '../lib/hosted/convex';
import { buildOpsReport, formatOpsReport, loadOpsReportData } from '../lib/ops/report';

const now = Date.now();
const data = await loadOpsReportData(
  convexQuery as never,
  {
    buckets: api.opsHealth.bucketsPage,
    tools: api.opsHealth.toolRollupsPage,
    speed: api.speedRollups.rollupsPage,
    brief: api.dailyReports.editionTelemetrySummary,
  },
  now,
);
console.log(formatOpsReport(buildOpsReport(data, now)));
