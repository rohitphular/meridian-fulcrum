# ledger-sheet-extract review checklist

Read the [README](../README.md) and the standards `APP-BE-PYTHON.md`, `APP-CICD-BE-PYTHON.md` and `APP-LOGGING-PATTERNS.md`.

## Highest-risk checks

- Extract makes one batched read of all enabled tabs and stores the whole snapshot in one transaction; older unfinished runs are superseded so only the newest is loaded.
- Staged cells keep their Python types through JSONB (`int` vs `float` vs `bool` vs `str`); otherwise every row looks edited and nothing is acknowledged.
- Acknowledge holds the Sheet lock (`73421, 2`) and the load lock (`73421, 1`), so a reload cannot change the outcomes being written. It matches rows by canonical UUID in a fresh read, writes only the three sync cells (found by header name), skips rows edited since the snapshot (type-strict comparison of every other cell) or not found exactly once, and re-plans from a fresh read before each write retry. A column added since the snapshot is ignored while blank; a removed column, or a new one with a value, counts as an edit.
- Retention prunes only finished (`acknowledged`/`superseded`) runs older than six months, never the newest.
- No contract knowledge here: business columns are validated by ledger-database-load.
- Logs carry codes, tab names, row numbers and counts — never cell values or credentials.

## Verification

```bash
make lint
make test-unit
make test-integration
```
