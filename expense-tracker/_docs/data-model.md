# Data Model

All entity shapes. Field types are abstract — choose a concrete type appropriate to your platform (e.g. `string`, `number`, `boolean`, `timestamp`, `decimal`). The reference implementation stores everything as strings in a spreadsheet; a relational or document store would use stricter types.

## Identity & timestamps

| Convention | Format | Example |
|---|---|---|
| Transaction ID | `YYYY-MM-DD-NNN` (single creates) or `YYYY-MM-DD-XXXXXXXX` (bulk creates, date + UUID hex) | `2026-06-22-007` / `2026-06-22-a3f9c12b` |
| Account ID | `ACC-YYYYMMDD-NNN` — date + sequential counter per day | `ACC-20260622-003` |
| Timestamps (`tx_date_local`, `created_at`, etc.) | Local time (YYYY-MM-DD HH:MM:SS) | `2026-06-22 14:30:00` |
| Dates (e.g. subscription dates) | ISO-8601 date (no time) | `2026-06-22` |

## Account

14-column schema.

| Col | Field | Type | Required | Editable after create | Notes |
|---|---|---|---|---|---|
| 1 | `id` | string | auto | no | `ACC-YYYYMMDD-NNN` |
| 2 | `name` | string | yes | yes | Display label |
| 3 | `type` | enum | yes | no | `asset` \| `investment` \| `liability` |
| 4 | `sub_type` | enum | yes | yes | Required for all types; valid values depend on type. See [Sub-types](#sub-types). |
| 5 | `currency` | ISO-4217 string | yes | no | Must exist in `rates` |
| 6 | `opening_value` | number | yes | no | Balance at import. User enters positive for liabilities; store negates it. |
| 7 | `current_value` | number | derived | no (system-managed) | Computed at read time as `opening_value + sum(transactions)` via `_buildAccountNetMap`. The sheet stores `opening_value` at creation; `current_value` is never written back to the sheet after that. Stored negative for liabilities; UI displays `abs(current_value)` labelled "owed" — user never sees a negative number. |
| 8 | `description` | string | optional | yes | Free text notes |
| 9 | `record_status` | enum | default `active` | yes | `active` \| `inactive` \| `deleted` \| `locked`. Deleted accounts are soft-deleted; locked accounts cannot be edited or deleted. |
| 10 | `sync_status` | enum | auto | no | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed`. Set by system on every mutation; cleared by sync job. |
| 11 | `sync_date_time` | timestamp | auto | no | Set by sync job on successful sync. |
| 12 | `sync_notes` | string | auto | no | Set by sync job; cleared on next mutation. |
| 13 | `created_at` | timestamp | auto | no | UTC ISO. Set once on create. |
| 14 | `updated_at` | timestamp | auto | no | UTC ISO. Updated on every mutation. |

### Account types

```
asset:       sub_type ∈ { current, savings, cash }
investment:  sub_type ∈ { stocks_shares, isa, pension_sipp, crypto, fixed_deposit,
                          bonds, property, commodities, p2p_lending, other }
liability:   sub_type ∈ { personal_loan, credit_card, mortgage, auto_loan, heloc,
                          student_loan, medical_loan, debt_consolidation, overdraft }
```

### Sub-types

`sub_type` is required for all account types. Valid values per type:

| type | valid sub_type values |
|---|---|
| `asset` | `current`, `savings`, `cash` |
| `investment` | `stocks_shares`, `isa`, `pension_sipp`, `crypto`, `fixed_deposit`, `bonds`, `property`, `commodities`, `p2p_lending`, `other` |
| `liability` | `personal_loan`, `credit_card`, `mortgage`, `auto_loan`, `heloc`, `student_loan`, `medical_loan`, `debt_consolidation`, `overdraft` |

## Transaction

24-column single-leg schema. Each row represents one account movement. A cross-account transfer produces two linked rows — see [Transfer pattern](#transfer-pattern) below.

**Currency is not stored on transactions — it is derived at runtime from the linked account (`account_id → account.currency`).**

Audit block: `record_status → sync_status → sync_date_time → sync_notes → created_at → updated_at`.

| Col | Field | Type | Required | Notes |
|---|---|---|---|---|
| 1 | `id` | string | auto | `YYYY-MM-DD-NNN` for single creates; `YYYY-MM-DD-XXXXXXXX` (date + UUID hex) for bulk creates |
| 2 | `tx_date_local` | timestamp | yes | Local time as `YYYY-MM-DD HH:MM:SS` — no UTC conversion |
| 3 | `tx_timezone_local` | string | optional | IANA timezone string e.g. `Europe/London`; auto-detected in browser, immutable after creation |
| 4 | `parent_tx_id` | string | conditional | FK to the parent transaction row for transfers; empty on standalone rows and on the parent (money-out) row. Only the child (derived) row carries the parent's `id` as its `parent_tx_id`. |
| 5 | `tx_type` | enum | yes | `money-in` \| `money-out`. No `money-transfer` type exists. |
| 6 | `account_id` | Account ID | yes | The single account affected by this row. |
| 7 | `tx_amount_local` | number | yes | Always positive. `tx_type` determines direction: `money-in` credits the account; `money-out` debits it. |
| 8 | `major_category` | string | yes | References `categories.major_category_key` |
| 9 | `minor_category` | string | yes | References `categories.minor_category_key` |
| 10 | `description` | string | optional | Free text |
| 11 | `counterparty_name` | string | optional | Merchant, employer, payer, etc. |
| 12 | `tx_tags` | string | optional | Semicolon-separated |
| 13 | `beneficiaries` | string | optional | Semicolon-separated names |
| 14 | `user_location_area` | string | optional | Sub-district / neighbourhood |
| 15 | `user_location_city` | string | optional | City |
| 16 | `user_location_country` | string | optional | Country |
| 17 | `user_location_latitude` | number | optional | GPS latitude |
| 18 | `user_location_longitude` | number | optional | GPS longitude |
| 19 | `record_status` | enum | default `active` | `active` \| `inactive` \| `deleted` \| `locked`. Deleted transactions are soft-deleted; the row stays in the sheet. Locked rows cannot be edited or deleted. |
| 20 | `sync_status` | enum | auto | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed` |
| 21 | `sync_date_time` | timestamp | auto | Set by sync job on successful sync |
| 22 | `sync_notes` | string | auto | Set by sync job; cleared on next mutation |
| 23 | `created_at` | timestamp | auto | UTC ISO. Set once on create. |
| 24 | `updated_at` | timestamp | auto | UTC ISO. Updated on every mutation. |

### Transfer pattern

A transfer (moving money between owned accounts) produces **two rows** linked via `parent_tx_id`:

- **Row A (money-out, parent):** `account_id` = source account, `tx_type` = `money-out`, `tx_amount_local` = amount in the source account's currency. `parent_tx_id` = empty.
- **Row B (money-in, child):** `account_id` = target account, `tx_type` = `money-in`, `tx_amount_local` = amount in the target account's currency. `parent_tx_id` = Row A's `id`.

The effective exchange rate is **implicit**: `rate = Row B.tx_amount_local ÷ Row A.tx_amount_local`. No `fx_rate` column is stored; no `[FX: …]` marker is embedded in `description`. If both accounts share the same currency, Row B's `tx_amount_local` equals Row A's `tx_amount_local`.

## Subscription

22-column schema. Recurring payment obligations — planning and awareness layer only. Subscriptions never post to an account balance and never generate transactions automatically. The actual debit, when it occurs, is recorded as a separate transaction.

| Col | Field | Type | Required | Notes |
|---|---|---|---|---|
| 1 | `id` | string | auto | `SUB-YYYYMMDD-NNN` |
| 2 | `name` | string | yes | Display label |
| 3 | `counterparty_name` | string | optional | Merchant or payee |
| 4 | `amount` | number | yes | Always positive |
| 5 | `currency` | ISO-4217 string | yes | Currency of the subscription amount |
| 6 | `frequency` | enum | yes | `weekly` \| `monthly` \| `quarterly` \| `annual` |
| 7 | `day_of_month` | number | conditional | 1–31; required when `frequency = monthly`, `quarterly`, or `annual` |
| 8 | `day_of_week` | number | conditional | 1–7 (1=Monday … 7=Sunday); required when `frequency = weekly` |
| 9 | `source_account` | Account ID | yes | References `accounts.id` — the account this subscription charges. |
| 10 | `tx_type` | enum | optional | `money-in` \| `money-out`. Defaults to blank if not supplied. |
| 11 | `major_category` | string | optional | References `categories.major_category_key` |
| 12 | `minor_category` | string | optional | References `categories.minor_category_key` |
| 13 | `tags` | string | optional | Semicolon-delimited in storage; displayed as comma-separated in the UI. Named `tags` on subscriptions; the equivalent field on transactions is `tx_tags`. |
| 14 | `description` | string | optional | Free text |
| 15 | `record_status` | enum | default `active` | `active` \| `inactive` \| `deleted` \| `locked` |
| 16 | `created_at` | timestamp | auto | UTC ISO. Set once on create. |
| 17 | `sync_status` | enum | auto | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed` |
| 18 | `sync_date_time` | timestamp | auto | Set by sync job on successful sync |
| 19 | `sync_notes` | string | auto | Set by sync job; cleared on next mutation |
| 20 | `updated_at` | timestamp | auto | UTC ISO. Updated on every mutation. |
| 21 | `subscription_start_date` | date | optional | ISO-8601 date; when the subscription began |
| 22 | `subscription_end_date` | date | optional | ISO-8601 date; when the subscription ends or ended |

## Category

20-column schema. No `id` column — `(tx_type_key, major_category_key, minor_category_key)` is the composite key.

| Col | Field | Type | Required | Notes |
|---|---|---|---|---|
| 1 | `tx_type_key` | enum | yes | `money-in` \| `money-out` |
| 2 | `tx_type_label` | string | derived | `Money In` or `Money Out`; written by backend |
| 3 | `major_category_key` | string | derived | Slugified form of `major_category_label`; written by backend |
| 4 | `major_category_label` | string | yes | Top-level grouping |
| 5 | `minor_category_key` | string | derived | Slugified form of `minor_category_label`; written by backend |
| 6 | `minor_category_label` | string | yes | Sub-classification |
| 7 | `description` | string | optional | Free text |
| 8 | `tag_keywords` | string | optional | Comma-separated; lowercased on save; used for auto-classification hints |
| 9 | `counterparty_examples` | string | optional | Comma-separated merchant/payer examples |
| 10 | `source_account_types` | string | optional | Comma-separated allowed source account sub-types (e.g. `current, savings`). The value `'investment'` is also valid as a shorthand that matches all investment account sub-types. |
| 11 | `target_account_types` | string | optional | Comma-separated allowed target account sub-types. The value `'investment'` is valid as a shorthand (same as above). |
| 12 | `source_account_mandatory` | boolean | optional | If true, `source_account` must be specified on transactions of this category type |
| 13 | `target_account_mandatory` | boolean | optional | If true, `target_account` must be specified on transactions of this category type |
| 14 | `is_subscription_eligible` | boolean | default false | Marks category as usable for subscription tracking |
| 15 | `record_status` | enum | default `active` | `active` \| `inactive` \| `deleted` \| `locked` |
| 16 | `sync_status` | enum | auto | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed` |
| 17 | `sync_date_time` | timestamp | auto | Set by sync job on successful sync |
| 18 | `sync_notes` | string | auto | Set by sync job; cleared on next mutation |
| 19 | `created_at` | timestamp | auto | Set once on create |
| 20 | `updated_at` | timestamp | auto | Updated on every mutation |

The `*_mandatory` columns let categories require that a source or target account field is specified on transactions. The `*_types` columns constrain which account sub-types are allowed (e.g. *Loan repayment* restricts target to loan sub-types). The backend validates these on transaction save.

## Rate

4-column schema. No surrogate `id` — `currency` is the natural primary key.

| Col | Field | Type | Notes |
|---|---|---|---|
| 1 | `currency` | ISO-4217 string | Primary key. 1–8 alphanumeric chars. |
| 2 | `symbol` | string | Display prefix (`£`, `$`, `₹`, …); optional. Max 8 chars; HTML-meaningful chars rejected. |
| 3 | `rate` | number > 0 | Units of this currency per 1 gram of gold (XAU). Must be > 0. |
| 4 | `updated_at` | timestamp | UTC ISO. Set by the upsert operation. |

The base currency (XAU) is **not stored as a row** — it is the implicit fixed base with `rate = 1`. Example: if 1 gram of gold = 7000 INR, then INR's `rate = 7000`. Other rows can be upserted.

**Note:** The Rate entity has no `record_status`, `sync_status`, `sync_date_time`, `sync_notes`, or `created_at` columns. See Known gaps below.

## Audit entry

| Field | Type | Notes |
|---|---|---|
| `ip` | string | Primary identifier |
| `city`, `country`, `user_agent` | string | Optional metadata, populated by geolookup |
| `first_seen_at`, `last_seen_at` | timestamp | UTC ISO |
| `attempts`, `successes`, `failures` | number | Running totals |
| `is_locked` | boolean | True after `MAX_FAILURES` consecutive failures |

## Cross-entity invariants

1. Every `account.currency` MUST exist in `rates`.
2. Every `transaction.account_id` MUST reference an existing account row.
3. For transfer rows: the money-out row (parent) has an empty `parent_tx_id`; the money-in row (child) carries the money-out row's `id` as its `parent_tx_id`. A child row with a `parent_tx_id` that has no matching parent row is flagged as an incomplete transfer.
4. A transaction's `major`/`minor` MAY reference a deleted category — the strings are stored as-is; orphan category references do not break reads. When a category's `major_category_label`, `minor_category_label`, or `tx_type_key` is changed via `update_category` such that the composite key `(tx_type_key, major_category_key, minor_category_key)` changes, the backend checks whether any transaction or subscription rows reference the old key. If dependent rows exist, the rename is rejected with `category_key_change_has_dependents` unless `force: true` is passed in the request — in which case the caller accepts responsibility for updating dependent rows (the backend does not cascade the rename). If no dependent rows exist, the rename proceeds without restriction.
5. `account.current_value` is computed at read time by scanning the transactions sheet (`_buildAccountNetMap`) — it is never written back to the sheet after initial creation. The account API never writes it directly; `opening_value` is the only balance-related value persisted to the sheet on create.
6. Account deletion does not cascade to transactions; transactions retain stale `account_id` references.

## Known gaps

Acknowledged schema omissions. These are not bugs — the system works without them — but they limit future capabilities and are tracked here for planned additions.

| Entity | Missing field | Impact |
|---|---|---|
| **Rate** | `record_status`, `sync_status`, `sync_date_time`, `sync_notes`, `created_at` | No lifecycle or sync audit trail for rate rows. The sync job has no way to signal a failed rate update. Rates also have no soft-delete semantics. |
| **Account** | `opening_date` | No record of when an account was opened. Needed for loan amortisation calculations, time-weighted return computation, and account-age insights. |
| **Transaction** | `subscription_id` FK | No link from a transaction back to the subscription that originated it. Manual reconciliation is the only way to know which transactions were created from a subscription. |
| **Category** | No surrogate `id` | Identity is the composite key `(tx_type_key, major_category_key, minor_category_key)`. Updates and deletes use `row_num` (sheet position) as the addressing handle, which the frontend must preserve and pass back. |
| **Subscription** | `last_payment_date` | No record of when the last payment was actually made. `next_payment_date` is computed from the frequency anchor, not from actual payment history. |
| **Subscription** | Category FK validation | Subscriptions do not have category FK validation — a subscription can be created or updated with a `major_category` / `minor_category` that doesn't exist in the categories sheet. The `_buildCategoryMap` check is only applied during transaction validation. |
