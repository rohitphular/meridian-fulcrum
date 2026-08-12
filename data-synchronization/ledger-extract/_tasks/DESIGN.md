# DESIGN — ledger-extract

**Purpose:** Scoping and design decisions for the `ledger-extract` job before any code is written.

**Scope:** Extract the four core expense-tracker entities from Google Sheets and load them into PostgreSQL. Entities: `categories`, `accounts`, `transactions`, `subscriptions`.

---

## Source schema — what the sheets actually contain

Confirmed from the GAS schema files. These are the exact column names, in order.

### `transactions` (16 columns)
| Column | Type in sheet | Notes |
|--------|--------------|-------|
| `id` | string | Natural key — format `YYYY-MM-DD-NNN` |
| `tx_date_time` | date string | Date/time of transaction |
| `tx_type` | enum | `money-in`, `money-out`, `money-transfer` |
| `source_account` | string | Account ID |
| `target_account` | string | Account ID (empty for non-transfers) |
| `tx_location_area` | string | Optional |
| `tx_location_city` | string | Optional |
| `tx_location_country` | string | Optional |
| `amount` | number | In `currency` units |
| `currency` | string | 3-char code |
| `fx_rate` | number | Optional |
| `major_category` | string | Optional for transfers |
| `minor_category` | string | Optional for transfers |
| `tags` | string | Semicolon-separated |
| `counterparty_name` | string | Optional |
| `description` | string | Optional |

**No `updated_at` or `modified_at` field.** This is the key constraint for incremental load.

### `accounts` (10 columns)
| Column | Type in sheet | Notes |
|--------|--------------|-------|
| `id` | string | Natural key |
| `name` | string | |
| `type` | enum | `asset`, `investment`, `liability` |
| `sub_type` | string | e.g. `current`, `crypto`, `mortgage` |
| `currency` | string | 3-char code |
| `opening_value` | number | |
| `current_value` | number | Live balance maintained by GAS |
| `is_active` | boolean | |
| `description` | string | |
| `created_at` | string | Set on create — not updated |

**Has `created_at` but no `updated_at`.** `current_value` changes on every transaction — this is the field most likely to change.

### `categories` (13 columns)
| Column | Type in sheet | Notes |
|--------|--------------|-------|
| `tx_type` | enum | `money-in`, `money-out`, `money-transfer` |
| `major_category` | string | |
| `minor_category` | string | |
| `description` | string | |
| `is_active` | boolean | |
| `tag_keywords` | string | |
| `counterparty_examples` | string | |
| `source_account_types` | string | Comma-separated |
| `target_account_types` | string | Comma-separated |
| `source_account_mandatory` | boolean | |
| `target_account_mandatory` | boolean | |
| `workflow_type` | enum | |
| `is_subscription_eligible` | boolean | |

**No `id`, no timestamps at all.** Natural key is `(tx_type, major_category, minor_category)`.

### `subscriptions` (16 columns)
| Column | Type in sheet | Notes |
|--------|--------------|-------|
| `id` | string | Natural key |
| `name` | string | |
| `counterparty_name` | string | |
| `amount` | number | |
| `currency` | string | 3-char code |
| `frequency` | enum | `weekly`, `monthly`, `quarterly`, `annual` |
| `day_of_month` | number | Optional |
| `day_of_week` | number | Optional |
| `source_account` | string | |
| `tx_type` | enum | |
| `major_category` | string | |
| `minor_category` | string | |
| `tags` | string | Semicolon-separated |
| `is_active` | boolean | |
| `description` | string | |
| `created_at` | string | Set on create — not updated |

---

## Open decisions

### Decision 1 — Sheets access: CONFIRMED ✓

Sheets API + service account. The existing `SheetsClient` in `expense-tracker/job/sheets_client.py` moves to a new common library `py-sheets-client` in `meridian-common-libs`. See the dedicated section below.

---

### Decision 2 — Incremental load strategy: NEEDS DISCUSSION

**The problem**: None of the four sheets have an `updated_at` column. We cannot query "give me rows changed since time T." Transactions can be edited in-place by GAS — an edit to a 6-month-old transaction has the same `id` and no timestamp change. Categories have no `id` and no timestamps at all.

**Three viable strategies:**

#### Option A — Row hash comparison (recommended)
- On each run: read all rows from the sheet
- Compute a deterministic hash of each row's content
- Store `(natural_key, row_hash)` in a metadata table in the DB
- Upsert only rows where the hash has changed or the key is new
- Delete DB rows whose key is absent from the sheet (catches GAS deletes)
- Use the Google Sheets API `modifiedTime` as an early-exit gate: if the spreadsheet hasn't changed since last run, skip all sheet reads entirely

**What this buys:** True row-level change detection with no GAS schema changes required. The sheet read still happens on every run (unless `modifiedTime` gate fires), but only changed rows hit the DB.

**Cost:** Two metadata tables needed — one per entity tracking `(natural_key, row_hash, last_seen_at)`.

#### Option B — Periodic full reload, gated by `modifiedTime`
- Check `modifiedTime` from the Sheets API
- If unchanged since last run → skip entirely
- If changed → full reload (truncate + insert all rows)
- No hash tracking, no incremental, no delete detection per-entity

**What this buys:** Very simple to build. Fine while row counts are small. Breaks down when transactions grows to 10k+ rows because every detected change reloads everything.

#### Option C — Add `updated_at` to GAS schema (invasive)
- Add `updated_at` to each GAS schema and have GAS write it on create and edit
- ledger-extract uses `updated_at > last_extracted_at` as the watermark
- Still does not detect GAS deletes — need a separate reconciliation pass

**What this costs:** Requires coordinated GAS backend change and migration of existing sheet data.

**Recommendation:** Option A. It requires no GAS changes, handles edits and deletes correctly, and the `modifiedTime` gate makes it cheap when nothing has changed.

**Decision needed:** Confirm Option A, or discuss further.

---

### Decision 3 — Extended schema: NEEDS DISCUSSION

"Extended" means the DB columns are not a 1-to-1 mirror of the sheet. Confirmed extensions and open questions:

**Certain extensions (all entities):**
- `row_hash TEXT NOT NULL` — stores the content hash used for change detection (required by Option A)
- `extracted_at TIMESTAMPTZ NOT NULL` — when this row was last confirmed from the sheet
- `id UUID NOT NULL DEFAULT gen_random_uuid()` — surrogate PK per convention (natural key becomes a UNIQUE column)

**Type transformations:**
- `tx_date_time` → `TIMESTAMPTZ` (parsed from sheet string)
- `amount`, `fx_rate`, `opening_value`, `current_value` → `NUMERIC(19,6)`
- All `is_*` booleans → `BOOLEAN` (sheet stores `TRUE`/`FALSE` as strings)
- `created_at` (accounts, subscriptions) → `TIMESTAMPTZ`
- `tags` → `TEXT[]` (split on semicolon) OR keep as `TEXT` — **decision needed**

**Open questions for extended schema:**

1. **FX-normalised amount**: Should the extract job compute `amount_xau` (amount converted to XAU base) by joining with the `currency_rates` table at extraction time? This would make analytical queries simpler downstream. Or is FX conversion a separate concern?

2. **Account balance history**: `current_value` on accounts changes with every transaction. Should the extract store only the latest value (mirror), or snapshot it with a timestamp to build a balance history table?

3. **Category natural key**: Categories have no `id`. The natural key is `(tx_type, major_category, minor_category)`. Should the extract assign a surrogate UUID on first insert and keep it stable, or recalculate each run?

4. **`tags` storage**: Keep as `TEXT` (semicolons preserved) or split into `TEXT[]`? Arrays make tag-based queries easier but add transform complexity.

5. **Deleted rows**: When a transaction is deleted from the sheet, should the DB row be hard-deleted or soft-deleted (`is_deleted BOOLEAN`, `deleted_at TIMESTAMPTZ`)?

**Decision needed:** Answers to the five questions above.

---

### Decision 4 — FK constraints: DEFERRED

Depends on Decision 3 (extended schema). Will revisit once the schema design is locked.

The main question: transactions reference accounts (`source_account`, `target_account`) and categories (`major_category`, `minor_category`) by their GAS string IDs. If accounts and categories are loaded first, FK constraints are feasible. If load order cannot be guaranteed, store as `TEXT` references with no FK.

---

## `py-sheets-client` — common library design

The existing `SheetsClient` in `expense-tracker/job/sheets_client.py` is the foundation. It moves to `meridian-common-libs/py-sheets-client/` as a proper common library.

### What moves to the library (generic primitives)

```python
class SheetsClient:
    def __init__(self, service_account_file: str, spreadsheet_id: str) -> None
    def read_sheet(self, name: str) -> list[dict]         # reads all rows as dicts
    def write_sheet(self, name: str, headers: list[str], rows: list[list]) -> None
    def append_rows(self, name: str, rows: list[list]) -> None   # NEW — append without clear
    def get_modified_time(self) -> datetime               # NEW — spreadsheet-level modifiedTime
    def list_worksheets(self) -> list[str]                # NEW — list all tab names
```

### What stays in the expense-tracker job (specific pattern)

`replace_today_and_trim` — the idempotent time-series write pattern for the insights job. Too specific for a generic library. Stays in `expense-tracker/job/sheets_client.py` (or moves to `jobs/base.py`).

### Issues to fix in the existing code before promoting to common lib

| Issue | Fix |
|-------|-----|
| `print()` calls | Replace with `py-logging` (`logger = get_logger(__name__)`) |
| `_SCOPES` has full write scope | Split: use `spreadsheets.readonly` for read-only clients; full scope only when writing |
| `gspread.authorize()` is deprecated | Replace with `gspread.Client(auth=creds)` |
| No type annotations on all parameters | Add `-> None`, `-> list[dict]`, etc. |
| No error handling on `write_sheet` / `append_rows` | Wrap in `try/except gspread.exceptions.APIError` |

### Library structure (proposed)

```
meridian-common-libs/py-sheets-client/
├── pyproject.toml
├── py_sheets_client/
│   ├── client.py        # SheetsClient class
│   └── py.typed
└── tests/
    └── integration/
        └── test_client.py
```

---

## Proposed folder structure for `ledger-extract` (draft)

```
ledger-extract/
├── config.yaml              # entity toggles (enabled: true/false per entity)
├── pyproject.toml
├── py_db_migrate.toml
├── start-up.sh
├── core/
│   ├── config.py            # env vars, config.yaml reads
│   ├── extractor.py         # orchestrates all four entity extracts
│   └── runner.py            # entry point
├── transforms/
│   ├── accounts.py          # sheet row → typed dict; hash computation
│   ├── categories.py
│   ├── transactions.py
│   └── subscriptions.py
├── database/
│   ├── hashes.py            # read/write row_hash metadata table
│   └── upsert.py            # entity-specific upsert helpers
└── migrations/
    ├── 0001_create_accounts.py
    ├── 0002_create_categories.py
    ├── 0003_create_transactions.py
    ├── 0004_create_subscriptions.py
    └── 0005_create_extract_hashes.py   # hash metadata table
```

Note: no `sources/` folder — the Sheets client comes from `py-sheets-client` common lib.

---

## Next steps (in order)

1. **Answer Decision 2**: Confirm hash-based incremental (Option A) or discuss alternatives
2. **Answer Decision 3**: Five schema questions (FX normalisation, account balance history, category surrogate key, tags storage, soft vs hard delete)
3. **Lock schema** → write migrations
4. **Build `py-sheets-client`** in `meridian-common-libs` (can run in parallel with schema discussion)
5. **Write `ledger-extract`** once schema and client are settled
