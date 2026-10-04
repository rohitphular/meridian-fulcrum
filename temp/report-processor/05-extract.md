# 05 — Stage report_master (ledger-sheet-extract)

**Depends on:** 02.

## Steps
1. Add `report_master` to `config.yaml` (enabled) so it is staged with the other tabs.
2. Structure checks already apply (unique headers, `id`, sync cells, valid UUID, known `sync_status`).
3. Acknowledge writes outcomes back to `report_master` sync cells like any other master.
4. `dashboard_layout` is not staged (no sync columns).

## Acceptance
- Unit tests for the new tab; README tab list updated.
