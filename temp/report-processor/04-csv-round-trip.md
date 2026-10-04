# 04 — CSV round trip (ledger-sheet-load)

**Depends on:** 02, 03.

## Goal
`report_master.csv` (predefined + user-defined) and `dashboard_layout.csv` are backed up and restored like the other masters.

## Steps
0. Add `REPORT_MASTER_SHEET` and `DASHBOARD_LAYOUT_SHEET` to `FACTORY_RESET_SHEETS` (deliberately left out in task 02 so a reset cannot lose saved reports before this backup exists); flip the matching assertion in `tests/report-contract.cjs`.
1. GAS import endpoints: `create_reports_bulk` (CSV, by `id`; predefined rows matched by `predefined_key`; unchanged rows skipped) and `update_dashboard_layout` from CSV (or `import_dashboard_layout`). Export from the app (Configure or Reports screen).
2. ledger-sheet-load: add both datasets to `config.yaml` (after categories and accounts, because filters reference their ids), `fill_ids`, dry-run check, sheet-rebuild and sheet-sync modes.
3. Seed file: the predefined catalogue rows (from task 01) ship in the repo's CSV template so a rebuild always recreates them.
4. Update ledger-sheet-load README/runbooks and the Configure/Reports docs.

## Acceptance
- sheet-rebuild from CSV recreates identical report and layout tabs; re-import of an unchanged CSV reports everything unchanged.
