# 15 — Frontend

**Depends on:** 03, 14. Follows the agreed mockups.

## Steps
1. **Reports section** with a menu: Pre-built | My reports.
   - Pre-built: grouped catalogue; Open, Customise, Add to Home. Customise has no server action: it opens the builder with "Copy of <title>" and default options (pre-built logic is not expressible as a definition).
   - My reports: list with status (Queued, Invalid: reason, Ready · as of <local time>, Failed: reason); Open, Edit, Duplicate, Add to Home, Delete (inline confirm; warns if on Home).
2. **Builder** (create/edit): name (hard 60 + counter, required, unique), optional description, measure, period + compare, time grain, up to 2 group-bys, top N + Other, filters (field + value chips), chart kind; incompatible options disabled from the schema GAS returns; sample preview clearly labelled; Save → Queued.
3. **Report viewer**: renders the payload with the existing `renderInsightPayload`; shows "As of" in the browser's timezone from `published_at`.
4. **Home**: 4 number tiles (1×4) + 4 panels (2×2), Customise mode (change via searchable picker, remove, move, reset to default, save/cancel); tiles accept single-number reports only; no click-through, no period switch; mobile: tiles 2×2, panels stacked.
5. **Accounts**: summary cards and balances from the published datasets.
6. Rates screen read-only (task 07).
7. Follow FE rules: `esc()`, `el()`, `et:reload` after mutations, no logic in the browser, no hard-coded enums (read from the schema GAS returns).
8. Frontend tests for builder rules, statuses, layout editing, name limit.

## Acceptance
- Matches the mockups; all FE tests pass; no calculation in `app/`.
