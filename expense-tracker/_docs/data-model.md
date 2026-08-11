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
| `is_active` | boolean | default true | yes | Archived accounts hide from transaction forms |
| `notes` | string | optional | yes | Free text |
| `created_at` | timestamp | auto | no | UTC ISO |

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

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | auto | `YYYY-MM-DD-NNN` |
| `transaction_date_utc` | timestamp | yes | ISO UTC |
| `transaction_type` | enum | yes | `money-in` \| `money-out` \| `money-transfer` |
| `amount` | number | yes | Must be > 0; in `source_account`'s currency for out/transfer, in `target_account`'s currency for money-in |
| `currency` | ISO-4217 | yes | Derived at save time from the relevant account |
| `source_account` | Account ID | type-dependent | Required for `money-out` and `money-transfer`; omitted for `money-in` |
| `target_account` | Account ID | type-dependent | Required for `money-transfer`; required for `money-in`; optional for `money-out` (used for repayments to owned accounts) |
| `major_category` | string | for in/out | References `categories.major_category`; omitted for `money-transfer` |
| `minor_category` | string | for in/out | References `categories.minor_category` |
| `counterparty` | string | optional | Merchant, employer, payer, etc. |
| `country` | string | optional | Where it happened |
| `tags` | string | optional | Semicolon-separated on storage; comma-separated in UI input |
| `notes` | string | optional | Free text |
| `fx_rate` | number > 0 | conditional | Required when `source_account.currency ≠ target_account.currency` |
| `transfer_id` | string | reserved | Not currently populated |
| `payment_method` | string | reserved | Not currently populated |

## Category

| Field | Type | Required | Notes |
|---|---|---|---|
| `transaction_type` | enum | yes | `money-in` \| `money-out` \| `money-transfer` |
| `major_category` | string | yes | Top-level grouping |
| `minor_category` | string | yes | Sub-classification |
| `description` | string | optional | Free text |
| `tag_keywords` | string | optional | Comma-separated; lowercased on save; reserved for auto-classification |
| `is_active` | boolean | default true | Archived categories hide from transaction forms |
| `source_account_mandatory` | boolean | optional | Hint: source account must be present |
| `source_account_types` | string | optional | Comma-separated allowed source account types |
| `target_account_mandatory` | boolean | optional | Hint: target account must be present |
| `target_account_types` | string | optional | Comma-separated allowed target account types |

The `*_mandatory` and `*_types` columns let categories declare account-type contracts (e.g. *Credit card payment* requires `source = current` and `target = credit_card`). The backend validates these on save and rejects mismatched transactions.

## Rate

| Field | Type | Notes |
|---|---|---|
| `currency` | ISO-4217 string | Primary key |
| `symbol` | string | Display only (`£`, `$`, `₹`, …); optional |
| `rate` | number > 0 | Units of this currency per 1 base currency |
| `updated_at` | timestamp | UTC ISO |

The base currency row (`GBP` in the reference) is read-only with rate = 1. Other rows can be upserted.

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
