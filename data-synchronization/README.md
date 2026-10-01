# Manual finance synchronization

The daily entry path is **Expense Tracker UI → Apps Script → Google Sheets**. Google Sheets owns the source UUIDs and lifecycle. The extract jobs populate PostgreSQL when you run them; PostgreSQL edits are not pushed back into the app. `ledger-sheet-load` goes the other way for bulk loads: it pushes the local CSV files into the Sheet through the app's own import endpoints.

| Component | Reads | Writes |
|---|---|---|
| Expense Tracker | Its Google Sheets tabs | Source business fields, lifecycle and pending-sync metadata |
| [currency-rates](currency-rates/README.md) | Market provider data, or configured historical CSV files | PostgreSQL `currency_master` and dated `currency_rates` |
| [ledger-sheet-load](ledger-sheet-load/README.md) | Local CSV files in `local/files` | Google Sheets tabs, through the GAS import endpoints (sheet-rebuild or sheet-sync); fills missing CSV ids |
| [ledger-sheet-extract](ledger-sheet-extract/README.md) | Enabled source tabs and PostgreSQL currency references | Validated ledger tables; only sync status/date/notes back to Sheets |

The app's **Rates** tab contains current display rates. Neither data-sync job copies that tab into PostgreSQL or updates it from PostgreSQL. Both use XAU as one gram of gold, but current app totals and historical database valuations may differ because they use different valuation dates/rates. Accounts need a currency supported by the database catalog and the required rate history.

## Daily workflow

`make data-sync` lists every module that has a `cicd/start-up.sh`, asks for the environment, and the module then asks for its own mode.

1. Save entries in the app and wait for the save result. Use **Refresh** to pull changes from another device or a completed sync. The app requires connectivity; there is no offline write queue. If a request loses its response, refresh and check whether it saved before resubmitting.
2. From the repository root, run `make data-sync`, choose **currency-rates**, then the intended environment and **daily** mode. For older ledger dates, use its documented historical-import procedure first. Daily mode refreshes a rolling window, not all historical dates.
3. Run `make data-sync` again, choose **ledger-sheet-extract**, the same environment, and **normal-sync** for routine updates. Pending/failed rows process; existing in-sync rows skip, with missing-row recovery and account-type dependency refresh exceptions described in the module README.
4. Choose **hard-sync** after a deliberate transformation/rate correction when existing in-sync records must be reprocessed. This honors the enabled tabs; it does not repair missing facts, conflicting identities or immutable account fields.
5. Check the command exit status and source `sync_notes`. Correct failed source/dependency data and run normal-sync again. Prior successful commits remain valid; retry uses the same source UUIDs.

Run ledger extraction during a quiet editing window. It checks captured content before commits and acknowledgements, but Sheets and PostgreSQL have no shared transaction or atomic compare-and-swap. A concurrent edit stops the run; earlier commits may already exist. Missing source rows are not database deletions: use the app's lifecycle actions/tombstones.

## Bulk loads from CSV

After editing the files in `local/files`, run `make data-sync` → **ledger-sheet-load** → environment → **sheet-sync** (update rows by id, add new ones) or **sheet-rebuild** (delete and reload the CSV-backed tabs). Then run ledger-sheet-extract as above. This replaces the former `make factory-reset`.

## Setup and release

- Deploy the matching Expense Tracker frontend and Apps Script backend after code changes. Local tests do not update an existing deployment.
- Follow the [source schema migration instructions](../expense-tracker/_docs/master-sheet-names.md). Import Account Types first, then categories/accounts and desired detail tabs. Enable only existing tabs with current headers.
- Run currency migrations before ledger migrations on a new database. The launchers apply pending migrations for the selected environment. Ledger currently requires migrations through `0022`; currency requires `0006`, which rejects nonfinite rates and non-identity XAU values without rewriting historical data.
- Complete any missing per-row subscription timezones before importing/syncing dated subscriptions. No timezone is inferred from names or currencies.
- Use **Live** insights for the current data model. The older optional `expense-tracker/job` precomputation pipeline requires a separate port from its retired dual-leg model and now refuses to publish incompatible calculations.
- `make app-start` serves the repository on loopback for desktop development. Use the hosted frontend on mobile. Do not expose the repository's generic static server to a network: it contains private local configuration alongside public app assets.

See the [September 25 review](./_docs/REVIEW-2026-09-25.md) for the fixed gaps, validation evidence and remaining boundaries.
