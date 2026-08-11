# Currencies — Schema Design

**Quote currency:** `GBP` — all reporting aggregations convert to GBP.  
**Base currency for rates:** `XAU` (gold, per gram) — no sovereign issuer, stable long-term real-value denominator.  
**Rate history:** Daily, from `2020-01-01` to present.  
**Data source:** Dedicated daily fetch job — no relation to Google Sheets.

---

## Why XAU as Base

All rates are stored as: **"units of currency per 1 gram of gold."**

- No fiat bias in the denominator — USD itself inflates; triangulating through it masks real purchasing-power shifts over years
- Drift in `GBP/XAU` means GBP is weakening, not gold behaving unusually — long-term net-worth and spend analysis stays honest
- Cross-rate math is identical regardless of base — only the denominator changes:

```
amount_GBP = amount_foreign × (rate_GBP / rate_foreign)
```

---

## Tables

### `currency_master`

One row per currency. Static reference data — seeded once, updated only when a new currency is added.  
Natural primary key on the ISO 4217 three-letter code — stable, globally recognised, makes joins self-documenting.

```sql
CREATE TABLE currency_master (
  currency_code   CHAR(3)      NOT NULL,
  currency_name   TEXT         NOT NULL,
  currency_symbol TEXT         NOT NULL,
  decimal_places  SMALLINT     NOT NULL DEFAULT 2,
  currency_type   TEXT         NOT NULL,
  is_tracked      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT currency_master_pkey     PRIMARY KEY (currency_code),
  CONSTRAINT chk_cm_code_length       CHECK (char_length(currency_code) = 3),
  CONSTRAINT chk_cm_currency_type     CHECK (currency_type IN ('fiat', 'commodity', 'crypto')),
  CONSTRAINT chk_cm_decimal_places    CHECK (decimal_places BETWEEN 0 AND 8)
);

CREATE TRIGGER trg_currency_master_updated_at
  BEFORE UPDATE ON currency_master
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
```

| Column | Type | Notes |
|--------|------|-------|
| `currency_code` | `CHAR(3)` | ISO 4217. PK. `XAU` for gold, `BTC` for Bitcoin. |
| `currency_name` | `TEXT` | Full English name — `"Pound Sterling"`, `"Gold (per gram)"` |
| `currency_symbol` | `TEXT` | Display symbol — `£`, `$`, `€`, `₹`, `₿` |
| `decimal_places` | `SMALLINT` | `0` for JPY and KRW; `2` for most fiat and XAU; `8` for BTC |
| `currency_type` | `TEXT` | `'fiat'` / `'commodity'` / `'crypto'` |
| `is_tracked` | `BOOLEAN` | `TRUE` = rate job fetches this currency daily |

---

### `currency_rates`

Time-series. One row per `(currency_code, rate_date)`. Written daily by the rate-fetch job, backfilled to `2020-01-01`.  
Hard FK to `currency_master` on both `currency_code` and `base_currency_code` — a rate for an unregistered currency cannot exist.

```sql
CREATE TABLE currency_rates (
  rate_id            UUID          NOT NULL DEFAULT gen_random_uuid(),
  currency_code      CHAR(3)       NOT NULL,
  rate_date          DATE          NOT NULL,
  rate_value         NUMERIC(19,6) NOT NULL,
  base_currency_code CHAR(3)       NOT NULL DEFAULT 'XAU',
  rate_source        TEXT          NOT NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT currency_rates_pkey      PRIMARY KEY (rate_id),
  CONSTRAINT uq_cr_currency_date      UNIQUE (currency_code, rate_date),
  CONSTRAINT fk_cr_currency_code      FOREIGN KEY (currency_code)      REFERENCES currency_master (currency_code),
  CONSTRAINT fk_cr_base_currency_code FOREIGN KEY (base_currency_code) REFERENCES currency_master (currency_code),
  CONSTRAINT chk_cr_rate_positive     CHECK (rate_value > 0),
  CONSTRAINT chk_cr_base_is_xau      CHECK (base_currency_code = 'XAU')
);

CREATE INDEX idx_cr_currency_date ON currency_rates (currency_code, rate_date DESC);

CREATE TRIGGER trg_currency_rates_updated_at
  BEFORE UPDATE ON currency_rates
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
```

| Column | Type | Notes |
|--------|------|-------|
| `rate_id` | `UUID` | Surrogate PK — `(currency_code, rate_date)` is the natural key but UUID keeps FK patterns consistent |
| `currency_code` | `CHAR(3)` | FK → `currency_master.currency_code` |
| `rate_date` | `DATE` | Calendar date this rate applies to |
| `rate_value` | `NUMERIC(19,6)` | Units of `currency_code` per 1 gram of gold — e.g., GBP ≈ 80, USD ≈ 103, INR ≈ 8600 |
| `base_currency_code` | `CHAR(3)` | Always `'XAU'` — explicit column, enforced by CHECK and FK |
| `rate_source` | `TEXT` | API identifier — e.g., `'frankfurter'`, `'coingecko'`, `'goldapi.io'` |

---

## Shared Trigger

Both tables use the same `updated_at` trigger function (consistent with the rest of the schema):

```sql
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;
```

---

## Seed Data

```sql
INSERT INTO currency_master (currency_code, currency_name, currency_symbol, decimal_places, currency_type, is_tracked) VALUES
  -- Commodity
  ('XAU', 'Gold (per gram)',      'XAU',  2, 'commodity', TRUE),
  -- Fiat
  ('USD', 'US Dollar',            '$',    2, 'fiat',      TRUE),
  ('EUR', 'Euro',                 '€',    2, 'fiat',      TRUE),
  ('CNY', 'Chinese Yuan',         'CN¥',  2, 'fiat',      TRUE),
  ('INR', 'Indian Rupee',         '₹',    2, 'fiat',      TRUE),
  ('JPY', 'Japanese Yen',         '¥',    0, 'fiat',      TRUE),
  ('GBP', 'Pound Sterling',       '£',    2, 'fiat',      TRUE),
  ('AUD', 'Australian Dollar',    'A$',   2, 'fiat',      TRUE),
  ('CAD', 'Canadian Dollar',      'C$',   2, 'fiat',      TRUE),
  ('CHF', 'Swiss Franc',          'CHF',  2, 'fiat',      TRUE),
  ('SGD', 'Singapore Dollar',     'S$',   2, 'fiat',      TRUE),
  ('AED', 'UAE Dirham',           'AED',  2, 'fiat',      TRUE),
  ('HKD', 'Hong Kong Dollar',     'HK$',  2, 'fiat',      TRUE),
  ('BRL', 'Brazilian Real',       'R$',   2, 'fiat',      TRUE),
  ('KRW', 'South Korean Won',     '₩',    0, 'fiat',      TRUE),
  -- Crypto
  ('BTC', 'Bitcoin',              '₿',    8, 'crypto',    TRUE),
  ('ETH', 'Ethereum',             'Ξ',    6, 'crypto',    TRUE),
  ('SOL', 'Solana',               'SOL',  6, 'crypto',    TRUE);
```

---

## Views

### `v_latest_rates` — most recent rate per currency

```sql
CREATE VIEW v_latest_rates AS
SELECT DISTINCT ON (currency_code)
  currency_code,
  rate_value,
  rate_date,
  base_currency_code,
  rate_source
FROM currency_rates
ORDER BY currency_code, rate_date DESC;
```

### `v_rates_to_gbp` — pre-computed cross-rate to GBP (latest)

```sql
CREATE VIEW v_rates_to_gbp AS
SELECT
  r.currency_code,
  r.rate_date,
  r.rate_value                    AS rate_vs_xau,
  gbp.rate_value                  AS gbp_vs_xau,
  gbp.rate_value / r.rate_value   AS rate_to_gbp
FROM v_latest_rates r
JOIN v_latest_rates gbp ON gbp.currency_code = 'GBP';
```

Usage:
```sql
-- Convert any foreign amount to GBP in one join
SELECT t.amount * x.rate_to_gbp AS amount_gbp
FROM transactions t
JOIN v_rates_to_gbp x ON x.currency_code = t.currency;
```

---

## Point-in-Time Lookup

`v_rates_to_gbp` uses latest rates. For historical accuracy — required for Spark analytics — join against the rate that was current on the transaction date:

```sql
SELECT
  t.id,
  t.amount,
  t.currency,
  t.amount * (r_gbp.rate_value / r_src.rate_value) AS amount_gbp_historical
FROM transactions t
JOIN LATERAL (
  SELECT rate_value FROM currency_rates
  WHERE currency_code = t.currency
    AND rate_date     <= t.tx_date_time::DATE
  ORDER BY rate_date DESC
  LIMIT 1
) r_src ON TRUE
JOIN LATERAL (
  SELECT rate_value FROM currency_rates
  WHERE currency_code = 'GBP'
    AND rate_date     <= t.tx_date_time::DATE
  ORDER BY rate_date DESC
  LIMIT 1
) r_gbp ON TRUE;
```

In Spark, replace the lateral join with:
```python
Window.partitionBy("currency").orderBy("as_of").rowsBetween(Window.unboundedPreceding, 0)
last("rate").over(w)
```
Both `rate` columns must be typed as `DecimalType(19, 6)` — never `DoubleType`.

---

## Data Sources

No single free API covers fiat, metals, and crypto. Three sources are used — one per category. All return USD-denominated rates; XAU-base conversion is applied in the job after fetching.

### Conversion to XAU base

Every API returns rates vs USD. The job converts to XAU-base (per gram) in one pass:

```
rate_vs_xau[currency] = rate_vs_usd[currency] × gold_usd_per_gram
```

i.e. if gold = $103/gram and 1 USD = 83.5 INR → 1 gram gold = 8,592.5 INR → `rate_value = 8592.5`.

---

### Fiat — Frankfurter

**URL:** `https://api.frankfurter.app`  
**Cost:** Free. No API key. No rate limit.  
**Covers:** USD, EUR, CNY, INR, JPY, GBP, AUD, CAD, CHF, SGD, HKD, BRL, KRW (13 of 14 fiat)  
**AED:** Hardcoded at `3.6725` per USD — official peg in place since 1997, never changes.  
**Historical:** Available from 1999. Backfill from `2020-01-01` is trivial.

**Daily call** — one request returns all 13 currencies:
```
GET https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CNY,INR,AUD,CAD,CHF,SGD,HKD,BRL,KRW
```

**Backfill call** — same endpoint, date in path:
```
GET https://api.frankfurter.app/2020-01-15?from=USD&to=EUR,GBP,JPY,CNY,INR,AUD,CAD,CHF,SGD,HKD,BRL,KRW
```

---

### Crypto — CoinGecko

**URL:** `https://api.coingecko.com/api/v3`  
**Cost:** Free tier. No API key for basic endpoints. Rate limit: ~30 req/min.  
**Covers:** BTC, ETH, SOL  

**Daily call** — one request for all 3:
```
GET /simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd
```

**Backfill call** — one request per coin returns the full date range (3 calls total for entire history):
```
GET /coins/bitcoin/market_chart/range?vs_currency=usd&from={unix_start}&to={unix_end}
GET /coins/ethereum/market_chart/range?vs_currency=usd&from={unix_start}&to={unix_end}
GET /coins/solana/market_chart/range?vs_currency=usd&from={unix_start}&to={unix_end}
```

Returns `prices` as `[[timestamp_ms, price], ...]` — parse into daily rows.

---

### Gold — goldapi.io (daily) + stooq.com (backfill)

**Covers:** XAU only — price per gram.

#### Daily forward — goldapi.io

**URL:** `https://www.goldapi.io/api`  
**Cost:** Free tier — 100 req/month.  
**Usage:** 1 call/day × 31 days = 31 req/month — well within limit.  
**API key:** Required — store in `envs.json` under `dev.goldapi_key` / `prod.goldapi_key`.

```
GET https://www.goldapi.io/api/XAU/USD
```

Response includes `price_gram_24k` — use this directly as `gold_usd_per_gram`. No conversion needed.

#### Backfill — stooq.com

**URL:** `https://stooq.com/q/d/l/`  
**Cost:** Free. No API key. No rate limit. CSV download.  
**Coverage:** Full history back to 2000+.  
**Usage:** One-time download, ingested directly into `currency_rates`.

```
https://stooq.com/q/d/l/?s=xauusd&d1=20200101&d2=20251231&i=d
```

Returns CSV: `Date, Open, High, Low, Close, Volume` — `Close` is price per troy ounce.  
**Convert to per gram:** `Close ÷ 31.1035` before storing as `rate_value`.

---

### Source summary

| Source | Currencies | Daily | Backfill | Key needed |
|--------|-----------|-------|---------|------------|
| Frankfurter | 13 fiat + AED hardcoded | ✓ | ✓ | No |
| CoinGecko | BTC, ETH, SOL | ✓ | ✓ | No |
| goldapi.io | XAU (per gram) | ✓ | ✗ | Yes |
| stooq.com | XAU (per gram, ÷31.1035) | ✗ | ✓ one-time | No |

---

## Rate-Fetch Job

```
job/
  jobs/
    currency_rates/
      __init__.py
      job.py            ← CurrencyRatesJob(BaseJob) — daily run + backfill mode
      sources/
        frankfurter.py  ← fiat fetcher
        coingecko.py    ← crypto fetcher
        goldapi.py      ← gold fetcher (daily, per gram)
        stooq.py        ← gold fetcher (backfill CSV, converts troy oz → gram)
```

**Daily run** (`CurrencyRatesJob.run()`):
1. Fetch gold price per gram from goldapi.io — 1 call → `gold_usd_per_gram`
2. Fetch fiat rates from Frankfurter — 1 call
3. Fetch crypto rates from CoinGecko — 1 call
4. Hardcode AED = USD rate × 3.6725
5. Convert all to XAU base using `gold_usd_per_gram`
6. Upsert into `currency_rates` — idempotent:
   ```sql
   INSERT INTO currency_rates (currency_code, rate_date, rate_value, base_currency_code, rate_source)
   VALUES (%s, %s, %s, 'XAU', %s)
   ON CONFLICT (currency_code, rate_date)
   DO UPDATE SET rate_value = EXCLUDED.rate_value, rate_source = EXCLUDED.rate_source, updated_at = NOW();
   ```
7. Log: currencies fetched, any absent from API response, any failures

**Backfill mode** (`--backfill 2020-01-01`):
- Fiat: iterates dates from `2020-01-01` to yesterday, one Frankfurter call per date
- Crypto: 3 CoinGecko range calls cover the entire period in one shot
- Metals: ingests stooq.com CSVs (pre-downloaded) — no API calls
- Skips `(currency_code, rate_date)` pairs already present — re-entrant, safe to stop and restart

---

## Open Decisions

- [ ] **`amount_base` recomputation** — once `currency_rates` is live with XAU-based history, decide whether to recompute `amount_base` on transactions using point-in-time XAU rates, or keep trusting the GAS-computed value. Deferred.
