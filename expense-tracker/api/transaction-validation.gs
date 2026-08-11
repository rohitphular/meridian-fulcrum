// =============================================================================
// FULCRUM FORGE — Transaction Validation: input guards for create and update
// Shared across all transaction .gs files via GAS global scope.
// =============================================================================

function validateTransactionCreate(body) {
  if (!body.tx_date_time)
    return { ok: false, error: 'missing_date' };
  if (!body.tx_type || !VALID_TRANSACTION_TYPES.includes(body.tx_type))
    return { ok: false, error: 'invalid_transaction_type' };
  if (!body.amount || Number(body.amount) <= 0)
    return { ok: false, error: 'invalid_amount' };
  // money-in: source is external — source_account is not sent by the UI
  if (body.tx_type !== 'money-in' && !body.source_account)
    return { ok: false, error: 'missing_source_account' };

  const acctTypeErr = _validateCategoryAccountTypeHints(body);
  if (acctTypeErr) return acctTypeErr;

  // Financial hard-block rules (Rules 1–5; Rule 6 is validateFxRate, called by the caller).
  const finErr = _validateFinancialRules(body, null);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

// `oldRow` is the existing sheet row (array, indexed by txColIndex). Pass it so
// financial-rule checks operate on the post-reversal balance projection. T-02
// will move all validation to BEFORE Phase 1 reversal — this signature anticipates that.
function validateTransactionUpdate(body, oldRow) {
  if (!body.row_num)
    return { ok: false, error: 'missing_row_num' };
  if (!body.tx_date_time)
    return { ok: false, error: 'missing_date' };
  if (!body.tx_type || !VALID_TRANSACTION_TYPES.includes(body.tx_type))
    return { ok: false, error: 'invalid_transaction_type' };
  if (!body.amount || Number(body.amount) <= 0)
    return { ok: false, error: 'invalid_amount' };
  if (body.tx_type !== 'money-in' && !body.source_account)
    return { ok: false, error: 'missing_source_account' };

  // Reject immutable fields
  const fields = getFieldsForTransactionType(body.tx_type);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field.editable && field.key !== 'row_num' && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable:' + field.key };
    }
  }

  const acctTypeErr = _validateCategoryAccountTypeHints(body);
  if (acctTypeErr) return acctTypeErr;

  // Financial hard-block rules with post-reversal balance when oldRow is supplied.
  const finErr = _validateFinancialRules(body, oldRow || null);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

// ── Account-type hint validation ──────────────────────────────────────────────

function _validateCategoryAccountTypeHints(body) {
  const cat = _findCategoryHints(body.tx_type, body.major_category, body.minor_category);
  if (!cat) return null;

  if (cat.source_account_mandatory) {
    if (!body.source_account)
      return { ok: false, error: 'missing_source_account' };
    if (cat.source_account_types) {
      const err = _checkAccountTypeHint(body.source_account, cat.source_account_types, 'source');
      if (err) return err;
    }
  }

  if (cat.target_account_mandatory) {
    if (!body.target_account)
      return { ok: false, error: 'missing_target_account' };
    if (cat.target_account_types) {
      const err = _checkAccountTypeHint(body.target_account, cat.target_account_types, 'target');
      if (err) return err;
    }
  }

  return null;
}

function _findCategoryHints(type, major, minor) {
  if (!type || !major || !minor) return null;
  const sheet  = getOrCreateSheet(CATEGORIES_SHEET, getCategorySheetColumns());
  const values = sheet.getDataRange().getValues();
  const ci = {
    type:         catColIndex('tx_type'),
    major:        catColIndex('major_category'),
    minor:        catColIndex('minor_category'),
    src:          catColIndex('source_account_types'),
    dst:          catColIndex('target_account_types'),
    srcMandatory: catColIndex('source_account_mandatory'),
    dstMandatory: catColIndex('target_account_mandatory'),
    workflowType: catColIndex('workflow_type'),
  };
  for (let i = 1; i < values.length; i++) {
    if (values[i][ci.type] === type && values[i][ci.major] === major && values[i][ci.minor] === minor) {
      const toBool = function(v) { return v === true || String(v).toLowerCase() === 'true'; };
      return {
        source_account_types:      String(values[i][ci.src]          || '').trim(),
        target_account_types:      String(values[i][ci.dst]          || '').trim(),
        source_account_mandatory:  toBool(values[i][ci.srcMandatory]),
        target_account_mandatory:  toBool(values[i][ci.dstMandatory]),
        workflow_type:             String(values[i][ci.workflowType]  || '').trim(),
      };
    }
  }
  return null;
}

function _checkAccountTypeHint(accountId, allowedTypesStr, label) {
  if (!accountId || !allowedTypesStr) return null;
  const allowed = splitToList(allowedTypesStr).map(function(s) { return s.toLowerCase(); });
  if (!allowed.length) return null;

  const sheet     = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const values    = sheet.getDataRange().getValues();
  const ciId      = acctColIndex('id');
  const ciType    = acctColIndex('type');
  const ciSubType = acctColIndex('sub_type');

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][ciId]) !== String(accountId)) continue;
    const actualType    = String(values[i][ciType]    || '').trim().toLowerCase();
    const actualSubType = String(values[i][ciSubType] || '').trim().toLowerCase();
    if (!allowed.includes(actualType) && !allowed.includes(actualSubType)) {
      return {
        ok: false,
        error: label + '_account_type_mismatch',
        detail: 'Expected one of [' + allowed.join(', ') + '] but got type=' + (actualType || 'unknown') + ' sub_type=' + (actualSubType || 'unknown'),
      };
    }
    return null;
  }
  return null;
}

function validateFxRate(sourceAccount, targetAccount, fxRate) {
  if (!targetAccount) return { ok: true };
  const accSheet          = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const accValues         = accSheet.getDataRange().getValues();
  const accountIdColIdx   = acctColIndex('id');
  const currencyColIdx    = acctColIndex('currency');
  const accountCurrencyMap = {};
  for (let i = 1; i < accValues.length; i++) {
    accountCurrencyMap[String(accValues[i][accountIdColIdx])] = String(accValues[i][currencyColIdx]);
  }
  const fromCcy = accountCurrencyMap[sourceAccount];
  const toCcy   = accountCurrencyMap[targetAccount];
  if (fromCcy && toCcy && fromCcy !== toCcy && fxRate <= 0) {
    return { ok: false, error: 'fx_rate_required' };
  }
  return { ok: true };
}

// ── Financial hard-block rules — server-side safety net ─────────────────────
// Mirrors the frontend rule logic in app/sections/transactions.js so a direct
// POST or a request from a stale UI cannot bypass the rules. Specifications:
// docs/financial-rules.md.
//
//   Rules 1 & 3 — source-side asset/investment balance cannot go negative
//   Rules 2 & 4 — intentionally unenforced: credit_card_limit field not yet added (see financial-rules.md)
//   Rule 5     — money-out from a loan account is blocked (except Interest & charges)
//   Rule 6     — FX rate required for cross-currency transfer (validateFxRate above)
//
// NOT enforced here (frontend-only, per docs/financial-rules.md): Rule 4 for the
// TARGET account when a money-transfer credits a credit card. Adding this is a
// follow-up — the frontend already enforces it on update.

function _validateFinancialRules(body, oldRow) {
  const accountMap = _loadAccountMap();

  // T-03 preflight: NEW account refs must exist. Refusing here forces the user
  // to fix the data before any sheet mutation happens, and means
  // adjustAccountBalance can't silently no-op on a typo or stale reference.
  // OLD account refs (read from the stored row during update/delete) are
  // intentionally NOT preflight-checked here — see adjustAccountBalance.
  if (body.source_account && !accountMap[String(body.source_account)]) {
    return { ok: false, error: 'unknown_source_account:' + body.source_account };
  }
  if (body.target_account && !accountMap[String(body.target_account)]) {
    return { ok: false, error: 'unknown_target_account:' + body.target_account };
  }

  // money-in has no source account — source-side rules don't apply.
  if (!body.source_account) return { ok: true };

  const sourceRaw = accountMap[String(body.source_account)];

  // For update: project source balance through the old-row reversal so the rule
  // checks operate on the balance the NEW row will face after Phase 1.
  const sourceForCheck = oldRow
    ? _postReversalBalance(body.source_account, sourceRaw, oldRow)
    : sourceRaw;

  const amount = Number(body.amount) || 0;

  const balanceErr = _checkBalanceRules(body.tx_type, sourceForCheck, amount);
  if (balanceErr) return balanceErr;

  const rule5Err = _checkRule5(body.tx_type, sourceForCheck, body.major_category, body.minor_category);
  if (rule5Err) return rule5Err;

  return { ok: true };
}

function _loadAccountMap() {
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const rows  = sheetToObjectsWithRow(sheet);
  const out   = {};
  rows.forEach(function(a) {
    if (a.id) out[String(a.id)] = a;
  });
  return out;
}

// When source_account is unchanged across old → new, project the source's
// current_value to its post-Phase-1 value (undo the old row's effect on the
// source side). When source_account changes, the old reversal lands on a
// different account and the new source's current_value is correct as-is.
function _postReversalBalance(sourceAccountId, sourceAccount, oldRow) {
  if (!sourceAccount || !oldRow) return sourceAccount;

  const oldSource = String(oldRow[txColIndex('source_account')] || '');
  if (oldSource !== String(sourceAccountId)) return sourceAccount;

  const oldType   = String(oldRow[txColIndex('tx_type')] || '');
  const oldAmount = Number(oldRow[txColIndex('amount')]) || 0;

  let projected = Number(sourceAccount.current_value) || 0;
  if (oldType === 'money-in')       projected -= oldAmount;  // reverse credit
  if (oldType === 'money-out')      projected += oldAmount;  // reverse debit
  if (oldType === 'money-transfer') projected += oldAmount;  // reverse debit

  // Shallow copy — never mutate the caller's account object
  const copy = {};
  Object.keys(sourceAccount).forEach(function(k) { copy[k] = sourceAccount[k]; });
  copy.current_value = projected;
  return copy;
}

// Rules 1 & 3 (source side): asset/investment balance cannot go negative.
// Rules 2 & 4 are intentionally unenforced pending a credit_card_limit schema field (see financial-rules.md).
function _checkBalanceRules(transactionType, sourceAccount, amount) {
  if (!sourceAccount) return null;
  if (transactionType !== 'money-out' && transactionType !== 'money-transfer') return null;

  // Rules 1 & 3 — asset/investment accounts cannot go negative
  if (!isLiabilityType(sourceAccount.type)) {
    const balance = Number(sourceAccount.current_value) || 0;
    if (balance < amount) {
      return {
        ok: false,
        error: 'insufficient_balance',
        detail: sourceAccount.name + ' balance ' + balance.toFixed(2) +
                ' is less than transaction amount ' + Number(amount).toFixed(2),
      };
    }
    return null;
  }

  return null;
}

// Rule 5 — block money-out from a loan account; allow interest/charges exception.
function _checkRule5(transactionType, sourceAccount, majorCategory, minorCategory) {
  if (transactionType !== 'money-out') return null;
  if (!sourceAccount) return null;
  if (!(sourceAccount.type === 'liability' && isLoanSubType(sourceAccount.sub_type))) return null;
  if (majorCategory === 'Debt & finance' && minorCategory === 'Interest & charges') return null;
  return {
    ok: false,
    error: 'money_out_from_loan_not_allowed',
    detail: 'Source ' + sourceAccount.name +
            ' is a loan account; record loan repayments as money-transfer or money-out with the loan as target',
  };
}
