# Financial validation

The GAS API validates required fields, positive finite transaction amounts, categories and referenced accounts before saving. Interactive entry uses active accounts; historical bulk imports may reference inactive or locked accounts, but not deleted accounts.

## Current enforcement

| Rule | Frontend | GAS backend |
|---|---|---|
| Positive finite transaction amounts | Checked before submission | Enforced |
| Existing category and required source/target accounts | Category-driven form | Enforced on create/import; category validation also applies to updates |
| Account subtype hints | Dropdown filtering | Not enforced |
| Insufficient asset/investment balance | Blocks interactive money-out against the computed balance | Not enforced; bulk historical import does not run this UI check |
| Credit-card limit | Not enforced | Not enforced; detail tabs are not joined into account responses |
| Cross-currency transfer amount | Requires the amount for each currency | Explicit target amount required for different currencies; a missing target may default to source only when currencies match |

These UI checks do not provide server-side financial policy enforcement. They also use the current computed balance, not a reconstruction of available funds at each historical transaction timestamp.

## Tracking and edits

`opening_value_local` is the snapshot at `tracking_start_date_local` when supplied. Earlier transactions are retained for history but excluded from current balances. The interactive insufficient-balance check is skipped for a new movement before the tracking cutoff.

When editing a movement included in the current balance, the UI first reverses its old contribution on the same account, then checks the new amount. Deleted and pre-tracking movements are not reversed. This avoids rejecting a valid edit by counting both its old and new amount.

## Transfers

Transfers persist two rows. The parent has a blank `parent_tx_id`; the child points to the parent's ID. Either direction may be the parent, depending on the initiating transaction type. Each leg stores its own positive amount; the ratio of money-in to money-out amounts is the effective exchange rate. No separate `fx_rate` is stored.

Interactive transfer creation validates both legs and checks duplicates before writing both rows in one `setValues` call. Bulk re-import preserves leg IDs; obsolete child legs remain as deleted rows so downstream extraction can synchronize the deletion.

## Currency conversion

Display conversion uses current rates, not historical rates. Missing or invalid rates produce an unavailable result, never a fabricated 1:1 conversion. See [rates.md](rates.md).
