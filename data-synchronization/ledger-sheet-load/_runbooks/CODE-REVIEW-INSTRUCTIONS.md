# ledger-sheet-load review checklist

Read the current [README](../README.md), [usage](USAGE-INSTRUCTIONS.md), and standards under `building-standards/documents/standards/`: `APP-BE-PYTHON.md`, `APP-CONVENTIONS.md`, `APP-LOGGING-PATTERNS.md`, `APP-CICD-BE-PYTHON.md` and `APP-AUTH-PIN-TOTP.md`. The server contract is in expense-tracker: `api/app-router.gs`, `api/csv-import.gs`, `api/factory-reset.gs`, `api/sheet-order.gs` and the entity import files.

Never run against a live environment just to check code. Review with the unit tests or a local mock web app and a copy of the CSV folder.

## Highest-risk checks

- The PIN and authenticator code never appear in arguments, environment variables, log lines or exception messages. GET URLs carry the PIN, so transport errors must be re-raised as codes without the original exception chained or printed.
- Logged reasons are codes, file names and counts only. Row-level server errors go to the terminal, never the log file.
- Nothing in the Sheet changes until every file has passed its dry-run check. Only sheet-rebuild deletes tabs, and the delete sends the environment's `spreadsheet_id` with `confirm: "factory-reset"`.
- Fill ids keeps file bytes exact (BOM, CRLF, quoting) apart from the filled id cells, backs up every changed file before overwriting it, and writes through a temporary file.
- The run stops at the first response that is not `ok` or that reports failed rows, and never retries.
- Load order follows data dependencies: account types, categories, accounts, details, subscriptions, then transaction files by name.
- POST redirects from Apps Script are followed as GET; there is no forced POST on the redirected request.
- Every action the job calls is still routed by `app-router.gs` (`expense-tracker/tests/factory-reset-backend.cjs` checks this).
- The launcher validates env and mode before any command, uses the committed lockfile, and works on macOS Bash 3.2 (`/bin/bash`).

## Verification

```bash
make lint
make test-unit
node --test ../../expense-tracker/tests/factory-reset-backend.cjs
```

Report concrete fixes, passed/failed/skipped checks and unresolved risks.
