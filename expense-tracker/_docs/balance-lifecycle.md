# Balance Lifecycle

How `account.current_value_local` is derived and how it changes when a transaction is created, edited, or deleted.

## Computation model

Account balances are **computed at read time**, not maintained incrementally. The sheet stores only `opening_value_local` for each account. When `listAccounts` is called, `_buildAccountNetMap` scans the `transaction_master` sheet and returns a `{ accountId → net }` map; the response value `current_value_local` is then assembled as:

```
current_value_local = opening_value_local + net
```

`current_value_local` is never written back to the sheet after initial account creation. No transaction create/update/delete touches the `account_master` sheet.

There is no `adjustAccountBalance` function — it was removed in Round 5. The `workflow-engine.gs` file that previously hosted it is now an empty comment stub.

## Sign convention

| Type | Stored `opening_value_local` | UI display of `current_value_local` |
|---|---|---|
| `asset`, `investment` | Signed value | As-is |
| `liability` | **Negative** (double-entry convention) | `abs(current_value_local)` labelled "owed" |

The user always inputs and sees positive numbers for liabilities. The store negates on write; `current_value_local` naturally stays negative as liabilities are debited (money-out).

## How net is computed

`_buildAccountNetMap` iterates all non-deleted transaction rows and accumulates:

```
for each non-deleted row with valid date, positive finite amount and known account:
    if tracking_start_date_local is set and tx_date_local is earlier: skip
    if tx_type === 'money-in':  net[account_id] += tx_amount_local
    if tx_type === 'money-out': net[account_id] -= tx_amount_local
```

The opening value is the snapshot at `tracking_start_date_local`, when set. The cutoff is inclusive: a movement exactly at the tracking timestamp counts. A blank cutoff retains all-history behavior. `account_opening_date_local` records the real-world opening date and is not the balance cutoff. Historical insight replay activates the opening snapshot at the tracking timestamp; it converts openings and movements using the same display currency.

When the account supplies `local_timezone`, the cutoff is resolved in that zone and each movement is resolved in `tx_timezone_local` (blank transaction zone retains the legacy `Europe/London` default). The comparison uses actual UTC instants, including fractional seconds. For an account without a timezone, both values retain the documented wall-clock comparison. An invalid or ambiguous account snapshot fails the balance read rather than replaying all history. Native Sheet date cells are interpreted from their displayed wall time.

Each transaction row touches exactly **one** account via `account_id`. A transfer between two accounts is two rows, each accumulating into its own account's net independently.

## Effect of transaction operations on computed balance

Because `current_value_local` is derived, any change to the `transaction_master` sheet is automatically reflected the next time `listAccounts` is called. The logical effects are:

### Create

**money-in:**
`net[account_id] += tx_amount_local` → `current_value_local` rises by `tx_amount_local`.

**money-out:**
`net[account_id] -= tx_amount_local` → `current_value_local` falls by `tx_amount_local`.

**Transfer (child points to parent ID):**
Row A (money-out on source): `net[source_id] -= Row A.tx_amount_local`
Row B (money-in on target): `net[target_id] += Row B.tx_amount_local`

If source and target accounts differ in currency, `Row B.tx_amount_local ≠ Row A.tx_amount_local`. The implicit exchange rate is `Row B.tx_amount_local / Row A.tx_amount_local`.

### Update — logical two-phase reversal

An edit is logically equivalent to removing the old row's contribution and adding the new row's contribution. Because the net map is computed fresh from the sheet on every read, this happens automatically — editing the row's `tx_amount_local` or `tx_type` or `account_id` changes the data that `_buildAccountNetMap` will aggregate on the next call.

For financial rule validation at edit time, the server (`validateTransactionBalanceUpdate`) computes the **post-reversal balance** before checking insufficient-balance rules:

```
post_reversal_balance = current_value_local

if old.account_id == new.account_id and old row contributed to the tracked balance:
    if old.tx_type == 'money-in':  post_reversal_balance -= old.tx_amount_local
    if old.tx_type == 'money-out': post_reversal_balance += old.tx_amount_local
```

Pass `post_reversal_balance` to the insufficient asset/investment balance check in [financial-rules.md](financial-rules.md). This adjustment is needed because `current_value_local` already includes the old row's contribution, so checking the raw balance against the new amount would incorrectly double-count it.

For transfers, apply the same reversal logic independently to both legs before checking either.

### Delete (soft)

Setting `record_status = deleted` causes `_buildAccountNetMap` to skip the row (the map excludes deleted rows). The row's contribution is removed from all future `current_value_local` computations without any write to the `account_master` sheet.

## Idempotency

The computed model is naturally idempotent for reads — `listAccounts` always derives the correct balance from the current state of the `transaction_master` sheet. Mutations to transactions must still avoid double-submission; writing the same transaction row twice would cause its amount to be counted twice in `net`.

## Concurrency

The UI sends the expected record UUID and source `updated_at` alongside each row-number mutation. A moved/replaced row or a newer edit to the same UUID returns `stale_record` before modification; reload the data and retry. Sync acknowledgements do not change this source revision. Legacy API callers that omit `expected_id` / `expected_updated_at` retain their previous behavior.

Single-user model. POST mutations are serialized with a script lock; contention returns `busy_retry`. Reads and external spreadsheet edits can still overlap. Google Sheets does not provide a transaction spanning multiple requests or sheets.

## Worked example — cross-currency transfer (GBP to INR)

State before:
- `lloyds_current.opening_value_local = 1000` (GBP); no transactions yet → `current_value_local = 1000`
- `icici_savings.opening_value_local = 50000` (INR); no transactions yet → `current_value_local = 50000`

Create transfer: Row A = money-out on `lloyds_current`, `tx_amount_local = 500`. Row B = money-in on `icici_savings`, `tx_amount_local = 52500`.

After next `listAccounts`:
```
_buildAccountNetMap returns:
  lloyds_current → −500
  icici_savings  → +52500

current_value_local:
  lloyds_current = 1000 + (−500) = 500
  icici_savings  = 50000 + 52500 = 102500
```

Effective exchange rate: `52500 / 500 = 105 INR per GBP`. Recoverable at any time from the two stored `tx_amount_local` values.

## Worked example — edit of a money-out row

Before edit, `transaction_master` sheet has: `tx_type = 'money-out'`, `account_id = gbp_current`, `tx_amount_local = 150`.

`listAccounts` returns: `gbp_current.current_value_local = opening − 150`.

User edits `tx_amount_local` to 200. After the sheet write, next `listAccounts` returns: `gbp_current.current_value_local = opening − 200`. The old 150 contribution is no longer in the sheet; the new 200 is.

For validation at edit time, the server uses the post-reversal formula above to confirm the account's net position after the old row is "removed" before checking whether the new amount fits.
