# Rates

The base currency is **XAU: one gram of gold**. Rates exposed by the API are currency units per gram of XAU. The user may choose another display currency without changing the base.

## Convention and compatibility

`GBP = 80` means one gram of gold costs £80. XAU is fixed at 1 and cannot be edited or deleted. The API includes an XAU row; when absent from an existing XAU-relative sheet, it supplies that row in the response.

Older versions seeded GBP-relative rates, including an XAU row containing grams per GBP. Reads normalise all rates by that XAU value, preserving every cross-currency ratio without changing stored rows. An explicit successful rate upsert persists the whole table on the XAU basis in one write, preventing mixed conventions. Existing tables without an XAU row are treated as XAU-relative. Invalid or duplicate currency rows fail validation rather than being guessed.

An empty sheet is seeded with illustrative GBP, XAU, INR, USD and EUR rates. These are setup examples, not current market quotes; replace them before relying on valuations.

## Conversion

```text
converted_amount = amount / rates[source_currency] * rates[display_currency]
```

For XAU display, the destination rate is 1. Missing, nonpositive or nonfinite rates produce an unavailable conversion (`NaN`, displayed as an em dash by the formatting helper). Invalid amounts are not silently replaced by zero.

The app uses a single current rate per currency. Historical FX rates remain outside this module; cross-currency transfer amounts retain their original implicit ratio.

## API and UI

| Action | Behavior |
|---|---|
| `list_rates_view` | GET view model for the Currencies tab: search, sort, rate labels, base flag, `allowed_actions` and the accounts using each currency. |
| `list_rates` | Return XAU-relative rates; seed illustrative defaults only if empty. Read by the server for every conversion; the current app does not call it (kept for the previous frontend). |
| `upsert_rate` | Validate and insert/update a non-XAU currency; normalise legacy rows together on write. `mode: 'create'` (sent by the Add form) refuses a currency that already exists (`rate_already_exists`); blank or `'upsert'` overwrites (the Edit form). |
| `delete_rate` | Physically remove a non-XAU rate only if no account references its currency. |

The Rates section supports Add, Edit and Delete. Symbols are editable. Saves dispatch `et:reload` to refresh all dependent data. GBP is editable; XAU is read-only.

Currency codes are trimmed and uppercased; the API accepts 1–8 alphanumeric characters. This display-rate flexibility is separate from account/extraction currency eligibility: account creation requires exactly three ASCII letters and an available Sheet rate; PostgreSQL extraction additionally requires the currency catalog and dated rates managed by `currency-rates`. Rates must be decimal text or numbers, finite and greater than zero; hexadecimal, `1e` and `Infinity` are rejected. The forms send the rate as typed and show the server's error. Symbols are optional, at most eight characters, and may not contain HTML-meaningful characters or a backslash. Omitting a symbol on update preserves it.

Deletion checks `account_master.account_currency_local`, including inactive/deleted account rows, since historical transactions derive currency from their account. There is no transaction currency column to scan separately.

## Errors and schema

Errors include `missing_currency`, `invalid_currency_code`, `base_currency_readonly`, `missing_rate`, `rate_must_be_positive`, `rate_already_exists`, `invalid_rate_mode`, `invalid_rate_table`, `symbol_too_long`, `invalid_symbol_characters`, `currency_in_use_by_accounts`, and `not_found`. `upsert_rate` failures also carry `field` (`currency`, `rate`, `symbol` or `mode`) and a human `message`.

The four stored columns are `currency`, `rate`, `symbol`, and `updated_at`. Rates have no soft-delete state or sync audit columns.
