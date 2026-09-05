# Subscriptions

A registry of recurring payment obligations tracked in the app. Subscriptions represent future commitments — services, memberships, or any recurring charge — rather than actual spend. They are distinct from transactions: a subscription is never posted to an account balance and never affects Net Worth. It is a planning and awareness layer, not a ledger entry.

Schema reference: subscription-schema.gs, subscription-core.gs, subscription-validation.gs.

## Overview

Subscriptions differ from transactions in two fundamental ways:

1. **They are obligations, not events.** A subscription records that a payment _will_ recur on a schedule. The actual debit, when it occurs, is recorded as a separate transaction on the transactions sheet.
2. **Next payment date is computed, not stored.** The sheet holds only the frequency and the day anchor (`day_of_month` or `day_of_week`). `next_payment_date` is derived at read time by `computeNextPaymentDate()` and appended to the response object — it is never written to the sheet.

## Schema

21 columns, append-only positions.

| # | Field | Type | Editable | Description |
|---|---|---|---|---|
| 1 | `id` | string | No | System-generated ID. Format: `SUB-YYYYMMDD-NNN` (e.g. `SUB-20260829-001`). Counter resets per calendar day; `NNN` is padded to 3 digits and incremented from the highest existing ID with the same date prefix. |
| 2 | `name` | string | Yes | User-facing display name for the subscription. Must be unique across non-deleted subscriptions (case-insensitive, trimmed). |
| 3 | `counterparty_name` | string | Yes | Merchant, provider, or payee name. Optional. |
| 4 | `subscription_amount_local` | number | Yes | Recurring charge amount in the source account's local currency. Currency is derived at display time from `state.accountMap[source_account].local_currency` — it is not stored on the subscription row. Must be a positive number. |
| 5 | `frequency` | enum | Yes | Recurrence cadence. Valid values: `weekly`, `monthly`, `quarterly`, `annual`. Determines which schedule anchor field is required. |
| 6 | `day_of_month` | number | Yes | Day of the month (1–31) on which payment falls. Required when `frequency` is `monthly`, `quarterly`, or `annual`. Values that exceed the month's length are clamped to the last day of that month at runtime. Blank for `weekly` subscriptions. |
| 7 | `day_of_week` | number | Yes | Day of the week (1=Monday … 7=Sunday). Required when `frequency` is `weekly`. Blank for all other frequencies. |
| 8 | `source_account` | string | Yes | Account ID (FK to `accounts.id`) from which the payment is drawn. Required. Displayed in the UI via `state.accountMap` keyed by this ID. Also the source of the subscription's currency (via `local_currency` on the account). |
| 9 | `tx_type` | enum | Yes | Direction of the payment. Valid values: `money-in`, `money-out`. Optional; defaults to blank if not supplied. |
| 10 | `major_category` | string | Yes | Top-level category. Must come from a category where `is_subscription_eligible = true`. Optional. |
| 11 | `minor_category` | string | Yes | Sub-category under `major_category`. Optional. |
| 12 | `tags` | string | Yes | Semicolon-delimited in storage; displayed as comma-separated in the UI. Normalised by `normaliseTags()`. This field is named `tags` on subscriptions; the equivalent field on transactions is named `tx_tags`. |
| 13 | `description` | string | Yes | Free-text notes. Optional. UI label: "Notes". |
| 14 | `record_status` | enum | Yes | Lifecycle state. Valid values: `active`, `inactive`, `deleted`, `locked`. Default on creation: `active` (or `inactive` if `subscription_end_date` is already in the past). Updatable via `update_subscription` to `active` or `inactive` only (`invalid_record_status` is returned for any other value). |
| 15 | `created_at` | string | No | ISO 8601 UTC timestamp set at creation. **Structural note:** this field sits at column position 15, after `record_status` at position 14. Columns 14 and 15 were swapped from an earlier incorrect ordering in Round 5 (migration complete; migration function removed in Round 13). Do not reorder. |
| 16 | `sync_status` | string | No | Sync pipeline state. Valid values: `create-pending`, `update-pending`, `in-sync`, `create-failed`, `update-failed`. Set to `create-pending` on creation; advanced by `computeSyncStatus()` on each mutation. |
| 17 | `sync_date` | string | No | Timestamp of the last successful sync. Written by the sync pipeline. |
| 18 | `sync_notes` | string | No | Notes written by the sync pipeline (e.g. error detail). Cleared on each mutation. |
| 19 | `updated_at` | string | No | ISO 8601 UTC timestamp of the last write. Stamped on both create and update. |
| 20 | `subscription_start_date` | string | Yes | ISO date (YYYY-MM-DD) from which the subscription is active. Optional; informational only — does not affect `next_payment_date` computation or `record_status`. |
| 21 | `subscription_end_date` | string | Yes | ISO date (YYYY-MM-DD) after which the subscription expires. Optional. When present and in the past, triggers lazy auto-expiry (see below). |

## Frequency and schedule logic

### Which anchor field is used

| `frequency` | Required anchor | Blank field |
|---|---|---|
| `weekly` | `day_of_week` (1–7, Mon–Sun) | `day_of_month` |
| `monthly` | `day_of_month` (1–31) | `day_of_week` |
| `quarterly` | `day_of_month` (1–31) | `day_of_week` |
| `annual` | `day_of_month` (1–31) | `day_of_week` |

Validation enforces this at both create and update: supplying the wrong anchor for the selected frequency returns an error (`missing_day_of_week` or `missing_day_of_month`).

### `next_payment_date` computation

`computeNextPaymentDate(frequency, day_of_month, day_of_week)` runs in the server-side local time (not UTC) so the result matches what the user sees on a calendar. It is computed on every `list_subscriptions` call and attached to each row object before the response is returned. It is never persisted.

**Weekly:** finds the next calendar day (from today inclusive) that falls on the target `day_of_week`. If today is already that weekday, today is returned.

**Monthly / quarterly / annual:** walks forward in increments of 1, 3, or 12 months respectively. The current month is eligible if today's date is on or before the target day. When the target `day_of_month` exceeds the length of a candidate month (e.g. day 31 in April), the date is clamped to the last day of that month.

**Non-active subscriptions (`inactive` or `locked`)** receive `next_payment_date = ''` regardless of their schedule fields. Deleted rows are excluded from the response entirely.

## Lifecycle

`record_status` governs what operations are available and whether the subscription appears in the active list.

```
active  ──pause──►  inactive  ──restore──►  active
active  ──expiry──► inactive  (auto, via subscription_end_date)
active  ──delete──► deleted   ──restore──►  active
inactive ─delete──► deleted   ──restore──►  active
locked  ──(no mutations allowed)
```

| Transition | Mechanism | Notes |
|---|---|---|
| `active → inactive` | `update_subscription` with `record_status: inactive` | Manual pause. Subscription stays visible in the list. `next_payment_date` is returned as blank. |
| `inactive → active` | `update_subscription` with `record_status: active` | Manual resume. Resumes `next_payment_date` computation. |
| `active → inactive` (auto) | Lazy expiry during `list_subscriptions` | Triggered by `subscription_end_date` being in the past (see below). |
| `active → deleted` | `delete_subscription` | Soft-delete; row remains in the sheet. |
| `inactive → deleted` | `delete_subscription` | Same as above. |
| `deleted → active` | `restore_subscription` | Dedicated restore action. Verifies the record is in `deleted` state and that no other active subscription has the same name before restoring. Always restores to `active`. |
| `locked` | Set externally | Cannot be edited or deleted. `updateSubscription` and `deleteSubscription` return `record_locked`. |

`update_subscription` accepts `record_status` values of `active` or `inactive` only. Passing any other value returns `invalid_record_status`.

## Auto-expiry

When `list_subscriptions` runs, every row with `record_status = active` and a non-blank `subscription_end_date` is checked. If the end date (taken as the first 10 characters, `YYYY-MM-DD`) is strictly earlier than today's local date (matching the timezone used by `computeNextPaymentDate`), the backend lazily writes all four fields in-place on the sheet row:

- `record_status → inactive`
- `updated_at → current ISO timestamp`
- `sync_status` is advanced via `computeSyncStatus()`
- `sync_notes` is cleared to `''`

These writes happen in-place on the sheet row before the response is built. The response reflects the full post-expiry state: all four fields (`record_status`, `updated_at`, `sync_status`, `sync_notes`) are updated on the in-memory row object before it is included in the returned list. No explicit trigger or scheduled job is required — expiry is a side effect of the list call.

A subscription created with a `subscription_end_date` already in the past is written with `record_status = inactive` immediately at creation (the initial status check runs in `createSubscription` before the row is appended).

## Category linkage

The subscription form only shows categories where the category entity has `is_subscription_eligible = true`. This flag is defined on the categories sheet and read from `state` at form render time; the subscription schema itself does not validate category eligibility — that gate is enforced in the UI layer.

`major_category` and `minor_category` are stored as **key** values (lowercased, machine-readable, e.g. `utilities`) — not display labels. These match `major_category_key` and `minor_category_key` on the categories entity. They are entered by the user via a constrained form dropdown that is already filtered to eligible categories.

## Account linkage

`source_account` stores the account `id` (FK, string). It is not denormalised — the account name is resolved in the UI by looking up `state.accountMap[source_account]`. The backend validates only that the field is non-empty; it does not check that the ID references a live account row. If the referenced account is later deleted or deactivated, the subscription retains the stale ID and the UI falls back to displaying the raw ID when no matching account is found in the map.

## API surface

All subscription endpoints are routed through the single `/exec` GAS endpoint.

| Action | Method | Description |
|---|---|---|
| `list_subscriptions` | GET | Returns all non-deleted rows. Runs lazy expiry (lazy expiry is a write operation — if any subscriptions have passed their end date, the sheet is mutated during this GET-equivalent call). Appends computed `next_payment_date` to each row. |
| `get_subscription_schema` | GET | Returns the `frequencies` enum array. Used by the frontend to populate frequency dropdowns without hardcoding. |
| `create_subscription` | POST | Validates required fields; duplicate name check (`duplicate_subscription`); appends row; returns `{ ok: true, id }`. |
| `create_subscriptions_bulk` | POST | Accepts `{ subscriptions: [] }`; validates all rows in memory, then appends all valid rows in a single `setValues` call; returns `{ ok, created, skipped, failed, results }`. Duplicates go in `skipped`, not `failed`. Within-batch duplicate names are caught against both the pre-existing sheet rows and any rows already accepted earlier in the same batch. |
| `update_subscription` | POST | Validates editable fields; locked guard; applies changed fields in memory then writes the row in a single `setValues` call; advances `sync_status`; stamps `updated_at`. Toggling `record_status` (pause/resume) via `update_subscription` requires all other required fields (`name`, `frequency`, `source_account`, and the schedule anchor) to be included in the payload. Omitting them will return the corresponding `missing_*` error. |
| `delete_subscription` | POST | Locked guard; reads full row into memory, applies `record_status → deleted` and sync fields, then writes back in a single `setValues` call; advances `sync_status`; stamps `updated_at`. No FK guard (subscriptions are not referenced by other entities). |
| `restore_subscription` | POST | Verifies record is in `deleted` state; checks no other active subscription has the same name; reads the full row into memory, applies `record_status → active` and sync fields, then writes back in a single `setValues` call; stamps `updated_at`. Always restores to `active`. |

### Validation error codes

| Error | Trigger |
|---|---|
| `missing_name` | `name` absent, null, or empty string |
| `missing_subscription_amount_local` | `subscription_amount_local` absent or null on create |
| `invalid_subscription_amount_local` | `subscription_amount_local` is not a positive number. On create, must be present and positive. On update, if absent from the body it is not written; if present, it must be a positive number. |
| `missing_source_account` | `source_account` absent, null, or empty string |
| `missing_frequency` | `frequency` absent, null, or empty string on both create and update. |
| `invalid_frequency` | `frequency` is present and non-empty but not in `VALID_FREQUENCIES`. |
| `missing_day_of_month` | `frequency` is monthly/quarterly/annual and `day_of_month` is absent |
| `invalid_day_of_month` | `day_of_month` is not an integer between 1 and 31 |
| `missing_day_of_week` | `frequency` is weekly and `day_of_week` is absent |
| `invalid_day_of_week` | `day_of_week` is not an integer between 1 and 7 |
| `duplicate_subscription` | A non-deleted subscription with the same name already exists |
| `invalid_tx_type` | `tx_type` is present and non-empty but is not `money-in` or `money-out`. Checked on both create and update. |
| `invalid_record_status` | `record_status` value is not `active` or `inactive` |
| `field_not_editable` | Update payload includes a field where `editable: false`. Response shape: `{ ok: false, error: 'field_not_editable', field: '<key>' }` |
| `missing_row_num` | `row_num` absent on update or delete |
| `invalid_row` | `row_num` is outside the sheet's data range |
| `record_locked` | Target row has `record_status = locked` |
| `not_deleted` | Record is not in `deleted` state — returned by `restore_subscription` |
| `duplicate_name` | Another active subscription has the same name. Returned by `restore_subscription`. |

## CSV bulk import

The frontend parses a CSV file client-side before submitting to `create_subscriptions_bulk`. Column headers are matched case-insensitively and normalised (spaces replaced with underscores).

### Required columns

| Column | Rule |
|---|---|
| `subscription_name` | Non-empty string |
| `subscription_amount_local` | Positive number |
| `frequency` | Must be a valid frequency value |

### Optional columns

`counterparty_name`, `day_of_month`, `day_of_week`, `source_account`, `tx_type`, `major_category`, `minor_category`, `tags`, `description`, `subscription_start_date`, `subscription_end_date`.

### Rules

- `id` is never read from the CSV — it is always auto-generated by `generateSubscriptionId()`.
- Currency is not a CSV column. It is derived at display time from `state.accountMap[source_account].local_currency`.
- Rows that fail client-side validation (missing name, missing subscription_amount_local, missing frequency, non-positive amount) are logged as parse errors and excluded from the payload; they are not sent to the backend.
- Rows that pass client-side parsing but fail backend validation are returned in `results` with `ok: false`.
- Duplicate names (matched against existing non-deleted subscriptions) are returned in `skipped`, not `failed`. The `ok` field on the bulk response is `true` as long as there are no non-duplicate failures.
- The response shape is `{ ok, created, skipped, failed, results }`.

## Known structural notes

**`record_status` at column position 14, `created_at` at column 15.** The original subscription schema had these two columns reversed (`created_at` at 14, `record_status` at 15). In Round 5 the schema was corrected and `migrateSubscriptionColumnOrder()` was run from the GAS Script Editor to swap the values in the pre-existing sheet. The migration is complete and the function has been removed from `subscription-core.gs` (dead code as of Round 13). Column positions are append-only — do not reorder further.

**`tags` vs `tx_tags`.** The subscription entity uses the field name `tags` for its tag list (semicolon-delimited in storage; displayed as comma-separated in the UI). The transaction entity uses `tx_tags` for the same concept. These are parallel constructs with different names; they share the `normaliseTags()` utility function but are stored on separate sheets and never merged.
