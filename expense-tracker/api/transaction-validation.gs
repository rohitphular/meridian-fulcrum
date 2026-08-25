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

// ── Financial hard-block rules — server-side safety net ─────────────────────
// Mirrors the frontend rule logic in app/sections/transactions.js so a direct
// POST or a request from a stale UI cannot bypass the rules. Specifications:
// docs/financial-rules.md.
//
//   T-03: unknown account refs are rejected before any sheet mutation.

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

