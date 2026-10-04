# Rates

The base currency is **XAU: one gram of gold**. Rates are currency units per gram of XAU. The user may choose another display currency without changing the base.

## Source: published from PostgreSQL

The `rates` tab is owned by [forex-database-load](../../data-synchronization/forex-database-load/README.md) (mode `publish-sheet`). It rewrites the tab from PostgreSQL in one write: the latest rate of every currency in `currency_master` that has one, its symbol, the rate's own date and the publish time. **Nothing in the app edits rates**: there is no add, edit or delete, and GAS never creates, seeds or writes the tab. A missing or empty tab reads as XAU only, so every other currency shows as missing until rates are published.

## Convention and compatibility

`GBP = 80` means one gram of gold costs £80. XAU is 1. Older sheets stored GBP-relative rates with an XAU row holding grams per GBP; reads still normalise all rates by that XAU value (every cross-currency ratio preserved), without writing. A table without an XAU row is treated as XAU-relative. Invalid or duplicate currency rows fail with `invalid_rate_table`.

## Conversion

```text
converted_amount = amount / rates[source_currency] * rates[display_currency]
```

For XAU display, the destination rate is 1. Missing, nonpositive or nonfinite rates produce an unavailable conversion (a `missing_rate` warning; displayed as an em dash). Amounts are never converted 1:1 or replaced by zero. Published reports are in XAU and are converted with these rates when read.

## API and UI

| Action | Behavior |
|---|---|
| `list_rates_view` | GET view model for the Currencies tab: sort (sheet order, currency, rate, rate date, published time), rate labels, `rate_date`, base flag, which accounts use each currency. Every row is `readonly` with no `allowed_actions`. |
| `list_rates` | Return the XAU-relative rates. Read by the server for every conversion. |

The Currencies section lists the rates read-only, with each rate's date and the publish time.

## Schema

The five columns are `currency`, `rate`, `symbol`, `updated_at` (publish time, UTC) and `rate_date` (the date of the rate in PostgreSQL). Rates have no soft-delete state or sync columns: the tab is replaced on every publish.
