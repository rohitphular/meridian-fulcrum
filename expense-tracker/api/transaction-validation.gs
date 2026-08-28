// =============================================================================
// FULCRUM FORGE — Transaction Validation: input guards for create and update
// Shared across all transaction .gs files via GAS global scope.
// =============================================================================

// ── Category map ─────────────────────────────────────────────────────────────
// Reads the categories sheet ONCE and returns a lookup map keyed by
// "tx_type_key|major_category_key|minor_category_key".
// Call this once per request and pass the result to validateTransactionRecord.

function _buildCategoryMap() {
  const sheet  = getOrCreateSheet(CATEGORIES_SHEET, getCategorySheetColumns());
  const values = sheet.getDataRange().getValues();
  const map    = {};
  if (values.length <= 1) return map;

  const ci = {
    type:         catColIndex('tx_type_key'),
    major:        catColIndex('major_category_key'),
    minor:        catColIndex('minor_category_key'),
    src:          catColIndex('source_account_types'),
    dst:          catColIndex('target_account_types'),
    srcMandatory: catColIndex('source_account_mandatory'),
    dstMandatory: catColIndex('target_account_mandatory'),
    status:       catColIndex('record_status'),
  };

  const toBool = function(v) { return v === true || String(v).toLowerCase() === 'true'; };

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][ci.status]) === 'deleted') continue;
    const key = values[i][ci.type] + '|' + values[i][ci.major] + '|' + values[i][ci.minor];
    map[key] = {
      source_account_types:     String(values[i][ci.src] || '').trim(),
      target_account_types:     String(values[i][ci.dst] || '').trim(),
      source_account_mandatory: toBool(values[i][ci.srcMandatory]),
      target_account_mandatory: toBool(values[i][ci.dstMandatory]),
    };
  }
  return map;
}

// ── Shared transaction record validator ───────────────────────────────────────
// Used by both createTransaction (UI form) and createTransactionsBulk (CSV import).
// catMap must be pre-built via _buildCategoryMap() — never fetch it here.
//
// Amount rules:
//   source_amount — always the primary amount; required and > 0.
//   target_amount — only present for cross-currency transfers; if provided must be > 0.
//                   Same-currency transfers leave it blank; the core defaults to source_amount.

function validateTransactionRecord(body, catMap) {
  if (!body.tx_date_time)
    return { ok: false, error: 'missing_date' };
  if (!body.tx_type || !VALID_TRANSACTION_TYPES.includes(body.tx_type))
    return { ok: false, error: 'invalid_transaction_type' };
  if (!body.major_category || !body.minor_category)
    return { ok: false, error: 'missing_category' };

  const catKey = body.tx_type + '|' + body.major_category + '|' + body.minor_category;
  const cat    = catMap[catKey];
  if (!cat)
    return { ok: false, error: 'unknown_category' };

  if (cat.source_account_mandatory) {
    if (!body.source_account)
      return { ok: false, error: 'missing_source_account' };
    if (!body.source_amount || Number(body.source_amount) <= 0)
      return { ok: false, error: 'missing_source_amount' };
  }

  if (cat.target_account_mandatory) {
    if (!body.target_account)
      return { ok: false, error: 'missing_target_account' };
    if (!body.target_amount || Number(body.target_amount) <= 0)
      return { ok: false, error: 'missing_target_amount' };
  }

  const finErr = _validateFinancialRules(body, null);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

// ── Update validator (unchanged) ──────────────────────────────────────────────

function validateTransactionUpdate(body, oldRow) {
  if (!body.row_num)
    return { ok: false, error: 'missing_row_num' };
  if (!body.tx_date_time)
    return { ok: false, error: 'missing_date' };
  if (!body.tx_type || !VALID_TRANSACTION_TYPES.includes(body.tx_type))
    return { ok: false, error: 'invalid_transaction_type' };
  if (!body.tx_amount || Number(body.tx_amount) <= 0)
    return { ok: false, error: 'invalid_amount' };
  if (!body.account_id)
    return { ok: false, error: 'missing_account_id' };

  const fields = getFieldsForTransactionType(body.tx_type);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field.editable && field.key !== 'row_num' && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable:' + field.key };
    }
  }

  const finErr = _validateFinancialRules(body, oldRow || null);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

// ── Financial hard-block rules ────────────────────────────────────────────────

function _validateFinancialRules(body, oldRow) {
  const accountMap = _loadAccountMap();

  if (body.account_id && !accountMap[String(body.account_id)]) {
    return { ok: false, error: 'unknown_account_id:' + body.account_id };
  }
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

// ── Account-type hint check ───────────────────────────────────────────────────

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
