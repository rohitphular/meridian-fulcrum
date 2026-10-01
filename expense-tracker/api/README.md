# Expense Tracker — Backend

Apps Script backend, edited locally via [clasp](https://github.com/google/clasp). No browser editor required.

## Folder contents

Source is split into per-domain `.gs` modules. GAS flattens them all into one namespace at runtime.

| Group | Files | Purpose |
|---|---|---|
| App | `app-auth.gs`, `app-config.gs`, `app-router.gs`, `app-utils.gs`, `sync-utils.gs` | Auth, config, HTTP routing, shared helpers, sync-status helpers |
| Sheet layout | `sheet-order.gs`, `master-migration.gs` | Arrange existing tabs on spreadsheet open or through the Expense Tracker menu; one-time `migrateMasterSheetNames()` |
| Account types | `account-type-core.gs`, `account-type-schema.gs`, `account-type-utils.gs`, `account-type-validation.gs`, `account-type-migration.gs` | Sheet-owned classification catalog: list, edit, soft-delete/restore, CSV import and legacy key migration |
| Accounts | `account-core.gs`, `account-schema.gs`, `account-utils.gs`, `account-validation.gs` | Account CRUD, schema, validation |
| Transactions | `transaction-core.gs`, `transaction-schema.gs`, `transaction-utils.gs`, `transaction-validation.gs`, `transaction-suggestions.gs` | Transaction CRUD, schema, validation, entry suggestions |
| Categories | `category-core.gs`, `category-schema.gs`, `category-utils.gs`, `category-validation.gs` | Category CRUD, schema, validation |
| Import | `import-core.gs`, `import-registry.gs` | Account master/detail CSV validation and ID-based replacement |
| Subscriptions | `subscription-core.gs`, `subscription-schema.gs`, `subscription-utils.gs`, `subscription-validation.gs` | Recurring obligations and schedule calculation |
| Rates | `rate-core.gs`, `rate-schema.gs`, `rate-validation.gs` | FX rate CRUD, schema, validation |
| Advisor | `advisor-core.gs` | LLM advisor endpoint |
| View foundations | `get-registry.gs`, `view-context.gs`, `view-cache.gs`, `fx-utils.gs`, `ledger-core.gs` | GET action registry (router delegates unknown actions here); request context (`quote_currency`, `tz`, `today`), envelopes and per-request dataset; CacheService by `data_version`; currency conversion; balance replay, periods and transfer pairing |
| Views | `view-config.gs`, `view-home.gs`, `view-transactions.gs`, `view-accounts.gs`, `view-config-lists.gs`, `view-subscriptions.gs`, `view-categories.gs` | Ready-to-render view models, form options and exports for each screen (see [View GETs](#view-gets)) |
| Insights | `insights-registry.gs`, `insights-cashflow.gs`, `insights-comparisons.gs`, `insights-categories.gs`, `insights-networth.gs`, `insights-counterparty-geo.gs` | `get_insight`: registry, dispatcher, shared `ins*` helpers and one compute function per insight |
| CSV import | `csv-import.gs`, `account-type-import.gs`, `category-import.gs`, `account-import.gs`, `subscription-import.gs`, `transaction-import.gs` | Server-side CSV parsing and validation for every import endpoint (`{ csv, dry_run }`), writing through the entity bulk functions |
| Factory reset | `factory-reset.gs` | `factory_reset_delete_sheets` for the [ledger-sheet-load](../../data-synchronization/ledger-sheet-load/README.md) job's sheet-rebuild mode; `fill_csv_ids` (csv-import.gs) for both modes |
| Retired | `workflow-engine.gs` | Placeholder only; balances are computed at read time |
| Manifest | `appsscript.json` | GAS runtime config — timezone, V8 engine, web app access |
| clasp link | `.clasp.json` | Links this directory to a GAS project. Committed with `"scriptId": "${SCRIPT_ID_PLACEHOLDER}"`; the real `scriptId` is written by `cicd/deploy.sh` at deploy time and reverted on exit. |

`.clasp.json` holds the Script ID — a public identifier, not a secret. OAuth tokens live in `~/.clasprc.json` and are gitignored.

## View GETs

The frontend is a pure renderer: every screen reads a view GET that returns converted, aggregated, filtered, sorted and paged data with display labels and per-row `allowed_actions`. Definitions (net worth, flow exclusions, periods): [calculations](../_docs/calculations.md).

- Register new GET actions only in a view file's hook (`view<Name>Register(actions)`, called by `grGetActions()` in `get-registry.gs`); never in the router's if-chain.
- Every view accepts `quote_currency` (default GBP), `tz` (IANA, default Europe/London) and optional `today` (validated `YYYY-MM-DD`). The client sends the first two automatically (`ExpenseAPI.view`).
- Success: `{ ok: true, data_version, computed_at, quote: { currency, symbol, rate_available }, warnings: [{ code: 'missing_rate', currencies }], data }`. Failure: `{ ok: false, error, field?, message?, details? }`.
- `cache: true` actions are stored in CacheService (≤ 600 s) under `data_version` + action + all params; payloads over 90 KB are not cached. `data_version` changes after every successful POST and on manual Sheet edits.

| Action | File | Params | Cached |
|---|---|---|---|
| `get_app_context` | `view-config.gs` | — | yes |
| `get_home_view` | `view-home.gs` | — | yes |
| `list_transactions_view` | `view-transactions.gs` | `range` (`last_30` … `all`, `custom` + `from`/`to`), `types`, `account_ids`, `account_types`, `major`, `minor` (CSV), `user_location_country`/`_city`/`_area`, `tag`, `counterparty`, `search`, `sort_col`, `sort_dir`, `page`, `page_size` (10/25/50) | yes |
| `get_transaction_facets` | `view-transactions.gs` | — (filter-bar options, ranges, sort columns, page sizes; kept out of list pages to stay under the cache cap) | yes |
| `get_transaction` | `view-transactions.gs` | `id` | yes |
| `get_transaction_form_options` | `view-transactions.gs` | `mode` (`create`/`edit`), `id` | yes |
| `get_transaction_prefill` | `view-transactions.gs` | `mode` (`copy`/`subscribe`), `id` | yes |
| `export_transactions` | `view-transactions.gs` | the list filters | no |
| `list_accounts_view` | `view-accounts.gs` | `type`, `sub_type`, `currency`, `search`, `statuses`, `sort`, `dir`, `page`, `page_size` | yes |
| `get_account_form_options` | `view-accounts.gs` | `id` | yes |
| `export_accounts` | `view-accounts.gs` | — (every account, all statuses, account_master columns) | no |
| `list_rates_view` | `view-config-lists.gs` | `search`, `sort`, `dir` | yes |
| `list_account_types_view` | `view-config-lists.gs` | `search`, `status`, `type`, `sort`, `dir` | yes |
| `export_account_types` | `view-config-lists.gs` | — (whole catalog in the 13 import columns, `requires_migration`) | no |
| `list_subscriptions_view` | `view-subscriptions.gs` | `statuses`, `major`, `frequency`, `search`, `sort_col`, `sort_dir`, `page`, `page_size` | yes (300 s) |
| `get_subscription_estimate` | `view-subscriptions.gs` | `ids` (csv UUIDs, `none`, or blank = all active): monthly payments / income / net for the chosen subscriptions | yes (300 s) |
| `get_subscription_form_options` | `view-subscriptions.gs` | `id` | yes |
| `list_categories_view` | `view-categories.gs` | `type`, `major`, `minor`, `search`, `statuses`, `sort_col`, `sort_dir`, `page`, `page_size` | yes |
| `get_category_form_options` | `view-categories.gs` | — | yes |
| `get_insight` | `insights-registry.gs` | `id`, `period` (+ `from`/`to`), `tab`, `drill` (JSON), insight params (`window`, `top_n`, `sort`, `sort_dir`, `compare`) | yes |

Raw GETs kept outside the registry: `verify`, `get_advisor_history`, `get_suggested_transactions`; `list_transactions`, `list_categories`, `list_accounts`, `list_subscriptions` (used by the ledger-sheet-load job's sheet-rebuild mode to recreate tabs); `list_account_types` and `list_rates` (the previous frontend's refresh — remove once the current frontend is deployed everywhere); `get_account_schema` (router test). The `get_*_schema` (other than accounts), `get_transaction_metadata` and `get_computed_insights` routes were removed: schemas travel in `get_app_context`, filter suggestions in `get_transaction_facets`.

## Where the IDs live

Each environment's Script ID, Deployment ID, and `/exec` URL live in `cicd/envs.json`. See `cicd/README.md` for the env model.

## One-time setup

```bash
npm install -g @google/clasp
clasp login                # opens browser; tokens cached in ~/.clasprc.json
```

## Daily commands

From the repository root:

```bash
bash expense-tracker/cicd/deploy.sh dev "expense-tracker: change description"
bash expense-tracker/cicd/logs.sh dev
node --test expense-tracker/tests/*.cjs
```

Use the deployment wrapper for source pushes and version promotion. It injects the environment's Script ID and restores `${SCRIPT_ID_PLACEHOLDER}` even on failure. Do not hand-edit `.clasp.json` or invoke `clasp push` / `clasp deploy` directly.

## Shipping a change

The canonical deploy path is:

```bash
bash expense-tracker/cicd/deploy.sh        # from repository root; pick env
```

This dispatches to `cicd/deploy.sh` which handles env-scoped `scriptId` writing, clasp push, clasp deploy, and placeholder revert.

The deploy is **backend-only** — git operations are NOT performed. Commit and push manually when you're ready to record state in git.

See `cicd/README.md` for the full pipeline detail.

## Validate in the dev environment

Run the regression suite, deploy through `expense-tracker/cicd/deploy.sh dev`, and open the locally served frontend (which selects the dev `/exec` endpoint). Verify the changed flow there before deploying prod. The dev and prod environments have separate registered IDs; neither needs a manual `.clasp.json` or frontend URL edit.

## Source integrity

Spreadsheet tab order is configured by `EXPENSE_TRACKER_SHEET_ORDER` in `app-config.gs`. The bound spreadsheet's `onOpen()` handler applies it; **Expense Tracker → Arrange sheet tabs** reapplies it on demand. `ensureExpenseTrackerSheetOrder()` is also available in the Apps Script editor, and over HTTP as the PIN-protected POST action `arrange_sheet_tabs` (used as the last step of the ledger-sheet-load job; it takes its own script lock, so the router runs it before the POST lock). Missing tabs stay absent, custom tabs retain their relative order at the end, and tab contents/IDs are untouched. See [spreadsheet tab order](../_docs/sheet-order.md) for the sequence and retry behavior.

All master row-number mutations accept `expected_id` and `expected_updated_at`; the frontend sends the UUID and source revision from its current snapshot. A moved row or changed revision returns `stale_record` before writing, preventing stale forms on another device from replacing newer values. Sync acknowledgements do not change the source revision. Legacy callers may omit these checks for compatibility. Script-lock serialization does not prevent external Sheet edits during a request.

Local date/time and decimal validation is shared in `app-utils.gs`. Transactions and account dates are checked against the extraction contracts; subscription schedule helpers use the same DST resolver. Sync and audit metadata are source-owned on every mutation.

Insights are computed on request by `get_insight`. The old `get_computed_insights` route and `insights-core.gs` were removed; the Python job under `job/` that filled the `computed_insights` tab is documented as incompatible with the current source model and nothing reads that tab any more.

Positional Sheet contracts reject unknown trailing columns as well as renamed/reordered headers. Appending missing schema columns remains supported. Extra legacy fields require an explicit migration before either the app or extractor can accept the tab.

Advisor failures expose stable error codes only (`openai_<http_status>`, `invalid_openai_response`, or `fetch_error`). Provider response bodies and caught exception messages are neither returned to clients nor written to logs; successful provider responses must contain nonempty text.
