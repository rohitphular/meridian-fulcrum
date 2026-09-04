# Financial Rules

Hard-block rules enforced before a transaction is saved (create or update). Each rule returns either `pass` or a blocking error message. The frontend runs them pre-save; the backend re-enforces them on submission as a safety net.

The rules apply to the **post-reversal balance** during an update (see [balance-lifecycle.md](balance-lifecycle.md)).

## Rule 1 — Insufficient balance on asset and investment accounts

**Triggers when:** `tx_type = 'money-out'` AND the account linked via `account_id` has `type ∈ {asset, investment}`.

**Blocks if:** `account.current_value_local < tx_amount` at the time of the transaction.

**Rationale:** Asset and investment accounts cannot go negative through the app. Genuine overdrafts should be modelled as `overdraft` accounts.

**Recovery:** Record an `Adjustments / Balance correction` transaction to bring the recorded balance in line with reality, then retry.

## Rule 2 — Credit limit exceeded on credit card

**Triggers when:** `tx_type = 'money-out'` AND `account.type = liability` AND `account.sub_type = credit_card`.

**Note:** `credit_card_limit` is no longer a stored field. This rule requires revisiting once a limit field is reintroduced. For now, the rule is defined but **not enforced**.

**Recovery:** Reduce the amount.

## Rule 3 — Insufficient balance applies to the money-out leg of transfers

In the single-leg model there is no `money-transfer` type. The money-out leg of a transfer is a regular `money-out` row with `tx_type = 'money-out'` and `account_id` pointing to the source account. Rule 1 therefore applies to it automatically — no special transfer handling is needed.

## Rule 4 — Credit limit applies to credit-card transfers too

Similarly, if the source account of a transfer is a `liability/credit_card`, the money-out leg of that transfer is subject to Rule 2 (checking the credit limit). This rule is currently **unenforced** pending reintroduction of a credit limit field.

## Rule 5 — No money-out from a loan account

**Triggers when:** `tx_type = 'money-out'` AND the linked account has `type = liability` AND `sub_type ∈ {mortgage, auto_loan, heloc, personal_loan, student_loan, medical_loan, debt_consolidation}`.

**Blocks unless:** `major_category = 'debt-finance'` AND `minor_category = 'interest-charges'` — this exception covers interest accruals and fees recorded against the loan itself.

**Rationale:** Loan accounts represent money owed, not money held. You cannot spend *from* a loan. Repayments to a loan are modelled as a two-row transfer: a `money-out` row on the current account (source) linked via `parent_tx_id` to a `money-in` row on the loan (target), which reduces the balance owed.

## Rule 6 — Both legs required for a cross-currency transfer

**Triggers when:** a row has a non-empty `parent_tx_id` AND the source and target accounts have different currencies.

**Blocks if:** the partner row (identified by `parent_tx_id`) is missing or its `tx_amount` is absent or ≤ 0.

**Rationale:** For a cross-currency transfer, the money-in row's `tx_amount` implicitly provides the exchange rate via the ratio `tx_in.tx_amount / tx_out.tx_amount`. If the money-in row is missing or has no `tx_amount`, the balance arithmetic on the target account is incomplete and the effective rate is undefined. Both rows must be present and valid before either is committed.

No `fx_rate` column is stored on the row and no explicit rate input is required from the user — the rate is fully encoded in the two `tx_amount` values.

## Post-reversal balance formula (for edit)

When validating an **edit** rather than a create, evaluate the rules against the account's balance *after* the old row has been reversed:

```
post_reversal_balance = account.current_value_local

if old.account_id == new.account_id:
    if old.tx_type == 'money-in':  post_reversal_balance -= old.tx_amount
    if old.tx_type == 'money-out': post_reversal_balance += old.tx_amount
```

Pass `post_reversal_balance` to Rules 1–2 instead of the raw `current_value_local`. Without this adjustment, edits that merely *change* a transaction (e.g. fix a typo'd amount of £100 to £105) would be rejected when the resulting balance is still fine.

For transfers, apply the same reversal logic independently to both legs before checking either leg against the rules.

## Soft warnings (non-blocking)

These are signalled in the UI but do not prevent saving:

| Signal | When | Where |
|---|---|---|
| `?` badge on amount | The linked account's currency is not present in the `rates` table | Transactions list |
| `†` marker next to amount | Row is one leg of a transfer and the implied rate (money-in ÷ money-out) differs from the current global rate for that currency pair | Transactions list |
| `⚠ N rows have warnings` banner | Stored row has missing `id`, missing `tx_date_local`, or invalid `tx_type` | Above transactions table |

Malformed rows are excluded from insight totals and account balance arithmetic — they exist purely as a diagnostic to surface bad data in the underlying store.
