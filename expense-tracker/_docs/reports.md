# Reports, Home and Accounts figures

Every figure on the Reports screen, on Home and in the Accounts summary is computed by the **analytics** job (`data-synchronization/analytics`) from PostgreSQL and published to job-owned Sheet tabs. The GAS backend stores report definitions and the Home layout, reads what was published and converts it to the display currency; the browser renders it. Definitions: [calculations](calculations.md).

## What the user sees

- **Reports** has two menus.
  - **Pre-built**: the catalogue in [predefined-reports.json](../../data-synchronization/analytics/contract/predefined-reports.json), grouped as Cash flow, Comparisons, Categories and tags, Net worth and debt, Payees and places. Each report has its periods, tabs (for example Transactions / Accounts), controls (for example Top 10/15/20) and drills. Actions: Open, Customise (opens the builder with a copy named "Copy of …"), Add to Home.
  - **My reports**: reports the user builds. Actions: Open, Edit, Duplicate, Add to Home, Delete (restorable from "Show deleted").
- **Builder**: name (3–60 characters, unique among live reports), optional description (≤ 140), measure, period (+ fixed dates) and compare, time steps, up to two breakdowns, Top N + Other, filters (accounts, categories, tags, payees, currencies, countries, transaction types, amount range in the account's own currency), chart kind. The rules are [report-definition.json](../../data-synchronization/analytics/contract/report-definition.json); GAS, the database load and the job all check them.
- **Status** of a user report: *Queued* (saved, waiting for the next run), *Invalid* (rejected by the sync, with the reason), *Ready · as of <time>*, *Failed* (the job could not compute it, with the code). A result counts only for the definition as last saved.
- **Home**: 4 number tiles (single-number reports) and 4 panels (chart reports), configurable through Customise (change, remove, move, reset to default, save). No click-through and no period switch.
- **Accounts**: the four summary cards and each account's balance come from the published `dataset-accounts-summary` and `dataset-account-balances`; an account added since the last run shows no balance until the next one.
- "As of" times are the publish time shown in the browser's timezone.

## Freshness

Figures change when the analytics job runs `refresh` (the last stage of the consolidated pipeline, or on its own; scheduling is the owner's choice). Until the first publish the app shows "Reports appear after the next refresh". Saving or editing a report never computes it on the spot.

## Where things are

| Concern | Where |
|---|---|
| Report and Home configuration (`report_master`, `dashboard_layout`) | `api/report-core.gs`, `api/report-validation.gs`, `api/dashboard-layout.gs`, `api/view-reports.gs`; CSV round trip through ledger-sheet-load |
| Computation (mart, pre-built reports, user reports) | `data-synchronization/analytics/core/` (`mart.py`, `reports/*.py`, `user_defined.py`) |
| Publishing (two slots, chunks, `report_meta` switch) | `data-synchronization/analytics/core/publish.py`; tabs in [sheet-tabs.json](../../data-synchronization/analytics/contract/sheet-tabs.json) |
| Reading and conversion | `api/report-store.gs` (`get_report`, `get_home_view`, Accounts datasets) |
| Payload shape | [report-payload.md](../../data-synchronization/analytics/contract/report-payload.md) |
| Screens | `app/sections/reports.js`, `app/sections/reports/*`, `app/sections/home.js`, `app/sections/accounts.js` |
