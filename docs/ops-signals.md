# Ops signals

This document describes the failure alarm, the speed data, and the report. These signals tell the
owner when a part of the product fails and how slow the web is.

The production model key was disabled from 2026-10-22 to 2026-10-27. On 10-26 and 10-27, 1,628 of
2,146 model calls failed with "User not found", and nothing told anyone. The failure alarm exists
to stop this.

## Failure alarm

The write path adds one to a small hourly row in `opsHealthBuckets`. The row has an hour, a kind,
counts, and a fixed error class. It has no user id and no mail text. A cron runs every 15 minutes
and reads only the current hour and the previous hour.

The alarm has these kinds:

| Kind | What counts | Opens at | Minimum calls | Silence rule |
| --- | --- | --- | --- | --- |
| `model:chat` | Chat and run model calls | 50% failed | 5 | 24 hours, only with failed calls |
| `model:brief` | Brief model calls | 25% failed | 5 | 28 hours |
| `model:jev` | Jev model calls | 25% failed | 10 | 8 hours |
| `model:narrative` | Narrative model calls | 25% failed | 10 | 12 hours |
| `model:other` | All other model calls | 25% failed | 10 | 24 hours, only with failed calls |
| `tool` | Agent tool calls | 50% failed | 8 | None |
| `run` | Albatross runs | 50% failed | 3 | None |
| `brief_fallback` | Finished daily editions | 50% fell back | 2 | None |

The limits are in `OPS_POLICY` in `lib/ops/health.ts`. Only calls that Lab86 pays for count as model
calls: a user's own key that stops working is not an outage. A call that a person stopped does not
count.

The failure rate needs no successful call. A disabled key gives failures only, and the rate is then
100%. The silence rule opens an incident when a kind had calls in the earlier hours and has no
successful call for the given time.

The owner gets one mail when an incident opens, and one mail when it closes. Each `opsHealthWatch`
row saves its open incident, so a restart does not send a mail again. All kinds that open in one run
go into one mail, because a disabled key fails all model groups at the same time. An incident closes
when a kind has a successful call, its failure rate is below half of its limit, and the incident is
at least 30 minutes old.

The alarm needs `LAB86_OWNER_ALERT_EMAIL`, `RESEND_API_KEY`, and `LAB86_NOTIFICATION_FROM` on the web
service. If one of these is not set, the alarm logs one warning and does nothing. The app route
sends the mail, so the alarm cannot send a mail when the web service is down.

## Web speed

`components/shell/WebSpeedReporter.tsx` runs in the signed-in shell. It records these metrics:

- `TTFB`, `FCP`, and `LCP`, from the Next web vitals hook. These measure the page load, so they go
  to the surface that loaded, or to `app`.
- `INP` and `CLS`, from the same hook. These go to the surface on the screen when the browser reports
  them, so they are estimates for one surface. The rows store `CLS` multiplied by 1000. The report
  prints the real value.
- `surface_load`: from the navigation start to the first real content of the first surface.
- `surface_switch`: from the click or key that changes the surface to its first real content.

A surface is ready at these points:

| Surface | Ready when |
| --- | --- |
| `today` | The brief read is complete and no edition shows its progress state. |
| `albatrosses` | The rows of the list are available. |
| `thread` | The detail of the Albatross is available. |
| `mail` | The first rows are available, or the mailbox is known to be empty. |
| `needs_you` | The snapshot is available. |

To time a surface, call `useSurfaceReady('mail', ready)` in its component. Other code can call
`markSurfaceReady('mail')`. The first call of a visit counts, and later calls do nothing. A visit
that was hidden does not count.

The browser sends one batch at most every 30 seconds, and one when the page hides. The batch goes to
`POST /api/metrics/web`. The route rejects an unknown name or an extra field, so no URL, id, or
title can come in. The route holds samples in memory and writes to Convex at most once a minute. A
restart loses at most one minute of samples.

`speedRollups` holds one row for each day, metric, surface, and form factor. A row holds a histogram
with fixed buckets. The hourly retention sweep removes rows after 90 days. To change the bucket
limits, also change the metric names, because old rows read wrong with new limits.

## Server timing

`POST /api/tools/[name]` sends a `Server-Timing` header with the stages `auth`, `rate_limit`, and
`handler`. To see it, open the network panel of the browser and select the request. The header holds
no tool name and no argument.

## Run latency and brief stages

When a run ends, Convex writes three rows to `speedRollups`:

- `run_queue`: from the run creation to its start.
- `run_first_visible`: from the run creation to `firstVisibleAt`. A run with no such field uses its
  first log line.
- `run_longest_silence`: the longest time with no log line. A run keeps 30 log lines, so a longer run
  does not count the time before its oldest line.

`briefEditionTelemetry` has an optional `stages` map, in milliseconds, summed over the attempts of
the edition:

- `queued`: from the job creation to its first claim.
- `sources`: the source refresh and the selection of items.
- `composition`: the read of message bodies and context.
- `prose`: the prose writer.
- `editorial`: the layout writer.
- `save`: the saves of the edition.

## Report

Run the report by hand with the environment of the web service:

```bash
railway run --environment production --service web -- bun scripts/ops-report.ts
```

The report only reads. It prints these numbers for the last 24 hours and the last 7 days:

| Section | Source | Meaning |
| --- | --- | --- |
| Failure rate by group | `opsHealthBuckets` | Failed calls divided by all calls, and the newest error class. |
| Tool failure rate | `opsToolRollups` | Failed tool calls for each tool and class. `rejected` is not a failure. |
| Run latency | `speedRollups` | p50 and p75 of queue, first visible, and longest silence. |
| Brief stages | `briefEditionTelemetry` | p50 and p90 of each stage, and the fallback rate. |
| Web speed | `speedRollups` | p50 and p75 for each surface, metric, and form factor. |

Hourly rows cut at the hour. Daily rows cut at a UTC day, so "24 hours" reads today and yesterday.
Percentiles come from histogram buckets, so they are estimates. With few samples, a value reads
near the top of its bucket. Run latency and web speed start at the deploy of this change: older data
is not in the rollups.

The rows hold counts, fixed names, and tool names. The report cannot print a user, a mail, a URL, or
a thread title.

## Cost

Convex I/O is the main limit of this design. No part reads `aiUsageEvents`, and no part calls Convex
for each web event.

- One model call adds one indexed read and one write of a row of about 200 bytes.
- One cron run reads at most 64 bucket rows in a query, so it cannot conflict with a usage write.
  It then reads 8 watch rows and writes only the watch rows that changed.
- The web route writes at most once a minute.
- The retention sweep adds three indexed reads to each hourly run.
