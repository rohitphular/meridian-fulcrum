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
| Advisor & insights | `advisor-core.gs`, `insights-core.gs` | LLM advisor endpoint; read pre-computed insight payloads |
| CSV import | `csv-import.gs`, `account-type-import.gs`, `category-import.gs`, `account-import.gs`, `subscription-import.gs`, `transaction-import.gs` | Server-side CSV parsing and validation for every import endpoint (`{ csv, dry_run }`), writing through the entity bulk functions |
| Factory reset | `factory-reset.gs` | `factory_reset_delete_sheets` for `make factory-reset`; see [cicd/README.md](../cicd/README.md#factory-reset-make-factory-reset) |
| Retired | `workflow-engine.gs` | Placeholder only; balances are computed at read time |
| Manifest | `appsscript.json` | GAS runtime config — timezone, V8 engine, web app access |
| clasp link | `.clasp.json` | Links this directory to a GAS project. Committed with `"scriptId": "${SCRIPT_ID_PLACEHOLDER}"`; the real `scriptId` is written by `cicd/deploy.sh` at deploy time and reverted on exit. |

`.clasp.json` holds the Script ID — a public identifier, not a secret. OAuth tokens live in `~/.clasprc.json` and are gitignored.

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

Spreadsheet tab order is configured by `EXPENSE_TRACKER_SHEET_ORDER` in `app-config.gs`. The bound spreadsheet's `onOpen()` handler applies it; **Expense Tracker → Arrange sheet tabs** reapplies it on demand. `ensureExpenseTrackerSheetOrder()` is also available in the Apps Script editor. Missing tabs stay absent, custom tabs retain their relative order at the end, and tab contents/IDs are untouched. See [spreadsheet tab order](../_docs/sheet-order.md) for the sequence and retry behavior.

All master row-number mutations accept `expected_id` and `expected_updated_at`; the frontend sends the UUID and source revision from its current snapshot. A moved row or changed revision returns `stale_record` before writing, preventing stale forms on another device from replacing newer values. Sync acknowledgements do not change the source revision. Legacy callers may omit these checks for compatibility. Script-lock serialization does not prevent external Sheet edits during a request.

Local date/time and decimal validation is shared in `app-utils.gs`. Transactions and account dates are checked against the extraction contracts; subscription schedule helpers use the same DST resolver. Sync and audit metadata are source-owned on every mutation.

`get_computed_insights` rejects historical payloads without `source_contract: "single-leg-master-v1"` as `legacy_insights_contract_requires_upgrade`. The old Python insights producer requires a separate contract migration; its cached metrics are not trusted for the current source model.

Positional Sheet contracts reject unknown trailing columns as well as renamed/reordered headers. Appending missing schema columns remains supported. Extra legacy fields require an explicit migration before either the app or extractor can accept the tab.

Advisor failures expose stable error codes only (`openai_<http_status>`, `invalid_openai_response`, or `fetch_error`). Provider response bodies and caught exception messages are neither returned to clients nor written to logs; successful provider responses must contain nonempty text.
