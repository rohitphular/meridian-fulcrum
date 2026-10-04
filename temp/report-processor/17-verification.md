# 17 — Verification

**Depends on:** 09–16.

## Steps
1. Golden fixtures with hand-computed results (not the old GAS output — semantics changed by D2/D3): transfers, cross-currency, deleted rows, tracking start, tags, missing rates, future-dated rows, UTC period boundaries.
2. End-to-end on dev: create a report in the app → pipeline run → Ready with expected numbers → edit → Queued → Ready; invalid definition → Invalid with reason.
3. Failure drills: kill during publish; Sheets 429; missing rate; empty ledger.
4. Performance: job duration, publish requests/bytes, GAS read latency for Home (8 payloads) and a report.

## Acceptance
- Checklist signed off with measured numbers recorded in the analytics README.
