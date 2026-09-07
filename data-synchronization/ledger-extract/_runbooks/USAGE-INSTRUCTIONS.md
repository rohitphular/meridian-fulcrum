# USAGE INSTRUCTIONS — ledger-extract

## Prerequisites

- Python 3.12+, `uv` installed
- PostgreSQL running (see `FULCRUM_DB_*` env vars)
- A Google service account JSON key with read access to the target spreadsheet
- `meridian-fulcrum/infrastructure/.env.dev` or `meridian-fulcrum/infrastructure/.env.prod` populated — see Environment Variables below
- `cicd/envs.json` populated — see Environment Config below

---

## Environment config (non-secrets)

`cicd/envs.json` — per-env config that is safe to commit. Edit by hand to record the spreadsheet ID for each environment.

```json
{
  "dev": {
    "spreadsheet_id": "<dev spreadsheet ID>"
  },
  "prod": {
    "spreadsheet_id": "<prod spreadsheet ID>"
  }
}
```

`LE_SPREADSHEET_ID` is **not** set in `.env` — it is read from `cicd/envs.json` by `start-up.sh` and exported before the job runs.

---

## Environment variables

These are secrets — set them in `meridian-fulcrum/infrastructure/.env.dev` or `meridian-fulcrum/infrastructure/.env.prod` as appropriate. Neither file is committed to source control.

| Variable | Example | Purpose |
|---|---|---|
| `FULCRUM_DB_HOST` | `localhost` | Postgres host |
| `FULCRUM_DB_PORT` | `5432` | Postgres port |
| `FULCRUM_DB_USER` | `fulcrum` | Postgres user |
| `FULCRUM_DB_PASSWORD` | `...` | Postgres password |
| `FULCRUM_DB_NAME` | `fulcrum_db` | Postgres database |
| `LE_SERVICE_ACCOUNT_FILE` | `/path/to/sa.json` | Service account key path |
| `MERIDIAN_LOG_ROOT` | `/var/log/meridian` | Root directory for log output |

All variables are **required**. The job raises `KeyError` at startup if any is missing.

---

## Running the job

```bash
cd ledger-extract
./cicd/start-up.sh dev    # run against dev spreadsheet
./cicd/start-up.sh prod   # run against prod spreadsheet
```

Or from the repo root:

```bash
make run ENV=dev
make run ENV=prod
```

`cicd/start-up.sh` does, in order:
1. Validates the env arg (`dev` or `prod`) — exits immediately if missing or unrecognised
2. Reads `spreadsheet_id` from `cicd/envs.json` and exports it as `LE_SPREADSHEET_ID` — exits if `TODO`
3. Sources `infrastructure/.env.{env}` (meridian-fulcrum/infrastructure/) for secrets — fails fast if the file does not exist
4. `uv sync --quiet` — creates or updates `uv.lock` from `pyproject.toml` (first run), then installs from it
5. `uv run py-db-migrate run --db postgres` — applies pending migrations
6. `uv run python -m core.runner` — runs the extract job

---

## Entity toggle

Edit `config.yaml` to enable or disable individual entities:

```yaml
entities:
  categories:
    enabled: true
  accounts:
    enabled: true
  transactions:
    enabled: true
```

When an entity is disabled, both its extraction and write-back pass are skipped.

---

## Scheduling

The job is designed to run as a single instance (cron or equivalent). Concurrent runs are **not safe** — see CODE-REVIEW-INSTRUCTIONS.md for details.

Example crontab entry (runs every 30 minutes against prod):
```
*/30 * * * * /path/to/ledger-extract/cicd/start-up.sh prod >> /var/log/meridian/ledger-extract-cron.log 2>&1
```

---

## Regenerating database models (dev only)

Requires Docker running:

```bash
make generate-models
```

This spins up a temporary `postgres:17` container, applies all migrations into it, introspects the schema, writes typed model files to `database/models/`, and tears the container down. It does not connect to the live database.

---

## Recovering from a failed sync row (categories)

Categories use the sync_status model. If a row is stuck with `create-failed` or `update-failed`, check the `sync_notes` column in the sheet for the human-readable reason. Common causes:

- **Duplicate key** — a category with the same `tx_type / major / minor` combination already exists in the DB. Either remove the duplicate from the sheet or change one of the key fields.
- **Invalid account subtype** — one or more tokens in `source_account_types` or `target_account_types` do not match any `account_subtype` in the `account_types` table. Correct the value in the sheet.
- **Check constraint** — a field value does not satisfy a DB constraint (e.g. `record_status` not in allowed values). Correct the value.

After fixing the sheet data, change `sync_status` back to `create-pending` or `update-pending` and re-run the job. The job retries all rows with `create-failed` or `update-failed` status on every run.

If the job fails mid-batch before writing sync columns back (e.g. a Sheets API error), rows processed in that batch will retain their previous `sync_status`. Re-running the job will retry them safely — all DB writes are per-row transactions and idempotent via `ON CONFLICT DO UPDATE`.

---

## Recovering from a failed sync row (accounts)

Accounts use the same sync_status model as categories. If a row is stuck with `create-failed` or `update-failed`, check the `sync_notes` column in the sheet for the human-readable reason. Common causes:

- **Duplicate key** — two rows in the sheet carry the same `id` (UUID). This indicates a GAS bug where the same UUID was stamped twice. Do not attempt to manually change the `id` — it is GAS-managed and immutable. Remove the duplicate row from the sheet and investigate the GAS stamp logic.
- **Unknown account type/subtype combination** — the `type` / `sub_type` combination does not exist in the `account_types` reference table. Correct the sheet values to match a valid combination.
- **Invalid currency rate reference** — the rate row used at write time no longer exists in `currency_rates`. Re-run the currency-rates job to repopulate rates, then retry.
- **Opening value sign mismatch** — a liability account has a positive `opening_value`, or an asset/investment account has a negative one. The GAS backend should prevent this, but correct it in the sheet if it occurs.
- **Invalid record_status** — `record_status` is not one of `active`, `inactive`, `deleted`, `locked`. Correct the value in the sheet.
- **Invalid local_currency** — `local_currency` is not a 3-character uppercase ISO code (e.g. `GBP`, `USD`, `XAU`). Correct the value.
- **Currency not in currency_master** — `local_currency` value has no row in `currency_master`. Add the currency to the master table, then retry.
- **No currency rate found** — `local_currency` has no row in `currency_rates`. Run the currency-rates job first, then retry.
- **Opening base value sign mismatch** — indicates a code bug in the extract job where the computed XAU base value has the wrong sign. File a bug report; do not attempt to fix manually in the sheet.
- **base_currency constraint** — indicates a code bug where `base_currency` was set incorrectly by the extract job. File a bug report.
- **currency_rate_id_required constraint** — indicates a code bug where `currency_rate_id` was set to NULL for a non-XAU account. File a bug report.
- **Required field is null** — a required DB column received a NULL value. The `sync_notes` will name the column. Indicates a transform bug or schema drift; file a bug report.
- **Check constraint (other)** — a field value violates a DB constraint. The `sync_notes` will include the constraint name — cross-reference against the `account_master` schema.

After fixing the sheet data, change `sync_status` back to `create-pending` or `update-pending` and re-run the job. The job retries all rows with `create-failed` or `update-failed` status on every run.

If the job fails mid-batch before writing sync columns back, rows processed in that batch will retain their previous `sync_status`. Re-running the job will retry them safely — all DB writes are per-row transactions and idempotent via `ON CONFLICT DO UPDATE`.

---

## Recovering from a failed sync row (transactions)

Transactions use the same sync_status model as categories and accounts. If a row is stuck with `create-failed` or `update-failed`, check the `sync_notes` column in the sheet for the human-readable reason. Common causes:

- **parent_tx_not_found** — `parent_tx_id` references a transaction that does not yet exist in `transaction_master`. Sync the parent row first, then retry this row.
- **account_not_found** — `account_id` does not match any active account in `account_master`. Verify the UUID in the sheet matches an account that is not `deleted` or `locked`.
- **category_not_found** — the `tx_type` / `major_category` / `minor_category` combination has no matching active row in `category_master`. Correct the category fields in the sheet or ensure the category has been synced first.
- **currency_rate_not_found** — no rate exists in `currency_rates` for the account's local currency on the transaction date. Run the currency-rates job to backfill rates for that date, then retry.
- **amount_rounds_to_zero_in_minor_units** — the `tx_amount_local` value is positive but rounds to zero when converted to minor units (e.g. `0.001 GBP` → 0 pence). Use a larger amount or a different currency.
- **beneficiary_empty_name** — the `beneficiaries` field contains an empty entry (e.g. `"Alice;;Bob"`). Fix the value in the sheet.
- **beneficiary_inconsistent_percentage_format** — some entries have a percentage and some do not (e.g. `"Alice:60;Bob"`). Either all entries must have a percentage or none must.
- **beneficiary_invalid_percentage** — a percentage value is non-numeric, ≤ 0, or > 100. Correct the value in the sheet.
- **beneficiary_percentages_do_not_sum_to_100** — explicit percentages do not sum to 100 (±0.01 tolerance). Correct the values.
- **transaction_not_found** — an `update-pending` row has no matching `transaction_id` in `transaction_master`. Change `sync_status` to `create-pending` and retry.
- **transaction_locked** — the DB record is `locked` (finalised by an archival process). The extract refuses to modify locked records; do not attempt to force an update.
- **transaction_deleted** — the DB record is `deleted`. If the sheet row genuinely needs updating, investigate why the DB record was deleted before retrying.
- **Unique constraint violation** — indicates a duplicate key condition (e.g. duplicate beneficiary junction row). Check `sync_notes` for the constraint name and investigate the cause.
- **DB FK / constraint violation** — a foreign key or check constraint was violated. `sync_notes` names the constraint; cross-reference against the `transaction_master` schema.
- **Required field is null** — indicates a transform bug or schema drift; file a bug report.

After fixing the sheet data, change `sync_status` back to `create-pending` or `update-pending` and re-run the job.

If the job fails mid-batch before writing sync columns back, re-running the job will retry rows safely. The update path (delete + re-insert) is wrapped in a single DB transaction — a failure after the DELETE but before the re-INSERT is automatically rolled back, leaving the original data intact.
