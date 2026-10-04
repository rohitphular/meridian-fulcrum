# 18 — Docs and cutover

**Depends on:** 17.

## Steps
1. Docs: analytics README + runbooks, data-sync README module table, `expense-tracker/_docs` (reports, home, accounts, rates, data-model, sheet-order, calculations → now describes the job), REWIRE-BRAIN current state, CLAUDE.md task table.
2. Cutover on prod: deploy GAS + frontend together after the first prod publish; seed `report_master.csv` and `dashboard_layout.csv`.
3. Remove the old insights docs (`_docs/insight/*`) or rewrite them for the new contract.

## Acceptance
- Docs match the code; prod Home and Reports served from the published generation.
