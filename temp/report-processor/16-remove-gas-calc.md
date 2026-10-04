# 16 — Remove calculations from GAS

**Depends on:** 14, 15 (reports served from the job everywhere).

## Steps
1. Delete the compute code in `insights-cashflow.gs`, `insights-categories.gs`, `insights-comparisons.gs`, `insights-counterparty-geo.gs`, `insights-networth.gs`; reduce `insights-registry.gs` to nothing (catalogue now in the contract).
2. `view-home.gs` and the summary part of `view-accounts.gs`: read published datasets only.
3. `ledger-core.gs` and `fx-utils.gs`: keep only what input validation needs (transaction balance check in `transaction-validation.gs`, transfer pairing for lists); delete the rest.
4. Advisor (`advisor-core.gs`) builds its snapshot from published datasets instead of its own calculation.
5. Delete the matching node tests; keep and adapt validation tests.
6. Standards note (meridian-building-standards): GAS reads job-owned tabs; calculations live in data-sync jobs.

## Acceptance
- `grep` finds no aggregation helpers in `api/` outside validation; node suite green.
