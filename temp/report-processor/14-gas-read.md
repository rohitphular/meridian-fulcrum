# 14 — GAS read layer

**Depends on:** 02, 03, 07, 12.

## Steps
1. `report-store.gs`: read `report_meta` (one small range), the active index (cached by `generation_id`), then only the rows for the requested report and variant; join chunks; parse.
2. Convert XAU → display currency: multiply every value whose `format` is money by `rate[quote]` from the `rates` tab. Nothing else is computed.
3. Envelope: `published_at` (UTC), `generation_id`, `quote`, warnings (missing rate, not published yet, report failed).
4. Cache key includes `generation_id` (no POST needed to invalidate after a publish).
5. Actions: `get_report` (id + variant), `get_home_view` (layout + the 8 payloads), `list_accounts_view` summary/balances from the published Accounts datasets (rows/filters/paging stay as today).
6. Tests with fixture tabs: missing tab, active-slot flip, chunk join, conversion, missing rate.

## Acceptance
- Read latency measured on dev; no aggregation code in these files.
