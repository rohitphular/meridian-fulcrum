# 11 — User-defined report compiler

**Depends on:** 01, 06, 09.

## Steps
1. Read active, in-sync `report_master` rows of type `user_defined` from PostgreSQL (never from the Sheet).
2. Validate again with the whitelist; failures go to `report_status` as `failed` + code (never back into `report_master`).
3. Compile to parameterised SQL over the mart (no raw SQL from users): measure → aggregate; time grain → UTC buckets; group-bys; filters; period + compare; top_n + Other.
4. Enforce limits (series, points, rows); a breach fails that report with a clear code.
5. Build the payload for the chosen `chart_kind` (single-number reports produce a tile payload).
6. Key the result by `report_id` + `updated_at` so an edited report is recomputed and its status reflects the new definition.

## Acceptance
- Tests for every measure × grain × group-by combination that the contract allows, and for each limit.
