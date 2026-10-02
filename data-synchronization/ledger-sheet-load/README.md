# ledger-sheet-load

Loads the local CSV files in `local/files` into an environment's expense-tracker Google Sheet. The job only calls the deployed GAS web app: every file goes to its entity's own CSV import endpoint, the same one the app uses, so parsing, validation and the Sheet writes all happen in Apps Script. It never touches PostgreSQL; run the ledger sync afterwards to move the loaded rows into the database ([ledger-sheet-extract](../ledger-sheet-extract/README.md) `extract` → [ledger-database-load](../ledger-database-load/README.md) → `acknowledge`, normally via `make consolidated-pipeline`).

See [usage](./_runbooks/USAGE-INSTRUCTIONS.md) for prerequisites, commands and troubleshooting.

## Modes

| Mode | Use when | Steps |
|---|---|---|
| `sheet-rebuild` | You want fresh tabs. Asks you to type the environment name. | sign in → fill ids → check → delete + recreate tabs → load → order tabs |
| `sheet-sync` | The tabs exist and you want them to match your CSVs (data only). Asks y/N. | sign in → fill ids → check → load → order tabs |

Whichever mode you pick, every CSV is first scanned for rows without an `id` and given one.

## Steps

1. **Sign in** (`core/loader.py`): `MERIDIAN_FULCRUM_PIN` and a code generated from `MERIDIAN_FULCRUM_SECRET` when both are set in `infrastructure/.env.<env>` (the same names as the GAS Script Properties); otherwise the PIN (hidden) and a fresh authenticator code, asked for or read from stdin. Then `verify`, as the app's login does. Never in arguments or logs. Like the app, GET calls carry the PIN in the request URL; transport errors are reported as codes so that URL never reaches a message.
2. **Fill ids** (`steps/fill_ids.py`): every file goes to `fill_csv_ids`, which gives each row with a blank `id` a new UUID and returns the file text; only those cells change. Files are read and written as exact bytes (BOM and line endings kept). Changed files are copied to `local/files/.backup/<timestamp>/` first, then overwritten. With ids on every row, later syncs update rows instead of adding them again.
3. **Check** (`steps/check_files.py`): each file goes to its import endpoint with `dry_run: true` (parse and validate only, no Sheet access). Any error stops the run before the Sheet changes.
4. **Delete + recreate** (`steps/drop_tabs.py`, sheet-rebuild only): `factory_reset_delete_sheets` deletes the 11 CSV-backed tabs (`account_types`, `category_master`, `account_master`, the six account detail tabs, `subscription_master`, `transaction_master`). It requires `confirm: "factory-reset"` and the environment's `spreadsheet_id` from `cicd/envs.json`, so a run pointed at the wrong spreadsheet deletes nothing; every other tab (`dummy`, `rates`, `audit_access`, `advisor_chat`, `computed_insights`) is kept. The `recreate_actions` in `config.yaml` (`list_transactions`, `list_categories`, `list_accounts`, `list_subscriptions`) then recreate their tabs; `account_types` and the detail tabs are created by their imports.
5. **Load** (`steps/load_data.py`): one request per file, in the dependency order listed in `config.yaml` (`create_account_types_bulk`, `create_categories_bulk`, `import_account_data` with `file_type`, `create_subscriptions_bulk`, then `create_transactions_bulk` for every `transaction_master_*.csv` by name).
6. **Order tabs** (`steps/order_tabs.py`): `arrange_sheet_tabs` reapplies the configured order through `ensureExpenseTrackerSheetOrder()`; tabs outside the order, such as `dummy`, move to the end.

**Unchanged rows stay as they are:** a CSV row identical to the Sheet row is not rewritten, so an `in-sync` row stays `in-sync` and the ledger sync (ledger-sheet-extract → ledger-database-load) skips it; the load log reports `created`, `updated` and `unchanged` per file.

**What a sync does not do:** rows are matched by `id`, so a sync updates and adds rows but never deletes one; a row removed from a CSV stays in the Sheet until you rebuild. The Account Types import only updates existing classifications, so adding a new one needs a rebuild.

The run stops at the first response that is not `ok` or that reports failed rows. The full response (row errors included) is printed to the terminal; the log file records only codes, file names and counts. It never retries: repeated wrong PINs lock the caller. `rates` must already hold every account currency.

## Layout

```
ledger-sheet-load/
├── Makefile
├── config.yaml              # data folder, file → endpoint load order, tabs to recreate
├── pyproject.toml / uv.lock
├── cicd/
│   ├── envs.json            # script_url + spreadsheet_id per environment (non-secret)
│   ├── check.sh             # mandatory check: env, mode, settings (no installs or writes)
│   └── start-up.sh          # runs check.sh, env loading, locked sync, run
├── core/
│   ├── config.py            # config.yaml and environment variables
│   ├── context.py           # LoadContext: client, data folder, files and settings passed to each step
│   ├── credentials.py       # PIN / authenticator prompts
│   ├── datasets.py          # file list and exact-byte CSV reads/writes
│   ├── gas_client.py        # GET/POST to the GAS web app; expect_ok
│   ├── loader.py            # LedgerSheetLoadJob: step order per mode
│   └── runner.py            # entry point: confirmation, failure reasons
├── steps/                   # one file per step
└── tests/unit/
```

There is no `database/`, `migrations/` or `py_db_*.toml`: this job has no database.

## How to run

From the repository root, `make data-sync` → `ledger-sheet-load` → environment → mode. From this directory:

```bash
make run ENV=dev                       # asks for the mode
make run ENV=dev MODE=sheet-sync
bash cicd/start-up.sh --interactive prod sheet-rebuild
```

Unattended (the [consolidated-pipeline](../consolidated-pipeline/README.md), or `bash cicd/start-up.sh --config FILE [--stage N]`): env and mode come from the pipeline config, nothing is prompted, and the PIN and code are read from stdin, one per line. A `sheet-rebuild` stage needs `"confirm": "<env>"` in the config, standing in for typing the env name. `--sign-in-only` checks the PIN and code and stops; `--skip-sign-in` reads only the PIN and skips `verify` (the pipeline uses these to sign in once, while the code is fresh, before any stage runs). `cicd/check.sh` validates the settings first on every run (`start-up.sh` always runs it); run on its own, as the pipeline does, it also prints `credentials=gas-pin-totp` so the pipeline knows to ask for them.

Deploy the current expense-tracker backend first: the job relies on `fill_csv_ids`, `factory_reset_delete_sheets`, `arrange_sheet_tabs` and the `dry_run` import contract.

## Development

```bash
make lint
make test-unit
```

Tests run offline: GAS is replaced by a local HTTP server that answers with Apps Script-style 302 redirects, or by a recording fake client.
