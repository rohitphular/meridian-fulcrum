# Data Model

All entity shapes. Field types are abstract — choose a concrete type appropriate to your platform (e.g. `string`, `number`, `boolean`, `timestamp`, `decimal`). The reference implementation stores everything as strings in a spreadsheet; a relational or document store would use stricter types.

## Identity & timestamps

| Convention | Format | Example |
|---|---|---|
| Transaction ID | `YYYY-MM-DD-NNN` — date + sequential counter per day | `2026-06-22-007` |
| Account ID | `ACC-YYYYMMDD-NNN` — date + sequential counter per day | `ACC-20260622-003` |
| Timestamps (`*_utc`, `created_at`) | ISO-8601 UTC | `2026-06-22T14:30:00.000Z` |
| Dates (e.g. loan dates) | ISO-8601 date (no time) | `2026-06-22` |

## Account

| Field | Type | Required | Editable after create | Notes |
|---|---|---|---|---|
| `id` | string | auto | no | `ACC-YYYYMMDD-NNN` |
| `name` | string | yes | yes | Display label |
| `type` | enum | yes | no | `asset` \| `investment` \| `liability` |
| `sub_type` | enum | yes | yes | Required for all types; valid values depend on type. See [Sub-types](#sub-types). |
| `currency` | ISO-4217 string | yes | no | Must exist in `rates` |
| `opening_value` | number | optional | no | Balance at import. User enters positive for liabilities; store negates it. |
| `current_value` | number | derived | no (system-managed) | Updated by transaction lifecycle. Stored negative for liabilities; UI displays `abs(current_value)` labelled "owed" — user never sees a negative number. |
| `description` | string | optional | yes | Free text notes |
| `record_status` | enum | default `active` | yes | `active` \| `inactive` \| `deleted` \| `locked`. Deleted accounts are soft-deleted; locked accounts cannot be edited or deleted. |
| `sync_status` | enum | auto | no | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed`. Set by system on every mutation; cleared by sync job. |
| `sync_date_time` | timestamp | auto | no | Set by sync job on successful sync. |
| `sync_notes` | string | auto | no | Set by sync job; cleared on next mutation. |
| `created_at` | timestamp | auto | no | UTC ISO. Set once on create. |
| `updated_at` | timestamp | auto | no | UTC ISO. Updated on every mutation. |

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

26-column schema. Audit block: `record_status → sync_status → sync_date_time → sync_notes → created_at → updated_at`.

| Col | Field | Type | Required | Notes |
|---|---|---|---|---|
| 1 | `id` | string | auto | `YYYY-MM-DD-NNN` — date + sequential counter per day |
| 2 | `tx_date_time` | timestamp | yes | ISO UTC |
| 3 | `tx_timezone` | string | optional | IANA timezone string e.g. `Europe/London` |
| 4 | `tx_type` | enum | yes | `money-in` \| `money-out` |
| 5 | `source_account` | Account ID | type-dependent | Required for `money-out`; omitted for `money-in`. Category `source_account_mandatory` flag may require it for `money-in`. |
| 6 | `target_account` | Account ID | type-dependent | Required for `money-in`; optional for `money-out` (repayments). Category `target_account_mandatory` flag may require it. |
| 7 | `user_location_area` | string | optional | Sub-district / neighbourhood |
| 8 | `user_location_city` | string | optional | City |
| 9 | `user_location_country` | string | optional | Country |
| 10 | `user_location_latitude` | number | optional | GPS latitude |
| 11 | `user_location_longitude` | number | optional | GPS longitude |
| 12 | `source_amount` | number | yes | Must be > 0; amount in the source account's currency (or target account's for `money-in`) |
| 13 | `target_amount` | number | conditional | Amount credited to the target account when source/target currencies differ; blank when same-currency or no target account |
| 14 | `currency` | ISO-4217 | auto | Derived at save time from the relevant account |
| 15 | `major_category` | string | yes (in/out) | References `categories.major_category_label` |
| 16 | `minor_category` | string | yes (in/out) | References `categories.minor_category_label` |
| 17 | `description` | string | optional | Free text |
| 18 | `counterparty_name` | string | optional | Merchant, employer, payer, etc. |
| 19 | `tx_tags` | string | optional | Semicolon-separated |
| 20 | `beneficiaries` | string | optional | Semicolon-separated names |
| 21 | `record_status` | enum | default `active` | `active` \| `inactive` \| `deleted` \| `locked`. Deleted transactions are soft-deleted; the row stays in the sheet. Locked rows cannot be edited or deleted. |
| 22 | `sync_status` | enum | auto | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed` |
| 23 | `sync_date_time` | timestamp | auto | Set by sync job on successful sync |
| 24 | `sync_notes` | string | auto | Set by sync job; cleared on next mutation |
| 25 | `created_at` | timestamp | auto | UTC ISO. Set once on create. |
| 26 | `updated_at` | timestamp | auto | UTC ISO. Updated on every mutation. |

Transfers (moving money between owned accounts) are modelled as a category whose `source_account_mandatory` and `target_account_mandatory` are both true — not as a separate `tx_type`. `target_amount` captures the credited amount when source and target currencies differ.

`fx_rate` is not a stored column — when a cross-currency conversion note is needed, the backend appends an `[FX: …]` marker to `description`. The stored row-level rate is embedded in that marker and used for balance reversal on edit/delete.

## Category

| Field | Type | Required | Notes |
|---|---|---|---|
| `tx_type_key` | enum | yes | `money-in` \| `money-out` |
| `tx_type_label` | string | derived | `Money In` or `Money Out`; written by backend |
| `major_category_key` | string | derived | Slugified form of `major_category_label`; written by backend |
| `major_category_label` | string | yes | Top-level grouping |
| `minor_category_key` | string | derived | Slugified form of `minor_category_label`; written by backend |
| `minor_category_label` | string | yes | Sub-classification |
| `description` | string | optional | Free text |
| `tag_keywords` | string | optional | Comma-separated; lowercased on save; used for auto-classification hints |
| `counterparty_examples` | string | optional | Comma-separated merchant/payer examples |
| `source_account_types` | string | optional | Comma-separated allowed source account sub-types |
| `target_account_types` | string | optional | Comma-separated allowed target account sub-types |
| `source_account_mandatory` | boolean | optional | If true, transactions of this category must specify a source account |
| `target_account_mandatory` | boolean | optional | If true, transactions of this category must specify a target account |
| `is_subscription_eligible` | boolean | default false | Marks category as usable for subscription tracking |
| `record_status` | enum | default `active` | `active` \| `inactive` \| `deleted` \| `locked` |
| `sync_status` | enum | auto | `create-pending` \| `update-pending` \| `in-sync` \| `create-failed` \| `update-failed` |
| `sync_date_time` | timestamp | auto | Set by sync job on successful sync |
| `sync_notes` | string | auto | Set by sync job; cleared on next mutation |
| `created_at` | timestamp | auto | Set once on create |
| `updated_at` | timestamp | auto | Updated on every mutation |

The `*_mandatory` and `*_types` columns let categories declare account-type contracts (e.g. *Loan repayment* requires `target` ∈ loan sub-types). The backend validates these on transaction save and rejects mismatched submissions.

## Rate

| Field | Type | Notes |
|---|---|---|
| `currency` | ISO-4217 string | Primary key |
| `symbol` | string | Display only (`£`, `$`, `₹`, …); optional |
| `rate` | number > 0 | Units of this currency per 1 base currency |
| `updated_at` | timestamp | UTC ISO |

The base currency row (`XAU`) is read-only with rate = 1. Other rows can be upserted.

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
2. Every `transaction.source_account` and `transaction.target_account` MUST reference an existing account row.
3. A transaction's `major`/`minor` MAY reference a deleted category — the strings are stored as-is; orphan category references do not break reads.
4. `account.current_value` is **only ever mutated by the transaction lifecycle** (create/update/delete), never written directly through the account API.
5. Account deletion does not cascade to transactions; transactions retain stale `source_account`/`target_account` IDs.
