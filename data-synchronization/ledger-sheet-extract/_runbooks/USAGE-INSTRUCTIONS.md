# ledger-sheet-extract usage

The [README](../README.md) is the current behaviour and storage contract. [`_docs/`](../_docs/README.md) contains current entity mappings and explicit extraction gaps.

## Prerequisites

The four master tabs must be named `account_master`, `category_master`, `transaction_master` and `subscription_master`. For legacy plural tab names, deploy the updated expense-tracker backend and run `migrateMasterSheetNames()` once in the bound Apps Script editor before extraction. See [the full upgrade procedure](../../../expense-tracker/_docs/master-sheet-names.md). The corresponding database tables already have these names, and the renamed local CSVs preserve all data.

- Python 3.12+, uv, and SSH access to the private shared-library Git sources.
- A reachable PostgreSQL database with the currency-rates migrations applied and rates covering your account snapshots and transaction dates. Ledger migrations depend on those tables.
- A Google service account with Sheets write access and Drive metadata read access to the selected spreadsheet. Acknowledgements update only sync metadata.
- `cicd/envs.json` configured for dev/prod. The selected spreadsheet ID is exported as `LE_SPREADSHEET_ID` after loading the environment file, so a stale value in that file cannot override the selected Sheet.
- Secrets in `meridian-fulcrum/infrastructure/.env.dev` or `.env.prod` (not the repository root).

| Variable | Use |
|---|---|
| `FULCRUM_DB_HOST`, `FULCRUM_DB_PORT` | Database address; both required |
| `FULCRUM_DB_USER`, `FULCRUM_DB_PASSWORD`, `FULCRUM_DB_NAME` | Database credentials/name |
| `LE_SERVICE_ACCOUNT_FILE` | Service-account JSON key file path |
| `MERIDIAN_LOG_ROOT` | Shared logger output directory |
| `LE_SPREADSHEET_ID` | Set by launcher from `cicd/envs.json`; required when invoking Python directly |

## Running and reprocessing

```bash
# From the module directory
make run ENV=dev                     # asks for the sync mode
make run ENV=dev MODE=normal-sync
bash cicd/start-up.sh prod normal-sync

# After reviewing dependencies and data, replay existing in-sync rows as well:
bash cicd/start-up.sh dev hard-sync
```

From the repository root, `make data-sync` asks for the module and environment; the launcher then asks for the sync mode unless one was passed:

- **normal-sync:** runs without `--reprocess`. Processes pending/failed rows and recovers missing database identities; existing `in-sync` master and six metadata-bearing detail records are skipped.
- **hard-sync:** adds `--reprocess`, including existing `in-sync` master/detail records in enabled entities. Detail current valuations can then use corrected/backfilled rates. Uses the same UUID-preserving validation and upserts; it does not truncate tables or infer deletions from absent Sheet rows.

An invalid or empty mode selection exits before dependencies, migrations or the job run. Scheduled or scripted runs pass the mode explicitly (`normal-sync` or `hard-sync`) so nothing waits for input. Startup uses the lockfile, applies pending ledger migrations and runs extraction. Updating shared libraries is an explicit `make upgrade-libs` maintenance step, followed by tests.

Migration 0014 must precede the updated account/category code. It renames account-type reference keys, adds display labels and preserves UUIDs and existing links. The launcher applies it automatically in either sync mode; hard-sync is not required for this schema change.

Migration 0015 must also precede the updated account/detail code. It added source fields to the historical detail schema; startup applies it even when detail tabs are disabled.

Migration 0016 adds/checks lifecycle status for the six detail sources using sync metadata. Before enabling those tabs, deploy expense-tracker, complete the property-column migration below if needed, then run `migrateAccountDetailMetadata()` once in the Apps Script editor; it upgrades existing tabs only. The importer also initializes its target tab. Repeated helper calls preserve already initialized metadata. See [source upgrade and import ownership](../_docs/account-details.md#existing-tabs-and-csv-imports).

For an existing property Sheet with `evaluation_currency_rate_id`, deploy and run `migrateAccountPropertyRateColumn()` before import or extraction. It validates the old layout, removes the retired column, preserves the adjacent address/metadata fields and queues rows. Then use **hard-sync once** so existing property valuations follow the evaluation date rather than an old explicit rate reference. Subsequent runs can use normal-sync. The historical DB field remains retained but unused.

Migration 0017 preserves signed asset/investment opening snapshots and retains nonpositive liability constraints. Startup applies it without changing existing amounts or UUIDs. Previously failed negative asset/investment rows retry normally.

Migration `0018` is required by the renamed-table extractor and applies on the next `make data-sync` run. It preserves supported detail records/UUIDs/audit/history, creates separate mortgage and personal-loan tables, and **drops fixed-income/P2P detail tables and their contents**. Account masters and subtype definitions remain. Ambiguous legacy loan classification stops the whole migration for reconciliation; unknown dependent views/FKs are not dropped. No live database has been changed by this code update.

Avoid editing the Sheet while extraction runs. The job detects source changes before acknowledgements, but Sheets does not offer a cross-system transaction or atomic conditional cell write.

## Toggles

The supplied config enables both `transaction_master` and `subscription_master`. Deploy the updated expense-tracker backend for transaction UUID/lifecycle import guards and direct Sheet edit tracking. Existing in-sync rows edited before that deployment need one hard-sync to revalidate their current contents. Both transfer directions must have matching category keys, and currency-rates must provide each transaction's exact UTC-date valuation rate. Subscription sync needs no exchange rate: it stores local-currency obligations. Deploy its matching schema/CRUD/schedule fixes too, fill the local subscription CSV's timezone per dated row, and import it before dev hard-sync. Quarterly/annual subscriptions need a start timestamp as their month anchor. Source reads no longer auto-expire lifecycle state; expiry is a computed calendar status.

Each entity's `enabled` setting in `config.yaml` determines which tabs are read in both normal-sync and hard-sync. Enable only tabs that exist in the selected spreadsheet. For example, to sync account masters and deposit details alongside categories:

```yaml
entities:
  account_types: {enabled: true}
  category_master: {enabled: true}
  account_master: {enabled: true}
  account_deposit: {enabled: true}
  account_liability_credit_card: {enabled: false}
  account_liability_mortgage: {enabled: false}
  account_liability_personal_loan: {enabled: false}
  account_investment_property: {enabled: false}
  account_investment_stocks: {enabled: false}
  transaction_master: {enabled: false}
  subscription_master: {enabled: false}
```

Create and populate the six visible detail types through the expense-tracker account importer before enabling extraction. The [import guide](../../../expense-tracker/_docs/account-imports.md) lists exact headers; the six requested `local/files/` CSVs now include the appended metadata block. Importer-owned sync/audit inputs are ignored; it generates new audit timestamps and preserves creation timestamps on replacement. An omitted detail toggle defaults to disabled for older configuration files.

Values must be YAML booleans, not quoted strings. Disabling a dependency means the downstream entity uses existing database references; it does not sync the disabled tab. Empty valid tabs are allowed and never wipe stored data. Missing tabs, schema drift, invalid/duplicate UUIDs and invalid master/metadata-detail sync statuses abort the snapshot before entity writes.

## Account type configuration

Deploy expense-tracker and open Configure → Account Types before extraction to initialize the thirteen-column `account_types` source from CSV. Import `local/files/account_types.csv` to use the existing reference UUIDs. Migrations 0019–0020 and normal-sync preserve category links, hyphenate key values and support one-time adoption of existing unmanaged catalog IDs. Import explicit `detail_sheet` policy from the current CSV; no runtime seed is supplied. Migration 0020 requires a completed policy refresh before dependent lookups, including source rows already marked in-sync. Unknown classifications are rejected. Process account types before categories and accounts; unavailable or invalid enabled configuration stops dependent entities. See [account-type mapping](../_docs/account-types.md).

## Recovery

Inspect master and six detail-tab `sync_notes` for expected validation failures. A detail failure rolls back all selected rows in that tab, marks them failed (the culprit has its error, peers have `detail_tab_rolled_back`), and stops later entities. Fix the source/dependency and rerun: both pending and failed rows retry even without another Sheet modification. A failed entity stops subsequent entities and the process exits nonzero. Earlier successful rows/groups remain committed and are acknowledged if the source is unchanged.

| Failure | Action |
|---|---|
| `missing_enabled_sheet:<tab>` | For a legacy master tab, run the expense-tracker `migrateMasterSheetNames()` helper after deployment. Otherwise create/import the exact tab, or set `entities.<tab>.enabled: false` in `config.yaml`. No entity records are written if initial capture fails. Hard-sync does not create tabs or override enabled flags. |
| `master_sheet_name_collision:<tab>` | Both the canonical and legacy tabs exist for an enabled master. Reconcile the duplicate tabs explicitly before retrying; extraction stops before reading values or writing records. |
| `account_detail_loan_classification_requires_reconciliation` | Correct legacy loan owner subtype/source provenance before retrying; migration 0018 rolls back all changes on ambiguity. |
| `account_types_migration_required` | Import the complete updated account_types.csv through expense-tracker Configure → Account Types after deploying the current backend. Database migrations do not upgrade the Sheet. |
| `sheet_header_mismatch` | Bring headers into agreement with current GAS schema; never shift metadata cells manually to hide the mismatch |
| `sheet_changed_*` | Stop concurrent edits and retry; already committed rows replay idempotently |
| `transaction_error:cyclic_parent_reference` | Correct circular parent links in the source. A transfer consists of a root plus one live child; no rows from a structurally invalid source batch are written. |
| `database_transaction_identity_requires_reconciliation` in `sync_notes` | Reconcile the old database UUID spelling and its parent references before retrying. The extractor does not create a second logical transaction or silently rewrite historical identities. |
| `transaction_error:database_transfer_relationships_changed_retry` | Another database writer changed transfer links after planning. Retry against the updated state; the current group was rolled back. |
| HTTP 429 / `sheets_api_rate_limit_exhausted` | The job batches source reads, paces requests and waits through bounded quota retries. If exhausted, let other jobs sharing the service account finish and retry after quota refills. No quota increase or row deletion is required. |
| Missing account/category | Sync dependencies first, including historical/inactive records |
| `currency_rate_not_found` | Backfill the exact UTC transaction date; crypto weekends may have no rate under the current currency-rates policy |
| Missing account snapshot rate | Supply a tracking/opening date and load a rate on or before that local date |
| Detail identity collision or account move | Preserve the existing UUID association; explicitly reconcile legacy collisions rather than overwriting or regenerating IDs |
| Detail valuation rate missing/invalid | Load compatible historical rates using currency-rates, or correct the supplied evaluation reference/date |
| Account subtype conflicts with detail rows | Reconcile retained detail records/property links before changing the master subtype |
| Unknown or mismatched detail source provenance | Reconcile the stored source/table association; do not relabel legacy records automatically |
| Immutable account fields differ | Explicitly reconcile source and DB history; the job will not silently change identity/currency/opening balance |
| Invalid/DST local timestamp | Correct the source timestamp/zone; ambiguous times cannot be disambiguated from the current offset-free source format |
| Invalid beneficiary shares | Use consistent allocation format and shares totalling exactly 100 after four-place rounding |
| `ledger_sheet_extract_already_running` | Wait for the running job to finish; the DB session lock releases on connection close |
| Nonempty legacy `transactions` table | Preserve and explicitly migrate legacy records before migration 0005; it refuses destructive replacement |

A lost acknowledgement does not undo committed PostgreSQL rows. Retry instead of deleting/recreating DB rows. Physically deleting a source row is not a tombstone: use `record_status=deleted` where the source contract supports it. All detail tabs now support explicit lifecycle values; physical removal still requires a separately reviewed reconciliation. Source timestamps remain source-owned; DB audit timestamps describe ingestion.

The September 24 hard-sync quota failure came from rereading each tab's metadata, headers and rows before every account commit. Those guards now fetch all enabled tabs in one batch, while retaining the same source-change checks. All queued acknowledgements use one batch write, with a fresh source check after every retry wait. Rerun `make data-sync` → `ledger-sheet-extract` → the same environment → `hard-sync` to finish an interrupted hard-sync; committed categories/accounts are upserted by their existing UUIDs. These Python changes require no GAS deployment or new migration.

After deploying these fixes, apply migrations and consider a reviewed `--reprocess` run for supported entities. Existing account/transaction applied-rate snapshots remain NULL until replay; migrations do not guess the original rate. Old extension balances and conflicting immutable account history require separate reconciliation. All six declared detail tabs are supported; their optional fields and legacy balance/history omissions are explicit in the [six detail mappings](../_docs/account-details.md). Details mirror source snapshots and are not transaction-driven balances.

## Local checks

```bash
make lint
make test-unit
make test-integration
# Or both suites:
make test
```

Unit tests need no credentials. Integration tests create a disposable PostgreSQL cluster with a private Unix socket, no TCP listener, and per-test databases; they do not connect to configured dev/prod. They skip if server binaries are unavailable or run as root. A sandbox may need permission for PostgreSQL shared memory even with TCP disabled. Report skips honestly; they are not successful database validation.
