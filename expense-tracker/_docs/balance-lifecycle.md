# Balance Lifecycle

How `account.current_value` changes when a transaction is created, edited, or deleted. This is the only mechanism by which balances move — the account API never writes `current_value` directly.

## Sign convention

| Type | Stored | UI display |
|---|---|---|
| `asset`, `investment` | Positive | As-is |
| `liability` | **Negative** (double-entry convention) | `abs(current_value)` labelled "owed" |

The user always inputs and sees positive numbers for liabilities. The store negates on write; the UI applies `abs()` on read. The user never encounters a negative number.

## Adjustment primitive

Define a single operation:

```
adjust(account_id, delta) → account.current_value += delta
```

All lifecycle logic is expressed as a sequence of `adjust(...)` calls. Delta is signed: positive = credit (balance up), negative = debit (balance down).

## Create

| Transaction type | Adjustment(s) |
|---|---|
| `money-in` | `adjust(target_account, +amount)` |
| `money-out` (no target) | `adjust(source_account, −amount)` |
| `money-out` (with target — repayment) | `adjust(source_account, −amount)`, then `adjust(target_account, +credited)` |
| `money-transfer` | `adjust(source_account, −amount)`, then `adjust(target_account, +credited)` |

Where `credited = amount × fx_rate` when the source and target currencies differ and `fx_rate > 0`; otherwise `credited = amount`.

Example — `money-out` paying off a credit card (liability/credit_card) from a current account (asset/current):
- `adjust(current_account, −150)` — funds leave current
- `adjust(credit_card, +150)` — owed amount reduces (the stored value moves from `−400` to `−250`)

## Update — two-phase reversal

An update is **not** a delta-from-old-to-new. The store reapplies the old transaction *in reverse*, then applies the new one fresh.

### Phase 1 — reverse the OLD row

Use the row's stored values to apply the opposite of what create did:

| Stored type | Reversal |
|---|---|
| `money-in` | `adjust(target_account, −amount)` |
| `money-out` (no target) | `adjust(source_account, +amount)` |
| `money-out` (with target) | `adjust(source_account, +amount)`, `adjust(target_account, −credited)` |
| `money-transfer` | `adjust(source_account, +amount)`, `adjust(target_account, −credited)` |

`credited` uses the **old** `fx_rate`.

### Phase 2 — apply the NEW row

Identical to [Create](#create), using the new values.

### Why two phases instead of a single delta

The old and new rows may differ in `transaction_type`, `source_account`, `target_account`, `amount`, `fx_rate`, or any combination. Computing a delta would require a quadratic case table; reverse + reapply is `O(2)` regardless of what changed.

### Frontend implication

Pre-save hard-block validation must compute the **post-reversal** balance of the source account (and target, for cross-currency credit-card transfers) before checking insufficient-balance or credit-limit rules. Otherwise an edit that only increases the amount slightly would be rejected when it should succeed. See [financial-rules.md](financial-rules.md) for the formula.

## Delete

Identical to [Phase 1 — reverse the OLD row](#phase-1--reverse-the-old-row), then delete the row.

## Idempotency

The store is not idempotent. Calling create twice produces two rows and two sets of balance adjustments. Clients must avoid double-submitting.

## Concurrency

Single-user model. No locking is required — every request is sequential. If you implement this on a concurrent backend, wrap each transaction's lifecycle (write + adjustments) in a database transaction so partial application is impossible.

## Worked example — currency conversion on transfer

State before:
- `gbp_current.current_balance = 1000` (currency = GBP)
- `inr_savings.current_balance = 50000` (currency = INR)
- Rate: 1 GBP = 105 INR

Create `money-transfer`: source = `gbp_current`, target = `inr_savings`, amount = 100 GBP, `fx_rate` = 105.

Adjustments:
- `adjust(gbp_current, −100)` → 900
- `adjust(inr_savings, +100 × 105 = +10500)` → 60500

State after:
- `gbp_current.current_balance = 900`
- `inr_savings.current_balance = 60500`

The `fx_rate` is stored on the row so the same arithmetic can be reversed exactly on edit or delete — even if the global rates table has changed in the meantime.

## Worked example — credit-card payment with two-phase edit

State:
- `gbp_current.current_balance = 1000`
- `gbp_cc.current_balance = −400` (£400 owed)

Create `money-out` for £150, source = `gbp_current`, target = `gbp_cc`:
- `adjust(gbp_current, −150)` → 850
- `adjust(gbp_cc, +150)` → −250

User now edits the amount to £200:

Phase 1 (reverse):
- `adjust(gbp_current, +150)` → 1000
- `adjust(gbp_cc, −150)` → −400

Phase 2 (apply new):
- `adjust(gbp_current, −200)` → 800
- `adjust(gbp_cc, +200)` → −200

Final: current = 800, cc = −200 (£200 owed). Correct.
