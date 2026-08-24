# TASK — currency schema enhancements

**Status:** DONE
**Depends on:** no external modules — within this module: 0003 and 0004 require 0001 (`currency_master` must exist); 0005 requires 0002 (`currency_rates` and views must exist)
**Required by:** ledger-extract transactions module (amounts stored as BIGINT in minor units)

---

## Context

The `ledger-extract` transactions module stores `tx_amount_local` and `tx_amount_base` as `BIGINT` in currency minor units. The minor unit factor for any currency is `10^decimal_places` from `currency_master`.

`currency_master` already has the `decimal_places` column. This task covers three enhancements:

1. **XAU `decimal_places` update** — XAU needs higher precision for personal finance amounts
2. **`minor_unit_name` column** — human-readable name for the lowest denomination of each currency
3. **`currency_rates.rate_value` precision** — increase from `NUMERIC(19,6)` to `NUMERIC(19,8)`

---

## Enhancement 1 — XAU decimal_places

### Problem

XAU is currently seeded with `decimal_places = 2`, meaning 1 XAU (1 gram of gold) = 100 minor units. At ~£76/gram this is too coarse — 1 unit = £0.76, so any transaction not divisible by £0.76 loses precision:

| Transaction | Gold price | XAU value | Minor units (dp=2) | Rounding error |
|---|---|---|---|---|
| £10 | £76/gram | 0.1316 XAU | 13 units | £0.12 (~1.2%) |
| £1  | £76/gram | 0.01316 XAU | 1 unit | £0.24 (~24%) |
| £0.50 | £76/gram | 0.00658 XAU | rounds to 1 | £0.26 (~52%) |

### Decision

**Set XAU `decimal_places = 9`** — so that 1 unit = 1 nanogram of gold. This is a physically meaningful and self-documenting denomination.

`decimal_places = 9` means 1 XAU = 1,000,000,000 minor units (nanograms). At £76/gram:
- £1.00 → 13,157,895 nanograms (error < 1 nanogram = £0.000000076)
- £0.01 → 131,579 nanograms (still excellent precision)

BIGINT holds up to ~9.2 × 10^18. At dp=9, maximum representable XAU amount = 9.2 × 10^9 grams = 9,200 tonnes. For a personal finance app, individual transactions are at most a few hundred grams (e.g. a £100,000 transaction at £76/gram ≈ 1,316 grams ≈ 1.3 × 10^12 nanograms). BIGINT max is 9.2 × 10^18 — seven orders of magnitude above any realistic single transaction. No overflow risk.

### Schema change

| Column | Old value (XAU row) | New value (XAU row) |
|--------|--------------------|--------------------|
| `decimal_places` | `2` | `9` |

The existing CHECK constraint `decimal_places BETWEEN 0 AND 8` must be widened to `BETWEEN 0 AND 9` before the UPDATE can run. A second constraint pins XAU specifically to exactly 9 — preventing any future accidental change. Migration 0003 handles all of this.

---

## Enhancement 2 — minor_unit_name column

### Decision

Add `minor_unit_name TEXT NOT NULL` to `currency_master` to store the human-readable name of the lowest denomination of each currency. Used for display, logging, and tooling clarity.

### Schema change

| Column | Type | Notes |
|--------|------|-------|
| `minor_unit_name` | `TEXT NOT NULL` | Human-readable name for the lowest denomination (e.g. `pence` for GBP, `satoshi` for BTC, `nanogram` for XAU) |

Seed values for all 18 currently tracked currencies:

| `currency_code` | `minor_unit_name` | Notes |
|---|---|---|
| XAU | nanogram | 10^-9 grams; 1 XAU = 1 gram of gold (by design — not troy ounce) |
| USD | cent | |
| EUR | cent | |
| GBP | pence | |
| INR | paisa | |
| JPY | yen | dp=0; same as major unit |
| CNY | fen | |
| AUD | cent | |
| CAD | cent | |
| CHF | centime | |
| SGD | cent | |
| AED | fils | |
| HKD | cent | |
| BRL | centavo | |
| KRW | won | dp=0; same as major unit |
| BTC | satoshi | |
| ETH | szabo | 10^-6 ETH; dp=6 in this system |
| SOL | microsol | dp=6 in this system; no official name at this denomination |

**Convention for future currencies:** any new `currency_master` row must include `minor_unit_name`. For currencies with `decimal_places = 0`, the `minor_unit_name` matches the currency name (e.g. `yen` for JPY).

---

## Enhancement 3 — currency_rates.rate_value precision

### Problem

`currency_rates.rate_value` is stored as `NUMERIC(19,6)`. With XAU precision now at dp=9 (nanogram), rate-induced rounding error on `tx_amount_base` can exceed 1 nanogram for small transactions. Widening to 8 decimal places reduces this error to sub-nanogram levels for all practical personal finance amounts.

Example: GBP rate ~76.000000 at dp=6. At dp=8 this becomes ~76.00000000 — enough to represent rates precise to ~1 nanogram per major unit.

### Decision

Increase `currency_rates.rate_value` from `NUMERIC(19,6)` to `NUMERIC(19,8)` — giving two additional significant figures in the stored rate.

No data is lost — widening NUMERIC precision is always safe. Existing rows retain their values unchanged; the wider type allows more decimal places to be stored going forward.

### Views

Migration 0002 defines two views that reference `rate_value`:

- `v_latest_rates` — returns the most recent rate per currency (DISTINCT ON, ordered by rate_date DESC)
- `v_rates_to_gbp` — computes cross-rates to GBP as `gbp.rate_value / r.rate_value`

Both views reference `rate_value` and have no active consumers — no Python code queries them. They will be dropped in migration 0005 and not recreated. Drop order matters: `v_rates_to_gbp` depends on `v_latest_rates`, so it must be dropped first.

---

## What to build

- [x] `migrations/0003_update_xau_decimal_places.py` — widen CHECK constraint, pin XAU to dp=9, UPDATE XAU row

```sql
ALTER TABLE currency_master DROP CONSTRAINT IF EXISTS chk_cm_decimal_places;
ALTER TABLE currency_master ADD CONSTRAINT chk_cm_decimal_places CHECK (decimal_places BETWEEN 0 AND 9);
UPDATE currency_master SET decimal_places = 9, updated_at = NOW() WHERE currency_code = 'XAU';
ALTER TABLE currency_master ADD CONSTRAINT chk_cm_xau_dp_pinned CHECK (currency_code != 'XAU' OR decimal_places = 9);
```

Verify:
```sql
SELECT currency_code, currency_name, decimal_places FROM currency_master WHERE currency_code = 'XAU';
-- Expected: XAU | Gold (per gram) | 9

SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_cm_xau_dp_pinned';
-- Expected: CHECK (((currency_code)::text <> 'XAU'::text) OR (decimal_places = 9))
```

- [x] `migrations/0004_add_minor_unit_name.py` — ADD minor_unit_name column and seed all 18 currencies

```sql
ALTER TABLE currency_master ADD COLUMN IF NOT EXISTS minor_unit_name TEXT;

UPDATE currency_master SET minor_unit_name = 'nanogram' WHERE currency_code = 'XAU';
UPDATE currency_master SET minor_unit_name = 'cent'     WHERE currency_code = 'USD';
UPDATE currency_master SET minor_unit_name = 'cent'     WHERE currency_code = 'EUR';
UPDATE currency_master SET minor_unit_name = 'pence'    WHERE currency_code = 'GBP';
UPDATE currency_master SET minor_unit_name = 'paisa'    WHERE currency_code = 'INR';
UPDATE currency_master SET minor_unit_name = 'yen'      WHERE currency_code = 'JPY';
UPDATE currency_master SET minor_unit_name = 'fen'      WHERE currency_code = 'CNY';
UPDATE currency_master SET minor_unit_name = 'cent'     WHERE currency_code = 'AUD';
UPDATE currency_master SET minor_unit_name = 'cent'     WHERE currency_code = 'CAD';
UPDATE currency_master SET minor_unit_name = 'centime'  WHERE currency_code = 'CHF';
UPDATE currency_master SET minor_unit_name = 'cent'     WHERE currency_code = 'SGD';
UPDATE currency_master SET minor_unit_name = 'fils'     WHERE currency_code = 'AED';
UPDATE currency_master SET minor_unit_name = 'cent'     WHERE currency_code = 'HKD';
UPDATE currency_master SET minor_unit_name = 'centavo'  WHERE currency_code = 'BRL';
UPDATE currency_master SET minor_unit_name = 'won'      WHERE currency_code = 'KRW';
UPDATE currency_master SET minor_unit_name = 'satoshi'  WHERE currency_code = 'BTC';
UPDATE currency_master SET minor_unit_name = 'szabo'    WHERE currency_code = 'ETH';
UPDATE currency_master SET minor_unit_name = 'microsol' WHERE currency_code = 'SOL';

-- Safety check: all 18 rows must be seeded before setting NOT NULL
SELECT COUNT(*) FROM currency_master WHERE minor_unit_name IS NULL;
-- Expected: 0 — if > 0, identify the missed row(s) and fix before proceeding

ALTER TABLE currency_master ALTER COLUMN minor_unit_name SET NOT NULL;
```

Verify:
```sql
SELECT currency_code, minor_unit_name FROM currency_master ORDER BY currency_rank NULLS FIRST;

SELECT is_nullable
FROM information_schema.columns
WHERE table_name = 'currency_master' AND column_name = 'minor_unit_name';
-- Expected: NO
```

- [x] `migrations/0005_update_rate_value_precision.py` — drop unused views, widen rate_value to NUMERIC(19,8)

```sql
DROP VIEW IF EXISTS v_rates_to_gbp;
DROP VIEW IF EXISTS v_latest_rates;

ALTER TABLE currency_rates ALTER COLUMN rate_value TYPE NUMERIC(19, 8);
```

Verify:
```sql
SELECT column_name, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name = 'currency_rates' AND column_name = 'rate_value';
-- Expected: numeric_precision=19, numeric_scale=8
```

---

## Impact on other modules

- `ledger-extract`: reads `currency_master.decimal_places` and `minor_unit_name` at job startup; reads `currency_rates.rate_value` at per-row processing. All three migrations must run before the transactions module is executed.
- No other active consumer exists.
