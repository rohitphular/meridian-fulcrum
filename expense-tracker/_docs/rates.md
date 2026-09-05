# Rates

Exchange rate table for converting transaction amounts and account balances into the base currency. The base currency is **XAU (1 gram of gold)** — fixed, rate = 1, and never editable.

Schema reference: [data-model.md § Rate](data-model.md#rate).

## Rate convention

All rates are stored as **units of that currency per 1 gram of gold (1 XAU)**.

Example: with base = XAU:
- `INR = 7000` means 1g of gold costs ₹7,000
- `USD = 85` means 1g of gold costs $85
- XAU does **not** appear in the rates table — it is the fixed base (rate = 1) and is handled implicitly

## Capabilities

- View all configured currencies with current rate, symbol, and last-updated timestamp
- Upsert (update or insert) a rate for any non-base currency
- Auto-seed a default rate set on first run when the store is empty (`GBP, INR, USD, EUR, AED`) — XAU is the base and is never seeded as a row
- Base currency (XAU) is always rate = 1, never editable, and not stored in the rates table

## Rules

| Rule | Detail |
|---|---|
| Base currency (XAU) | XAU is the fixed base (1g gold = rate 1). It is not stored as a row in the rates table. The backend rejects any attempt to upsert a rate for XAU. |
| `rate` value | Must be > 0. Zero or negative is rejected. |
| `symbol` | Optional. If blank, the currency code itself is used as the display prefix. Server-side validation rejects HTML-meaningful characters (`<`, `>`, `&`, `"`, `'`, `` ` ``, `\`) and caps length at 8 chars — symbol strings render into HTML across the frontend (balance cells, insight cards, transaction amounts), so they must never carry script payloads. |
| `currency` code | Server-side validation: 1–8 chars, alphanumeric only (`[A-Za-z0-9]`). Same rationale — the code is interpolated into HTML in `?` warning badges and elsewhere. |
| `ui_label` / rate display | Rate is labelled "Rate (per 1g XAU)" in the UI — meaning how many units of this currency equal 1 gram of gold. |
| Symbol editing | Symbol is not editable through the app — only via direct store edit. (Symbols change rarely; this avoids accidental edits during routine rate updates.) |
| Upsert semantics | If the currency exists, the row is updated; otherwise a new row is appended. Editing a rate never duplicates the row. |
| Adding a new currency through the UI | Not supported. Add a row to the store directly (currency + symbol), then edit the rate through the app. |
| Deletion FK-guarded | Refuses with `{ ok: false, error: 'currency_in_use_by_accounts', referenced_count: N }` when any account holds the currency, or `currency_in_use_by_transactions` when any transaction is recorded in it. An account's currency cannot be changed after creation, so the recovery path is to delete the affected accounts/transactions first. Without this guard, deletion silently broke net-worth and per-account totals (`toBase` falls back to 1:1 on a missing rate). |
| Missing rate | When a transaction's currency is not in the rates table, the conversion must **signal an error** — it does not fall back to 1:1. The UI shows a `?` badge on the affected row and the backend returns a `rate_not_found` error for any operation that requires conversion. After the FK guard, this state should only occur if the underlying store was edited directly. |

## Conversion function

```
toBase(amount, currency)
  rate = rates[currency]                                       # global rate
  if rate is missing or 0: raise RateNotFoundError(currency)  # no silent fallback
  return amount / rate
```

Note the division — rates are stored as `currency-units per 1 XAU`, so to convert *to* XAU you divide. A missing or zero rate must throw/signal an error; silent 1:1 fallback is banned.

For cross-currency transfers, the effective rate is implicit in the two stored `tx_amount_local` values (one per leg). The display layer may show a `†` marker when the implied leg ratio differs from the current global rate, but no separate `fx_rate` column is stored on the transaction row.

## Historical rates

NOT supported. A single current rate per currency applies to all transactions regardless of date. For cross-currency transfers, the effective rate is preserved implicitly in the two stored `tx_amount_local` values — one per transfer leg — so the balance reversal on edit or delete remains exact even if the global rate changes later.

## API surface

| Operation | Behaviour |
|---|---|
| `list_rates` | Return all rows; seed defaults if empty |
| `upsert_rate` | Validate `rate > 0` and currency ≠ base; update existing row or append new one; refresh `updated_at` |

## Form behaviour

- Each non-base row shows an Edit button. Clicking opens an inline form with the rate field only.
- Keyboard: `Enter` to save, `Escape` to cancel.
- After save, the in-memory rate map is updated immediately so all downstream displays (insight, transactions, accounts net worth) reflect the new rate without a full reload.

## Known structural gaps

The Rate entity has only 4 columns (`currency`, `symbol`, `rate`, `updated_at`). It is missing `record_status`, `sync_status`, `sync_date_time`, `sync_notes`, and `created_at`. Consequences:

- No lifecycle control — rates cannot be soft-deleted or locked through the app; they must be removed directly from the store.
- No sync audit trail — the sync pipeline cannot signal a failed rate update on the row.
- No creation timestamp — there is no record of when a currency was first added.

These gaps are tracked in [data-model.md § Known gaps](data-model.md#known-gaps) and are acknowledged design omissions, not bugs.
