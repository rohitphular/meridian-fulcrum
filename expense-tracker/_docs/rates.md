# Rates

Exchange rate table for converting transaction amounts and account balances into the base currency. The base currency (GBP in the reference implementation) is fixed and read-only.

Schema reference: [data-model.md § Rate](data-model.md#rate).

## Rate convention

All rates are stored as **units of that currency per 1 unit of base currency**.

Example: with base = GBP:
- `INR = 105` means £1 = ₹105
- `USD = 1.27` means £1 = $1.27
- The base currency itself is always present as `GBP = 1`

## Capabilities

- View all configured currencies with current rate, symbol, and last-updated timestamp
- Upsert (update or insert) a rate for any non-base currency
- Auto-seed a default rate set on first run when the store is empty (`GBP, INR, USD, EUR, AED`)
- Base currency row is always present, always rate = 1, never editable

## Rules

| Rule | Detail |
|---|---|
| Base currency row | Read-only. No Edit button rendered; backend rejects updates to base. |
| `rate` value | Must be > 0. Zero or negative is rejected. |
| `symbol` | Optional. If blank, the currency code itself is used as the display prefix. Server-side validation rejects HTML-meaningful characters (`<`, `>`, `&`, `"`, `'`, `` ` ``, `\`) and caps length at 8 chars — symbol strings render into HTML across the frontend (balance cells, insight cards, transaction amounts), so they must never carry script payloads. |
| `currency` code | Server-side validation: 1–8 chars, alphanumeric only (`[A-Za-z0-9]`). Same rationale — the code is interpolated into HTML in `?` warning badges and elsewhere. |
| Symbol editing | Symbol is not editable through the app — only via direct store edit. (Symbols change rarely; this avoids accidental edits during routine rate updates.) |
| Upsert semantics | If the currency exists, the row is updated; otherwise a new row is appended. Editing a rate never duplicates the row. |
| Adding a new currency through the UI | Not supported. Add a row to the store directly (currency + symbol), then edit the rate through the app. |
| Deletion FK-guarded | Refuses with `{ ok: false, error: 'currency_in_use_by_accounts', referenced_count: N }` when any account holds the currency, or `currency_in_use_by_transactions` when any transaction is recorded in it. An account's currency cannot be changed after creation, so the recovery path is to delete the affected accounts/transactions first. Without this guard, deletion silently broke net-worth and per-account totals (`toBase` falls back to 1:1 on a missing rate). |
| Missing rate | When a transaction's currency is not in the rates table, conversions fall back to `amount × 1` and the UI shows a `?` badge on the affected row. After the FK guard, this should only occur if the underlying store was edited directly. |

## Conversion function

```
toBase(amount, currency, fx_rate_or_blank)
  if fx_rate_or_blank > 0: return amount / fx_rate_or_blank   # row-level rate, units of currency per 1 base
  rate = rates[currency]                                       # global rate
  if rate is missing or 0: return amount                       # fallback
  return amount / rate
```

Note the division — rates are stored as `currency-units per 1 base-unit`, so to convert *to* base you divide.

The row-level `fx_rate` on a transaction (when present) wins over the global rate. This means a transfer's stored rate continues to apply correctly even if the user later updates the global rate.

## Historical rates

NOT supported. A single current rate per currency applies to all transactions regardless of date. Users who need point-in-time accuracy must record the row-level `fx_rate` on each cross-currency transaction.

## API surface

| Operation | Behaviour |
|---|---|
| `list_rates` | Return all rows; seed defaults if empty |
| `upsert_rate` | Validate `rate > 0` and currency ≠ base; update existing row or append new one; refresh `updated_at` |

## Form behaviour

- Each non-base row shows an Edit button. Clicking opens an inline form with the rate field only.
- Keyboard: `Enter` to save, `Escape` to cancel.
- After save, the in-memory rate map is updated immediately so all downstream displays (insight, transactions, accounts net worth) reflect the new rate without a full reload.
