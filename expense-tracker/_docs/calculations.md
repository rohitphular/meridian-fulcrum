# Calculations and product decisions

Every figure the app shows is computed by the GAS backend and returned ready to render. The browser formats numbers and dates for display and colours values by server-given keys (tone, style, status); it does not convert currencies, sum, filter, sort, page, bucket dates or validate. This page is the single reference for the definitions the server applies. They were chosen deliberately during the dumb-UI refactor and change some numbers compared with the old client (see [What changed](#what-changed-from-the-old-client)).

| Concern | Implemented in |
|---|---|
| Balance replay, snapshots, periods, transfer pairing, flow eligibility | `api/ledger-core.gs` (`ldg*`) |
| Currency conversion to the quote currency | `api/fx-utils.gs` (`fx*`) |
| Request context (`quote_currency`, `tz`, `today`), envelopes, per-request dataset | `api/view-context.gs` (`vm*`) |
| Screen view models | `api/view-*.gs`, `api/insights-*.gs` (see [api/README.md](../api/README.md#view-gets)) |
| Write-path validation and business rules | entity `*-validation.gs` files; see [financial-rules.md](financial-rules.md) |

## Net worth, assets and liabilities

One definition everywhere: Accounts summary cards, Home, every insight, and the advisor context.

- **Accounts counted:** all non-deleted accounts, whatever their status (`active`, `inactive`, `locked`). Deleted accounts never count.
- **Assets:** accounts of type `asset` or `investment`, at their current balance converted to the quote currency.
- **Liabilities:** accounts of type `liability`. Balances are stored negative (money owed); a liability in credit is positive and reduces total liabilities.
- **Net worth:** assets + liabilities (liabilities are negative).
- **Liquid cash** (Accounts card): asset accounts whose account type maps to the deposit detail sheet.
- **Current balance:** `opening_value_local` plus every eligible movement after the tracking cutoff, future-dated rows included (the same rule `listAccounts` uses). See [balance-lifecycle.md](balance-lifecycle.md).

Implementation: `ldgNetWorth(ledger, ldgCurrentBalances(ledger), fx)`.

## Income, spending and cash flow

Income, spending, savings, cash-flow, category, tag, counterparty, geography and daily-spend figures count only **flow-eligible** transactions (`ldgFlowKind`):

- **Deleted transactions are excluded.**
- **Transfers between own accounts are excluded.** A row is an own-transfer leg when it is a child (`parent_tx_id` set) or a parent with a live child. Loan, credit-card and mortgage repayments, account-to-account moves and currency exchanges are all transfer pairs, so repayment and paydown insights read ledger balances or the transfer pairs instead of flows.
- `money-in` is income, `money-out` is spending.

Balance replays (current balances, net-worth trends, balances at a date) still include transfer legs, because they move money between accounts. The Transactions list shows every leg, including transfer legs and deleted rows, and has no income/spending totals.

## Periods and dates

- **Today** is the zoned date on the server for the request `tz` (browser IANA zone, default `Europe/London`). Tests may pass a validated `today=` override.
- **Inclusive of today.** `last_N` days is today and the N − 1 days before (`last_30` = 30 days). `this_month`, `this_quarter`, `ytd` and `last_N` months end today: the N calendar months ending with the current month, current month to date.
- **Complete periods.** `last_week` (ISO, Monday start), `last_month`, `last_quarter` and `last_year` are the previous full calendar period.
- **Compare periods** are the previous span of equal length (or the same span a year earlier where an insight says so).
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

View GETs are cached (CacheService, up to 10 minutes) under a key made of `data_version`, action and every param including `quote_currency`, `tz` and `today`. `data_version` changes after every successful POST and on manual Sheet edits (`onEdit`). Payloads over 90 KB are not cached and are recomputed on each request; exports are never cached.

## What changed from the old client

| Figure | Old client | Now |
|---|---|---|
| Home total assets | Always 0 (read non-existent `current_value` / `currency` fields), so net worth = −debt | Assets and liabilities per the definition above |
| Net worth on Home / Insights / Advisor | Active accounts only; insights 01–06 treated every non-liability as an asset | All non-deleted accounts; assets = asset + investment |
| Income and spending | Deleted rows and own-account transfer legs were counted | Both excluded |
| Insight `last_30` | today − 30 (31 days) | today − 29 (30 days) |
| Insight `last_N` months, `this_month` | Ended at month end | End today |
| Invalid-date rows in insights | Parsed with `new Date(...)` (browser-dependent, Safari differed) | Recorded wall date parsed as text; unreadable dates excluded from flows |
| Date-only transaction dates in balance replays | Counted by the client replay | Skipped, as `listAccounts` already did |
