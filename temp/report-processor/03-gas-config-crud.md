# 03 — GAS: report and layout configuration

**Depends on:** 01, 02.

## Goal
GAS stores and validates configuration only. No calculation.

## Steps
1. `report-schema.gs`, `report-validation.gs`, `report-core.gs` (follow the account-type/category file pattern):
   - Validate against `report-contract.gs` before any write: allowed values, compatibility rules, name required/trimmed/≤ 60/unique case-insensitive among non-deleted, description ≤ 140, filter values well-formed (UUIDs, known category keys, etc.).
   - POST actions: `create_report`, `update_report`, `delete_report` (tombstone), `restore_report`, `duplicate_report` ("Copy of …", numbered to stay unique and ≤ 60).
   - Predefined rows (`report_type = predefined`) are `locked`: no edit or delete through the app.
   - `sync_status` via `computeSyncStatus` (create-pending / update-pending); stale-record check with `expected_id` + `expected_updated_at`; manual Sheet edits marked pending by the existing `onEdit` pattern.
2. `dashboard-layout.gs`:
   - GET `get_dashboard_layout`; POST `update_dashboard_layout` (all 8 slots at once).
   - Validate: tiles accept only reports that produce a single number; panels accept any active report; no report twice; unknown or deleted ids rejected. Deleting a report clears its slot.
   - Default layout seeded on first read (net worth, assets, liabilities, monthly income / income trend, debt to income, net worth trend, spending by category).
3. GET `list_reports_view` — returns configuration rows grouped into Pre-built and My reports, each with its status from `report_status` + `sync_status` (Queued, Invalid + reason, Ready + published_at, Failed + reason). Reading status is not a calculation.
4. Messages for every new error code (`_VM_MESSAGES`); router data-version bump unchanged.
5. Node tests for validation, CRUD, duplicate naming, locked predefined rows, layout rules.

## Acceptance
- All config endpoints covered by tests; no code path in these files aggregates ledger data.
