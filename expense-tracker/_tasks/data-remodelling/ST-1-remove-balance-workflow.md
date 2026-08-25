# ST-1 — Remove auto balance calculation from GAS

**Type:** Code + deploy
**Depends on:** ST-0
**Must complete before:** ST-5 (sheet migration)
**Files:** `api/transaction-core.gs`, `api/transaction-validation.gs`

---

## Why this comes first

`updateTransaction` and `deleteTransaction` currently read `fx_rate` from the existing sheet row to compute `to_amount` for the workflow balance reversal. That column will be deleted in ST-5. This sub-task removes the entire balance auto-calculation system first, while the sheet is still in its original structure, so that by the time `fx_rate` is deleted from the sheet there is no code that depends on it.

The auto-balance system (`executeWorkflow` / `reverseWorkflow`) was also silently crediting/debiting the target account without creating any transaction record for the other side. That behaviour is being removed permanently here.

---

## Changes — `api/transaction-core.gs`

### `createTransaction`

Remove the following (in order of appearance):

1. `const fxRate = body.fx_rate !== undefined && body.fx_rate !== '' ? Number(body.fx_rate) : 0;`
2. The money-transfer `validateFxRate` block (if/return)
3. The money-out `validateFxRate` block (if/return)
4. The `_findCategoryHints` / `resolveWorkflow` / `if (typeof wfType !== 'string')` block
5. `const finalDescription = applyFxNote(...)` → replace with `const finalDescription = body.description || '';`
6. The entire `executeWorkflow` call and its `if (!wfResult.ok) return wfResult;` guard
7. Remove `to_amount` and `fx_rate` from the workflow params object (it's deleted with the call)

`return { ok: true, id }` stays.

### `updateTransaction`

Remove:

1. `const newType = body.tx_type;`
2. `const newFxRate = body.fx_rate ? Number(body.fx_rate) : 0;`
3. The money-transfer `validateFxRate` block and the money-out `validateFxRate` block
4. All six old-row variables: `oldType`, `oldMajor`, `oldMinor`, `oldAmount`, `oldSourceAccountId`, `oldFxRate`
   - `oldTargetAccountId` — also remove
5. `const oldHints = ...` / `const oldWfType = ...` / the `if (typeof oldWfType !== 'string')` check
6. `const newHints = ...` / `const newWfType = ...` / the `if (typeof newWfType !== 'string')` check
7. Phase 1 `reverseWorkflow(...)` call and its comment
8. Phase 2 `executeWorkflow(...)` call
9. `const finalDescription = applyFxNote(...)` → replace with `const finalDescription = body.description || '';`
   Also remove the 3-line comment block directly above `applyFxNote` (it references FX rate conversion behaviour that no longer applies).

Keep `const newAmount = Number(body.amount);` — still used by `writeField('amount', newAmount)`.

`return { ok: true }` stays.

### `deleteTransaction`

Remove:

1. `const fxRate = Number(row[txColIndex('fx_rate')]) || 0;`
2. `const hints = _findCategoryHints(...)` / `const wfType = resolveWorkflow(...)` / the `if (typeof wfType !== 'string')` check
3. The entire `reverseWorkflow(...)` call

Keep `sheet.deleteRow(rowNum)` and `return { ok: true }`.

---

## Changes — `api/transaction-validation.gs`

### Remove `validateFxRate` function entirely (lines 144–160)

This function is no longer called from anywhere after the core.gs changes above.

### Simplify `_validateFinancialRules`

Remove from the function body:
- `const sourceRaw = accountMap[String(body.source_account)];`
- `const sourceForCheck = oldRow ? _postReversalBalance(...) : sourceRaw;`
- `const balanceErr = _checkBalanceRules(...); if (balanceErr) return balanceErr;`
- `const rule5Err = _checkRule5(...); if (rule5Err) return rule5Err;`
- The `if (!body.source_account) return { ok: true }` early return (after T-03 checks, nothing follows, so this becomes the natural end)

Keep:
- `const accountMap = _loadAccountMap();`
- The T-03 preflight: `if (body.source_account && !accountMap[...]) return error` and the same for `target_account`
- `return { ok: true }` at the end

### Remove three now-unused helper functions

- `_postReversalBalance` (lines 227–246)
- `_checkBalanceRules` (lines 249–269)
- `_checkRule5` (lines 272–284)

`_loadAccountMap`, `_validateCategoryAccountTypeHints`, `_findCategoryHints`, `_checkAccountTypeHint` all stay — they are still used.

---

## Deploy

```bash
make api-deploy   # pick dev; enter description e.g. "remove auto balance workflow"
```

Test dev before touching prod:
- Create a transaction → verify it saves correctly, no balance sheet update
- Edit a transaction → verify it updates correctly
- Delete a transaction → verify it deletes correctly
- Cross-currency money-transfer → verify it no longer blocks on missing fx_rate

Then deploy to prod.

---

## Done when

- `make api-deploy` succeeds for both dev and prod
- Create / edit / delete all work in the dev app without errors
- No `executeWorkflow`, `reverseWorkflow`, `applyFxNote`, or `validateFxRate` references remain in `transaction-core.gs` or `transaction-validation.gs`
