# Data Sync — Job Structure

Location: `forge/expense-tracker/job/data_sync/`

This is an umbrella job that owns all data-sync concerns. Lives directly under `job/` — separate from the existing `jobs/` folder, which will be addressed later.

---

## Folder Layout

```
job/
  data_sync/
    __init__.py
    job.py                        ← DataSyncJob — top-level orchestrator

    currency_rates/
      __init__.py
      job.py                      ← CurrencyRatesJob — daily fetch + backfill
      sources/
        __init__.py
        frankfurter.py            ← fiat rates (13 currencies vs USD)
        coingecko.py              ← crypto rates (BTC, ETH, SOL vs USD)
        goldapi.py                ← gold price per gram, daily forward only
        stooq.py                  ← gold price per gram, backfill from CSV

    sheets_sync/
      __init__.py
      job.py                      ← SheetsSyncJob — Sheets → PostgreSQL
      coerce.py                   ← type coercion helpers (string → typed)
      tables/
        __init__.py
        rates.py                  ← rates sheet mapper + upsert
        categories.py             ← categories sheet mapper + upsert
        accounts.py               ← accounts sheet mapper + upsert
        transactions.py           ← transactions sheet mapper + upsert
        subscriptions.py          ← subscriptions sheet mapper + upsert
```

---

## Responsibilities

### `DataSyncJob`
Top-level orchestrator. Runs sub-jobs in the correct order:
1. `CurrencyRatesJob` — must run first; other jobs may depend on rates being current
2. `SheetsSyncJob` — syncs all five Sheets tables into PostgreSQL

### `CurrencyRatesJob`
- **Daily run:** fetches today's rates from Frankfurter, CoinGecko, goldapi.io; converts to XAU base; upserts into `currency_rates`
- **Backfill mode** (`--backfill 2020-01-01`): replays from a start date; re-entrant

### `SheetsSyncJob`
- Full read of each Sheets tab → type coerce → upsert into PostgreSQL
- Runs tables in dependency order: rates → categories → accounts → transactions → subscriptions
- Soft-deletes rows absent from Sheets
- FK resolution pass after all tables complete
- Logs each table's outcome to `sync_log`

---

## Runner Changes Needed

The current `runner.py` instantiates jobs with `(sheets, cfg)`. `DataSyncJob` also needs a PostgreSQL connection. Runner will need a `pg_client` argument added and passed through when `data_sync` jobs are run.

---

## Sub-job Source Files

| File | Source | Covers | Key constraint |
|------|--------|--------|---------------|
| `frankfurter.py` | api.frankfurter.app | 13 fiat + AED hardcoded | Free, no key, no limit |
| `coingecko.py` | api.coingecko.com | BTC, ETH, SOL | ~30 req/min free |
| `goldapi.py` | goldapi.io | XAU per gram, daily | 100 req/month free |
| `stooq.py` | stooq.com CSV | XAU per gram, backfill | One-time download; Close ÷ 31.1035 |
| `coerce.py` | — | type casting for Sheets strings | Shared across all table mappers |
