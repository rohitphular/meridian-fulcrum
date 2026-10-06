# Calculations and product decisions

Every figure the app shows is computed by the GAS backend and returned ready to render. The browser formats numbers and dates for display and colours values by server-given keys (tone, style, status); it does not convert currencies, sum, filter, sort, page, bucket dates or validate. This page is the single reference for the definitions the server applies. They were chosen deliberately during the dumb-UI refactor and change some numbers compared with the old client (see [What changed](#what-changed-from-the-old-client)).

| Concern | Implemented in |
|---|---|
| Periods, transfer pairing, tracking-start cutoff | `api/ledger-core.gs` (`ldg*`) |
| Currency conversion to the quote currency | `api/fx-utils.gs` (`fx*`) |
| Request context (`quote_currency`, `tz`, `today`), envelopes, per-request dataset | `api/view-context.gs` (`vm*`) |
| Screen view models | `api/view-*.gs` (see [api/README.md](../api/README.md#view-gets)) |
| Write-path validation and business rules | entity `*-validation.gs` files; see [financial-rules.md](financial-rules.md) |

## Periods and dates

- **Today** is the zoned date on the server for the request `tz` (browser IANA zone, default `Europe/London`). Tests may pass a validated `today=` override.
- **Inclusive of today.** `last_N` days is today and the N − 1 days before (`last_30` = 30 days). `this_month`, `this_quarter`, `ytd` and `last_N` months end today: the N calendar months ending with the current month, current month to date.
- **Complete periods.** `last_week` (ISO, Monday start), `last_month`, `last_quarter` and `last_year` are the previous full calendar period.
- **Compare periods** are the previous span of equal length.
- **Transaction dates** filter and bucket by the recorded wall date of `tx_date_local` (`ldgTxDateKey`), parsed as text, never with `new Date('YYYY-MM-DD HH:MM:SS')`. A row whose date cannot be read is listed in the Transactions `warn_rows` and never silently dropped from the list.
- **Balance snapshots** compare instants: a zoned account's tracking cutoff is compared with the movement's instant in its own zone (blank zone = Europe/London); legacy unzoned accounts compare wall times.
- **Transactions list range `all`** is unbounded at both ends.

Implementation: `ldgPeriodBounds(period, today, from, to)`, `LDG_PERIODS`, `LDG_PERIOD_LABELS`.

## Currency conversion

- Rates are units of each currency per gram of gold (XAU = 1). A value converts as `amount / rate[from] × rate[quote]`.
- A missing, zero, negative or non-finite rate makes the value **unavailable**: it is excluded from totals and the response carries a `missing_rate` warning naming the currencies. It is never converted 1:1 and never counted as zero.
- Current rates apply to every date (no historical rates).
- Money fields carry the native amount and currency with the quote value (`fxMoney`); the UI shows both when they differ.

## Subscriptions

`list_subscriptions_view` computes each row's `next_payment_date`, `due_in_days` and `schedule_status` on the server. The monthly estimate converts each scheduled subscription to the quote currency and normalises by frequency (weekly × 52 ÷ 12, quarterly ÷ 3, annual ÷ 12).

## Caching

View GETs are cached (CacheService, up to 10 minutes) under a key made of `data_version`, action and every param including `quote_currency`, `tz` and `today`. `data_version` changes on manual Sheet edits (`onEdit`) and after a POST that may have changed data. A successful POST bumps it unless it reports numeric `created: 0` and `updated: 0` with no `references_migrated > 0`, `catalog_written` or `deleted`; single-record actions (no counts) always bump it. A failed POST bumps it when it reports `sheet_written: true`, a non-empty `deleted` list, or `created` / `updated` / `deleted` above 0. `dry_run` requests and `advisor_chat`, `clear_advisor_history` and `fill_csv_ids` never bump it. Payloads over 90 KB are not cached and are recomputed on each request; exports are never cached.
