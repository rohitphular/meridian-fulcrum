# 06 — Load report_master (ledger-database-load)

**Depends on:** 01, 05.

## Steps
0. Last step of this task: set `report_master: enabled: true` in ledger-sheet-extract `config.yaml` and flip `test_report_master_is_listed_and_stays_off_until_the_load_can_take_it` — enabling it earlier makes every load fail with `unknown_staged_tab:report_master`.
1. Migration: `report_master` table (columns from task 02; filters as text arrays or text; `record_status`; source UUID unique; created/updated timestamps).
2. `core/source_contracts.py`: add `report_master` headers.
3. Transform + validate with the same whitelist file from task 01 (reject unknown values, incompatible combinations, references to unknown accounts/categories) → `create-failed` / `update-failed` with a `sync_notes` code; valid → upsert, `in-sync`.
4. Predefined rows: validated by `predefined_key` against the catalogue.
5. Order: after accounts and categories.
6. Tests (unit + integration), README/_docs entry, `py_db_schema.toml` updated.

## Acceptance
- A bad definition shows "Invalid: <reason>" in the app after acknowledge; a good one becomes in-sync.
