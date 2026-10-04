# 09 — Mart: flows and balances in XAU

**Depends on:** 08.

## Steps
1. `fact_flow_daily` — UTC date, account, category (major/minor), tx_type, payee, country, city, account currency, local minor units, XAU nanograms (from `tx_amount_base`), count. Exclusions: deleted rows; own-account transfer legs (child, or parent with a live child).
2. `fact_flow_tag_daily` — the same, split equally across a row's distinct tags.
3. `fact_balance_daily` — per account and UTC day: local balance replayed from the opening amount and every non-deleted movement (transfer legs included) after the tracking start; XAU value = local balance ÷ rate on that day (latest rate on or before the day). Liabilities stay negative.
4. Rates: rate lookup helper with "latest on or before"; missing rate → value excluded and the currency recorded as missing for the run.
5. Rows that failed to load (staging outcomes create-failed/update-failed) counted into `run.rows_not_loaded`.
6. Full rebuild per run; indexes on the mart only.
7. Integration tests on a throwaway Postgres with hand-computed expectations (transfers, cross-currency transfers, deletes, tracking start, tags, missing rates, future-dated rows).

## Acceptance
- Mart totals equal hand-computed fixtures; build time measured on dev data.
