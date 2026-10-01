# Financial validation

The GAS API validates required fields, positive finite transaction amounts, categories, referenced accounts and the insufficient-balance rule before saving. The browser does not validate: forms send what the user entered and show the server's error. Interactive entry uses active accounts. Historical bulk imports may reference inactive or locked accounts, but not deleted accounts.

## Current enforcement

| Rule | Frontend | GAS backend |
|---|---|---|
| Positive finite transaction amounts | None; shows the server error | Enforced |
| Existing category and required source/target accounts | Category-driven form | Enforced on create/import; category validation also applies to updates |
| Account subtype hints | Account choices come from `get_transaction_form_options` (the server applies the hints) | Not enforced on write |
| Insufficient asset/investment balance | None; shows the server error | Enforced on interactive `create_transaction` / `update_transaction` (`insufficient_balance`). Not run by CSV import (`create_transactions_bulk`) |
| Credit-card limit | Not enforced | Not enforced; detail tabs are not joined into account responses |
| Cross-currency transfer amount | Sends the target amount as entered (blank when empty) | Explicit target amount required for different currencies (`missing_target_amount`); a missing target may default to source only when currencies match |

### Error responses

Interactive create/update failures keep their error code. They also carry the input `field` and a human `message` the form shows as-is. For example:

```
{ ok: false, error: 'insufficient_balance', field: 'source_amount_local',
  message: 'Insufficient balance. Bank has £12.30 — this transaction needs £50.00. Record an Adjustments / Balance correction first if the actual balance is higher.',
  details: { account_id, currency: 'GBP', available: '12.30', required: '50.00' } }
```

Messages come from `_VM_MESSAGES` (`api/view-context.gs`). Bulk import results keep bare codes.

## Insufficient balance

The rule (`validateTransactionBalanceCreate` / `validateTransactionBalanceUpdate` in `api/transaction-validation.gs`) applies only to asset and investment accounts. It checks the leg that takes money out of the account:
- a transfer's source account, whichever direction was submitted, for `source_amount_local`;
- a money-out on the account the single-leg writer books (the source account when the category requires one, otherwise the target account).

Money-in and liability accounts are never checked.

The movement is rejected when the account's **current** balance is below the amount; spending exactly the balance is allowed. The current balance is `opening_value_local` plus every eligible movement, including future-dated ones, as `listAccounts` computes it. It is not a reconstruction of available funds at the transaction's own timestamp. A tolerance of 0.000001 absorbs floating-point drift in summed balances.

CSV import never runs this rule, because historical files may replay periods when an account was overdrawn. After such an import, the account's balance is genuinely negative. Money-out edits on that account are then refused until an Adjustments / Balance correction brings the balance back. Money-in edits stay allowed.

## Tracking and edits

`opening_value_local` is the snapshot at `tracking_start_date_local` when supplied. Earlier transactions are retained for history but excluded from current balances.

The insufficient-balance rule skips a movement dated before the account's tracking cutoff. It uses the same comparison as the balance replay:
- zoned accounts compare the transaction's instant (its own zone, blank = Europe/London) with the cutoff instant;
- legacy unzoned accounts compare wall times.

When an edit keeps a movement on the same account, the server first reverses the movement's old contribution, then checks the new amount against that post-reversal balance. Deleted and pre-tracking movements are not reversed. This avoids rejecting a valid edit by counting both its old and new amount. An edit that keeps the row's own values therefore passes unless the account is overdrawn.

## Transfers

Transfers persist two rows. The parent has a blank `parent_tx_id`; the child points to the parent's ID. Either direction may be the parent, depending on the initiating transaction type. Each leg stores its own positive amount; the ratio of money-in to money-out amounts is the effective exchange rate. No separate `fx_rate` is stored.

Interactive transfer creation validates both legs and checks duplicates before writing both rows in one `setValues` call. Bulk re-import preserves leg IDs; obsolete child legs remain as deleted rows so downstream extraction can synchronize the deletion.

## Currency conversion

Conversion runs on the server (`api/fx-utils.gs`) with current rates, not historical rates. Missing or invalid rates produce an unavailable result, never a fabricated 1:1 conversion. See [rates.md](rates.md) and, for net worth, flow exclusions and periods, [calculations](calculations.md).
