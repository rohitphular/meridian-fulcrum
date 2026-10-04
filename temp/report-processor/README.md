# Report processor — task list

Move every calculation out of the GAS API into a new data-sync module, `analytics`.
The module reads PostgreSQL, computes pre-built and user-defined reports (plus the Home and
Accounts figures) in XAU, and publishes them to job-owned tabs in the Sheet. GAS only stores
configuration, reads the published results and converts XAU to the display currency.
The frontend only renders.

Work through the tasks in order; each one lists what it depends on.

## Decisions (agreed)

| # | Decision |
|---|---|
| D1 | **Freshness** — owner schedules runs later. The module runs as consolidated-pipeline stage 6 and on its own. |
| D2 | **Currency** — every amount is computed and published in XAU (grams). Flows use the rate on the transaction date (Postgres `tx_amount_base`); balances and net worth convert the local balance at the snapshot date's rate. Latest rates are published from PostgreSQL to the Sheet `rates` tab by forex-database-load (mode `publish-sheet`); GAS converts XAU → display currency with it (one multiplication per money value). |
| D3 | **Dates** — everything is UTC: transaction buckets use the UTC date of `tx_date_time_base`, periods are anchored to the UTC date of the run, `published_at` is a UTC ISO timestamp. The browser only formats `published_at` in the local timezone. |
| D4 | **Validation** — GAS validates report and layout input before any write (repo rule); ledger-database-load and the job validate again. |
| D5 | **Accounts screen** — summary cards, per-type totals and current balances move to the job too. GAS stays as thin as possible. |
| D6 | **Backup** — one `report_master` CSV holds predefined and user-defined reports (`report_type`); it is part of the ledger-sheet-load CSV round trip like the other masters. |
| D7 | **Home** — one configurable dashboard: 4 number tiles (1×4) above 4 report panels (2×2). Panels show the report's saved period; no click-through, no period switch. |
| D8 | **Reports UI** — menu with Pre-built and My reports. User reports: create, edit, duplicate, delete, add to Home. Name: hard limit 60 characters, unique (case-insensitive) among non-deleted reports; description optional. |
| D9 | **Amount filter** — `filter_amount_min` / `filter_amount_max` are in the account's own currency. |

## Consequences to keep in mind

- Numbers will **not** match today's live insights: today GAS converts every date at the current rate and buckets by the local wall date. That is intended (D2, D3); do not build parity against the old GAS output.
- Reports refresh only when the job runs. The UI shows "Queued" until then and "As of <local time>" afterwards.
- Transaction drill-downs stay as `list_transactions_view` filters (they select rows; they do not calculate). Aggregate drills are precomputed.
- The `rates` tab becomes job-owned: manual rate editing in the app goes away.

## Tasks

| # | Task | Area |
|---|---|---|
| 01 | [Contracts](01-contracts.md) — done | shared |
| 02 | [Sheet tabs and schemas](02-sheet-tabs.md) — done | expense-tracker |
| 03 | [GAS: report and layout configuration](03-gas-config-crud.md) — done | expense-tracker/api |
| 04 | [CSV round trip (ledger-sheet-load)](04-csv-round-trip.md) — done | data-sync |
| 05 | [Stage report_master (ledger-sheet-extract)](05-extract.md) — done (enabled in 06) | data-sync |
| 06 | [Load report_master (ledger-database-load)](06-load.md) — done | data-sync |
| 07 | [Sync rates to the Sheet](07-rates-to-sheet.md) — done (shared lib push + relock pending) | data-sync + api |
| 08 | [analytics module skeleton](08-analytics-skeleton.md) — done | data-sync |
| 09 | [Mart: flows and balances in XAU](09-mart.md) — done | analytics |
| 10 | [Predefined reports, Home and Accounts datasets](10-predefined.md) — done | analytics |
| 11 | [User-defined report compiler](11-user-defined.md) — done | analytics |
| 12 | [Publisher](12-publisher.md) — done (fake client only) | analytics |
| 13 | [Pipeline integration](13-pipeline.md) — done (example config; dev run pending) | consolidated-pipeline |
| 14 | [GAS read layer](14-gas-read.md) — done (dev latency pending deploy) | expense-tracker/api |
| 15 | [Frontend](15-frontend.md) — done | expense-tracker/app |
| 16 | [Remove calculations from GAS](16-remove-gas-calc.md) — done | expense-tracker/api |
| 17 | [Verification](17-verification.md) — done except the deploy-dependent checks | all |
| 18 | [Docs and cutover](18-docs-cutover.md) — docs done; cutover is yours | all |

## Status and deviations (kept current)

| Task | Status | Deviations from the task file |
|---|---|---|
| 01–02 | done | Added `sheet-tabs.json`; `chart_kind = number` decides Home tiles; pre-built insights drop custom ranges |
| 03 | done | Views not cached (statuses come from a job-owned tab); Customise has no server action |
| 04 | done | CSVs carry business columns + `record_status` only (also applied to account_types and detail CSVs) |
| 05–06 | done | A failed `report_master` row does not fail the load |
| 07 | done | Paced Sheets client moved to `py-google-workspace` (needs the library push) |
| 08 | done | `source_table_missing:<table>` precondition; `report_result` table |
| 09 | done | Mart kept **in memory** (read once inside the build snapshot) instead of mart tables: the ledger is small (dev: 609 tx). Flows at transaction grain (a superset of daily). Tracking start converted with zoneinfo (DST gap resolves forward). Current balance includes future-dated rows; history does not. Country aliases live only in `core/places.py` |
| 10 | done | All 46 catalogue entries in `core/reports/*` (ported from `insights-*.gs`, `view-home`, `view-accounts`). Query drills carry `queries[]` in the base payload (no variants); panel/replace drills are variants for the default tab and controls only. Mart gained `movements` (loan credits for 26). Payload doc: drill modes, `local` format, number reports. Dev build: 46 ready, 0 failed, **1,100 payloads, 2.24 M chars, largest 14.6 K** (22-top-counterparties 305 variants, 23 173, 11 145), 0.6 s |
| 11 | done | Compiled from the in-memory mart, not SQL (nothing typed by a user reaches a query). Re-validation is the contract rules on typed values in `core/user_defined.py` (the loader's module is not imported). Two group-bys: with a grain, series = pairs; ranked bars = bars × stacked segments; table = rows. Compare ranks on the current period; a compare line only without groups. Stock measures use current balances on/after the anchor (a Net worth tile equals the pre-built one). `too_many_series` is unreachable with today's limits (top N ≤ 20 + Other = 21). Also fixed in 10: paydown/loan/debt-free compare owed amounts at the anchor rate; `payload.validate` checks Text in cells and drills. Dev: 0 user reports yet |
| 12 | done | `core/publish.py` + `sheets/report_sheets.py` (gspread adapter; needs the `SheetsRequests` library push). Each tab is resized to the exact grid (no stale rows), header + rows in ≤ 1.5 M-char requests; `report_meta` is one write, last. Skip rule: same anchor date + contract version + source watermark as the live generation (refresh only; `publish` forces). Publish takes the job lock. Dev estimate: 1,100 payloads, 2.24 M chars, all single-chunk, ≈ 13 requests (≈ 16 s paced). **Tested with a fake client only** |
| 13 | done | `pipeline.example.json`: `forex-database-load publish-sheet` after `daily`, `analytics refresh` last. Your local `pipeline.dev.json` / `pipeline.prod.json` are **not** changed (publish-sheet replaces hand-entered rates — waiting item 4). Monitor: forex publish-sheet card (rates written, newest rate) and analytics card (reports ok/failed, rows not loaded, missing currencies, published, slot, requests + per-report variants). A dev pipeline run waits on the library push |
| 14 | done | `report-store.gs`: `get_report`, `get_home_view` (replaces the computed Home; `home-view-backend.cjs` removed, `view-home.gs` keeps only `vwHomeDtiStatus` until 16). GAS builds the variant key from period/tab/controls/drill (Python `quote()` encoding). Registry `cache: 'published'` adds the live generation id to the cache key. Index cached per report per generation (`putAll`); payload text cached per generation. `list_accounts_view` balances/cards = published datasets (no ledger read; group totals still sum the converted rows of the filter). Cross-language fixture `analytics/contract/fixtures/payload-conversion.json` (Python writes it + the money paths; GAS converts it). **Read latency on dev not measured** (needs deploy). 2 home.js frontend tests fail until task 15 |
| 15 | done | Reports (Pre-built / My reports, builder, viewer with period/tab/control pickers and panel/replace/query drills), configurable Home (Customise: picker, remove, move, reset, save), Accounts with published balances. Gaps closed in the backend after review: `list_reports_view` sends each pre-built report's periods; `get_dashboard_layout` sends `default_slots`; query drills carry `range: custom` (or `all`); `13-tag-trend` no longer lists a `tag+month` drill (never published); Accounts group totals are `null` until published. Open: `23-recurring-payments` is marked sortable in the catalogue but no sort UI or sorted variants exist; builder defaults are the first schema option of each list; "Add to Home" fills the first empty slot of the right kind |
| 16 | done | Deleted `insights-*.gs` (6), `view-home.gs` and their tests; `get_app_context` drops `nav.insights_registry`; ledger-core keeps only date keys, periods, wall-date filters, transfer pairing and the tracking-start cutoff (validation); `vmLedger` and the computed `accounts` dataset are gone; advisor snapshot = published figures. Standards: APP-BE-GSCRIPT gains the job-owned-tab exception and "calculations live in data-sync jobs" |
| 17 | partly | Goldens (`test_goldens.py`: cross-currency, future rows, UTC month boundary, missing rate, tag split, empty ledger), failure drills with fakes, dev build/publish sizes: recorded in `analytics/README.md` § Verification. **Pending deploy:** end-to-end in the app, GAS read latency, real Sheets publish/429 |
| 18 | docs done | `_docs/reports.md` (new), `calculations.md` (job definitions, UTC, XAU, what changed), `_docs/insight*` removed, README/overview/accounts/transactions/balance-lifecycle wording, payload contract inlines Chart/Table/FORMAT (the GAS header it cited is gone), REWIRE-BRAIN "Report processor" section + deploy order, workspace CLAUDE.md task rows, standards note. **Cutover (prod deploy, seeding `report_master.csv` / `dashboard_layout.csv`) is yours** |
| review | done | Final review fixes: GAS drops tab/controls when a drill is requested (drill variants exist only for the defaults); every Transactions query carries `range` (loan and daily-spend drills fixed); 25-spend-by-city drills to Transactions (was a panel with no variant); guards in `test_predefined.py` for query params and for panel/replace drills having variants; the two-rate test now fails against the old debt-free code |

### Waiting on the user (work continues with fakes meanwhile)

1. Commit + push `meridian-common-libs` (`SheetsRequests`), then `make upgrade-libs` in forex-database-load, ledger-sheet-extract and analytics.
2. Add `FDL_SERVICE_ACCOUNT_FILE` and `ANA_SERVICE_ACCOUNT_FILE` to `infrastructure/.env.dev` / `.env.prod`.
3. Deploy GAS and the frontend (tasks 03, 04, 07, 14, 15, 16).
4. Before the first `forex-database-load publish-sheet`: it replaces hand-entered rates in the `rates` tab. Then add the two new stages to your `pipeline.<env>.json` (see `pipeline.example.json`).
