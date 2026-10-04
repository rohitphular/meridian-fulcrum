# 10 — Predefined reports, Home and Accounts datasets

**Depends on:** 01, 09.

## Steps
1. Port the 30 insights to Python against the mart, producing the payload contract in XAU, for every variant in the catalogue (period presets anchored to the run's UTC date, tabs, windows, top_n computed per value so "Other" stays correct).
2. Aggregate drills precomputed (e.g. net worth by account at a month end, tag × month, category → sub-category). Transaction-list drills only carry a `drill.query` for `list_transactions_view`.
3. Home number tiles: net worth, total assets, total liabilities, total debt, monthly income (average of complete months), annualised income, spending this month, savings rate, debt to income (+ status band), liquid cash, debt-free estimate, recurring payments per month.
4. Accounts datasets: current balance per account (local and XAU), per-type totals, summary cards (assets, liabilities, net worth, liquid cash).
5. Unit tests per report with fixed fixtures and expected payloads.

## Acceptance
- Every catalogue entry and variant produces a valid payload; sizes and counts logged per run.
