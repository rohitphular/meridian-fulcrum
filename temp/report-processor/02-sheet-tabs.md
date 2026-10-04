# 02 — Sheet tabs and schemas

**Depends on:** 01.

## Goal
Define every new tab, its owner and its columns.

## Tabs
1. **`report_master`** (owner: app via GAS; synced like the other masters)
   - `id` (UUID), `report_type` (predefined | user_defined), `predefined_key` (predefined only), `report_name` (≤ 60, hard limit), `report_description` (≤ 140, optional)
   - `measure`, `period_preset`, `period_from`, `period_to`, `compare_mode`, `time_grain`, `group_by_1`, `group_by_2`, `top_n`, `include_other`
   - `filter_account_ids`, `filter_categories`, `filter_tags`, `filter_payees`, `filter_currencies`, `filter_countries`, `filter_tx_types`, `filter_amount_min`, `filter_amount_max`
   - `chart_kind`
   - `record_status` (active, inactive, deleted, locked — predefined rows are `locked`)
   - `created_at`, `updated_at`, `sync_status`, `sync_date`, `sync_notes`
2. **`dashboard_layout`** (owner: app via GAS; no sync columns — display configuration only)
   - 8 rows: `slot` (tile_1…tile_4, panel_1…panel_4), `report_id` (a `report_master` id or blank), `updated_at`.
3. **Job-owned output tabs** (owner: analytics; GAS read-only; never edited by hand)
   - `report_meta` — one row: `active_slot` (a|b), `generation_id`, `published_at` (UTC), `contract_version`, `source_watermark`, `reports_ok`, `reports_failed`, `rows_not_loaded`, `missing_currencies`.
   - `report_index_a`, `report_index_b` — `report_id`, `variant_key`, `first_row`, `row_count`, `payload_hash`.
   - `report_data_a`, `report_data_b` — `report_id`, `variant_key`, `chunk_no`, `payload_chunk` (≤ 45,000 chars per cell, RAW).
   - `report_status` — `report_id`, `definition_updated_at`, `status` (ready | failed), `error_code`, `published_at`.
4. **`rates`** — becomes job-owned (task 07).

## Steps
- Add the tab constants and `EXPENSE_TRACKER_SHEET_ORDER` entries (`api/app-config.gs`, `api/sheet-order.gs`).
- Factory reset: add `report_master` and `dashboard_layout` (CSV-backed, rebuilt by ledger-sheet-load) and the output tabs (recomputed by the job).
- Retire the legacy `computed_insights` tab (constant, sheet order, factory reset, docs).
- Document the job-owned tabs as an exception to the `getOrCreateSheet` rule: GAS reads them with `getSheetByName` + `sheetToObjects` and treats a missing tab as "not published yet".

## Acceptance
- `_docs/sheet-order.md`, `_docs/data-model.md` and `api/README.md` list every tab with its owner; factory-reset tests cover the new lists.
