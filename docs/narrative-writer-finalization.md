# Dense-account narrative finalization

The first deployed acceptance run still timed out twice at 80 seconds on the
real staging account, despite synthetic brief/month generation passing. Main
promotion was held. The successful candidate then required 90.3 seconds for
writing: the prior deadline was cutting off a valid completion.

This follow-up keeps the same configured GLM model and consent, but passes at
most 12 evidence rows in a 6,000-character pre-serialization budget. The writer
sees short citation codes directly, not opaque database IDs plus a second
translation map. Exact IDs are restored and validated by the host. A retry uses
only the first six rows, while retaining the 4,000-token allowance required for
the model's mandatory reasoning. The first writing window is 110 seconds and
the retry is at most 60 seconds, inside the unchanged 210-second overall bound.

Candidate real-account acceptance: ready in 117.9 seconds, one model-written
1,562-character brief, two cited observations, unchanged source selections.
Writer input was 1,383 tokens. Live synthetic acceptance on the preceding
deployment passed monthly provenance, a semantic paraphrase, cross-service
connection, model-written brief/month, and correction revocation.

A second real-account run also completed: ready in 119.6 seconds, 771 characters,
four citations, despite the research phase timing out. The bounded writer used
already-validated evidence and completed in 84.9 seconds.

CodeRabbit's native PR review also found shared backend issues. This follow-up
caches source-consent reads only within a single bucket transaction, keeps
threads eligible alongside age-matched calendar chapters, and schedules one
cleanup when both timezone and consent change. Runtime tests cover all 140
candidates with mail, calendar and MCP originals, permission revocation in the
next transaction, pending ordering, and cleanup deduplication.

Focused tests verify bounded packets, reduced retry context, and restoration of
exact cited source IDs. Publication still revalidates ownership, consent, source
versions and the run revision. This is a bounded representative narrative, not
a claim to have read every event or to guarantee a model provider's latency.
