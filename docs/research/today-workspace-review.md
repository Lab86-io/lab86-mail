# Today workspace review follow-up

Follow-up to #240, targeting staging only. The original research and product
decisions remain in [the Today workspace notes](narrative-today-workspace.md).

CodeRabbit's late review identified six valid improvements. This follow-up:

- logs only error names for unexpected route failures;
- handles non-JSON errors and malformed success responses without parser messages;
- displays source dates in the reader's timezone, including evening/day boundaries;
- isolates shared generation from individual caller cancellation while retaining
  the fixed model deadline, caller cancellation, and fresh permission checks;
- replaces personal identifiers in the smoke script with required process inputs
  (`SMOKE_RAILWAY_ENVIRONMENT_ID`, `SMOKE_CONVEX_URL`, `SMOKE_USER_ID`,
  `SMOKE_USER_EMAIL`), retaining the explicit staging/environment/account guards;
- strengthens the source-diversity test so lexical scoring cannot mask a broken
  category reserve.

Regression tests cover concurrent cancellation, timezones, invalid timestamps,
non-JSON errors, malformed responses, and category reservations. No layout redesign,
native changes, production rollout, consent changes, or external actions.
