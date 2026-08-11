# Data Sync Design — Google Sheets → PostgreSQL

**Status:** Draft — under discussion  
**Existing Python job:** `forge/expense-tracker/job/`  
**Existing Sheets client:** `job/sheets_client.py` (gspread + service account auth)

---

## 1. Scope

### Direction

**Unidirectional: Sheets → PostgreSQL.**

Sheets remains the data entry interface. PostgreSQL is the analytical store.  
No writes back from PostgreSQL to Sheets except for precomputed insight results (existing behaviour, unchanged).

### Tables synced

| Sheets name | PostgreSQL table | Priority | Dependencies |
|-------------|-----------------|----------|-------------|
| `rates` | `rates` | 1 — reference | none |
| `categories` | `categories` | 2 — reference | none |
| `accounts` | `accounts` | 3 — reference | none |
| `transactions` | `transactions` | 4 — core data | accounts, categories (soft) |
| `subscriptions` | `subscriptions` | 5 — core data | accounts, categories (soft) |

**Sync order matters:** reference tables (rates, categories, accounts) must complete before transactional tables. Foreign key constraints in PostgreSQL are initially advisory (NOT ENFORCED) — see Section 7.

---

## 2. Sync Run Model

Each sync run:
1. Reads all rows from a Sheets tab via `SheetsClient.read_sheet()`
2. Coerces types (strings from Sheets → typed PostgreSQL values)
3. UPSERTs into PostgreSQL using `external_ref` as the conflict key
4. Detects and soft-deletes rows that were present in the last sync but are now absent
5. Records the run outcome in `sync_log`

A run is **idempotent** — running it twice produces the same result.  
A run is **complete** — it always reads the full sheet, never a partial window.  
Partial/incremental sync comes later once the baseline is stable (see Section 10).

---

## 3. The `sync_log` Table

Every run is recorded. This is the operational heartbeat.

```sql
CREATE TABLE sync_log (
  id              UUID          NOT NULL DEFAULT gen_random_uuid(),
  run_id          UUID          NOT NULL,          -- groups all tables in one sync run
  table_name      TEXT          NOT NULL,
  source_system   TEXT          NOT NULL DEFAULT 'sheets',
  started_at      TIMESTAMPTZ   NOT NULL,
  completed_at    TIMESTAMPTZ,
  status          TEXT          NOT NULL,          -- 'running' | 'success' | 'error'
  rows_read       INTEGER,
  rows_upserted   INTEGER,
  rows_deleted    INTEGER,
  error_message   TEXT,

  CONSTRAINT sync_log_pkey PRIMARY KEY (id),
  CONSTRAINT chk_sync_log_status CHECK (status IN ('running', 'success', 'error'))
);

CREATE INDEX idx_sync_log_run_id     ON sync_log (run_id);
CREATE INDEX idx_sync_log_table      ON sync_log (table_name, started_at DESC);
CREATE INDEX idx_sync_log_started_at ON sync_log (started_at DESC);
```

---

## 4. UPSERT Strategy

Every row from Sheets maps to one PostgreSQL row. The conflict key is `(source_system, external_ref)`.

```sql
INSERT INTO <table> ( ... )
VALUES ( ... )
ON CONFLICT (source_system, external_ref)
DO UPDATE SET
  <all mutable fields> = EXCLUDED.<field>,
  updated_at = NOW();
```

`external_ref` = the Sheets row `id` field (already present on all sheets).  
`source_system` = `'sheets'` for all sync-originated rows.

**What this guarantees:**
- Running sync twice never creates duplicates
- Changed values in Sheets are reflected in PostgreSQL on next run
- New rows in Sheets are inserted
- Rows that existed before and still exist are updated in-place

---

## 5. Deletion Detection

Sheets has no delete log. When a row is deleted in Sheets, it simply disappears.

**Detection algorithm (per table, per run):**

```
seen_refs = set of external_ref values read from Sheets this run

active_pg_refs = SELECT external_ref FROM <table>
                 WHERE source_system = 'sheets'
                   AND is_deleted = FALSE

missing = active_pg_refs - seen_refs

UPDATE <table>
SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
WHERE source_system = 'sheets'
  AND external_ref IN (missing)
```

**This means:** a row hard-deleted from Sheets becomes soft-deleted in PostgreSQL.  
It is never physically removed — historical joins and Spark replays remain intact.

---

## 6. Type Coercion Rules

`SheetsClient.read_sheet()` uses `numericise_ignore=['all']` — every value arrives as a string.  
The sync job is responsible for all coercion before writing to PostgreSQL.

```python
from decimal import Decimal, InvalidOperation
from datetime import date, datetime, timezone
from uuid import uuid4

def to_decimal(val, *, nullable=True) -> Decimal | None:
    if val is None or str(val).strip() == '':
        return None if nullable else Decimal('0')
    try:
        return Decimal(str(val).strip())
    except InvalidOperation:
        return None if nullable else Decimal('0')

def to_int(val, *, nullable=True) -> int | None:
    if val is None or str(val).strip() == '':
        return None if nullable else 0
    try:
        return int(str(val).strip())
    except (ValueError, TypeError):
        return None if nullable else 0

def to_bool(val) -> bool:
    if isinstance(val, bool):
        return val
    return str(val).strip().upper() in ('TRUE', '1', 'YES')

def to_date(val) -> date | None:
    if not val or str(val).strip() == '':
        return None
    try:
        return date.fromisoformat(str(val).strip()[:10])
    except ValueError:
        return None

def to_timestamptz(val) -> datetime | None:
    if not val or str(val).strip() == '':
        return None
    try:
        dt = datetime.fromisoformat(str(val).strip())
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None

def to_text(val, *, max_len=None) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    if s == '':
        return None
    return s[:max_len] if max_len else s
```

---

## 7. Per-Table Field Mapping

### 7a. `rates`

```
Sheets column   → PostgreSQL column  Type        Notes
─────────────────────────────────────────────────────────
id              → external_ref       TEXT        Sheets row ID
currency        → currency           CHAR(3)
rate            → rate               NUMERIC(19,6)
as_of           → as_of              DATE        ISO date string
created_at      → created_at         TIMESTAMPTZ
```

### 7b. `categories`

```
Sheets column             → PostgreSQL column          Type       Notes
────────────────────────────────────────────────────────────────────────
id                        → external_ref               TEXT
major_category            → major_category             TEXT
minor_category            → minor_category             TEXT
applies_to                → applies_to                 TEXT       comma-separated tx types
is_mandatory              → is_mandatory               BOOLEAN
is_subscription_eligible  → is_subscription_eligible   BOOLEAN
created_at                → created_at                 TIMESTAMPTZ
```

### 7c. `accounts`

```
Sheets column   → PostgreSQL column   Type            Notes
──────────────────────────────────────────────────────────────────
id              → external_ref        TEXT            Sheets row ID
name            → name                TEXT
institution     → institution         TEXT            (NULL until Sheets captures it)
type            → type                TEXT
sub_type        → sub_type            TEXT
currency        → currency            CHAR(3)
opening_value   → opening_balance     NUMERIC(19,4)   abs(val) — Sheets stores liabilities negative
current_value   → current_balance     NUMERIC(19,4)   abs(val)
is_active       → is_active           BOOLEAN
description     → notes               TEXT
created_at      → created_at          TIMESTAMPTZ
(future fields) → interest_rate, etc. NUMERIC / DATE  once Sheets schema is extended
```

### 7d. `transactions`

```
Sheets column          → PostgreSQL column        Type            Notes
────────────────────────────────────────────────────────────────────────
id                     → external_ref             TEXT
tx_date_time           → tx_date_time             TIMESTAMPTZ     parse ISO, assume UTC if no tz
tx_type                → tx_type                  TEXT
source_account         → source_account_ref       TEXT            Sheets account ID (not PG UUID)
target_account         → target_account_ref       TEXT            nullable
major_category         → major_category           TEXT
minor_category         → minor_category           TEXT
amount                 → amount                   NUMERIC(19,4)
currency               → currency                 CHAR(3)
amount_base            → amount_base              NUMERIC(19,4)   converted to quote currency
fx_rate                → fx_rate                  NUMERIC(19,6)   nullable
counterparty_name      → counterparty_name        TEXT
description            → description              TEXT
tags                   → tags                     TEXT            semicolon-delimited; kept as-is
tx_location_country    → tx_location_country      TEXT
tx_location_city       → tx_location_city         TEXT
tx_location_area       → tx_location_area         TEXT
notes                  → notes                    TEXT
created_at             → created_at               TIMESTAMPTZ
updated_at             → updated_at               TIMESTAMPTZ
```

**Note on account references in transactions:**  
`source_account` and `target_account` in Sheets hold the Sheets-level account `id` (e.g., `acc-001`), not a PostgreSQL UUID. These are stored as `source_account_ref` / `target_account_ref` (TEXT) in PostgreSQL. A resolved FK column (`source_account_id UUID`) can be populated in a second pass once accounts are synced, by joining on `accounts.external_ref`.

### 7e. `subscriptions`

```
Sheets column       → PostgreSQL column    Type            Notes
───────────────────────────────────────────────────────────────────
id                  → external_ref         TEXT
name                → name                 TEXT
counterparty_name   → counterparty_name    TEXT
amount              → amount               NUMERIC(19,4)
currency            → currency             CHAR(3)
source_account      → source_account_ref   TEXT
major_category      → major_category       TEXT
minor_category      → minor_category       TEXT
billing_cycle       → billing_cycle        TEXT            monthly | quarterly | annual | weekly
next_billing_date   → next_billing_date    DATE
tags                → tags                 TEXT
is_active           → is_active            BOOLEAN
created_at          → created_at           TIMESTAMPTZ
```

---

## 8. Resolved FK Pass

After all tables are upserted, a second pass resolves Sheets-level account IDs to PostgreSQL UUIDs:

```sql
-- Resolve source_account_ref → source_account_id
UPDATE transactions t
SET source_account_id = a.id
FROM accounts a
WHERE a.external_ref     = t.source_account_ref
  AND a.source_system    = 'sheets'
  AND a.is_deleted       = FALSE
  AND t.source_account_id IS DISTINCT FROM a.id;

-- Same for target
UPDATE transactions t
SET target_account_id = a.id
FROM accounts a
WHERE a.external_ref     = t.target_account_ref
  AND a.source_system    = 'sheets'
  AND a.is_deleted       = FALSE
  AND t.target_account_id IS DISTINCT FROM a.id;
```

`source_account_id` and `target_account_id` are nullable UUIDs — not hard foreign keys — so unresolved refs do not block the sync.

---

## 9. Error Handling

| Failure scenario | Behaviour |
|-----------------|-----------|
| Sheet not found | Log warning, skip table, mark `sync_log.status = 'error'`, continue with other tables |
| Row fails type coercion | Log row ID + field + raw value, skip that row, continue batch |
| PostgreSQL connection lost | Abort run, mark all in-progress `sync_log` rows as `'error'` |
| Partial run (tables 1–3 succeed, 4 fails) | Succeeding tables retain their synced state; table 4 retains previous state |
| Duplicate `external_ref` in Sheets | Last row wins (UPSERT natural behaviour) |

No row should ever cause a full run abort — bad rows are logged and skipped.

---

## 10. Sync Frequency

| Mode | Trigger | Latency | Use case |
|------|---------|---------|---------|
| Manual | `python runner.py --job sync` | immediate | on-demand, testing |
| Scheduled (current) | cron / launchd on local machine | ≤ 1 day | daily batch before insights job |
| Incremental (future) | filter Sheets rows by `created_at > last_run` | lower | once data volume grows |

**Current recommendation:** daily full sync, run before the insights job.  
Full sync is correct and simple; incremental adds complexity and is unnecessary at current data volumes (< 50k rows across all tables).

Incremental sync requires a reliable `updated_at` column on every Sheets row — GAS does not automatically maintain this. Would need a GAS trigger to stamp `updated_at` on every write. Revisit when needed.

---

## 11. New Job Structure

The sync job slots into the existing `BaseJob` pattern:

```
job/
  jobs/
    sync/
      __init__.py
      job.py            ← SyncJob(BaseJob) — orchestrates all tables
      coerce.py         ← type coercion helpers (Section 6)
      tables/
        rates.py        ← rates-specific mapping + upsert
        categories.py
        accounts.py
        transactions.py
        subscriptions.py
    insights/           ← existing, unchanged
  runner.py             ← add --job sync
  sheets_client.py      ← unchanged
  config.py             ← add postgres connection config
```

`SyncJob.run()` runs tables in dependency order, logs each to `sync_log`, runs the FK resolution pass at the end.

---

## 12. PostgreSQL Connection Config

Add to `config.py`:

```python
PG_CONFIG_KEYS = ('host', 'port', 'database', 'user', 'password')

def load(env: str) -> dict:
    ...
    pg_cfg = env_cfg.get('postgres', {})
    return {
        ...existing keys...,
        'postgres': {
            'host':     pg_cfg.get('host', 'localhost'),
            'port':     int(pg_cfg.get('port', 5432)),
            'database': pg_cfg.get('database', 'fulcrum'),
            'user':     pg_cfg.get('user'),
            'password': pg_cfg.get('password'),
        },
    }
```

PostgreSQL credentials live in `envs.json` (already gitignored) under `dev.postgres` / `prod.postgres`.

---

## 13. Open Decisions

- [ ] **FK enforcement** — are foreign keys on `transactions.source_account_id` enforced (`REFERENCES accounts(id)`) or advisory (no constraint, just a UUID column)? Advisory is safer for sync order flexibility. Enforced gives referential integrity at the cost of strict ordering.
- [ ] **`tags` column** — keep as semicolon-delimited TEXT in PostgreSQL (matching Sheets), or normalise into a `transaction_tags` junction table for Spark queries? TEXT is simpler; junction table enables tag-level aggregations without `LIKE` / `split`.
- [ ] **`amount_base` recomputation** — `amount_base` in Sheets is computed by GAS using the rates at time of entry. In PostgreSQL, should we trust the stored value or recompute from `amount × fx_rate`? Trusting stored value is safer — it reflects the rate used at transaction time.
- [ ] **Soft delete propagation** — if an account is soft-deleted (removed from Sheets), should its transactions also be soft-deleted in PostgreSQL? Currently: no — transactions remain; the account disappears. Spark jobs filter by `is_deleted = FALSE` on each table independently.

---

## 14. Implementation Checklist

- [ ] Add `postgres` section to `envs.json` (dev + prod)
- [ ] Add postgres config to `config.py`
- [ ] Create `sync_log` table in PostgreSQL
- [ ] Create all 5 PostgreSQL tables (rates, categories, accounts, transactions, subscriptions)
- [ ] Write `coerce.py` with all type helpers
- [ ] Write per-table mapper + upsert for each of the 5 tables
- [ ] Write `SyncJob` orchestrator with dependency ordering
- [ ] Write FK resolution pass
- [ ] Add `--job sync` to `runner.py`
- [ ] Test on dev env with small dataset
- [ ] Validate row counts: Sheets == PostgreSQL active rows
- [ ] Run insights job after sync — confirm no regressions
