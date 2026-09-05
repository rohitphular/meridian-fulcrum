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

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][ci.status]) !== 'active') continue;
    if (String(values[i][ci.type]).trim() === '') continue;
    const key = values[i][ci.type] + '|' + values[i][ci.major] + '|' + values[i][ci.minor];
    map[key] = {
      source_account_types:     String(values[i][ci.src]).trim(),
      target_account_types:     String(values[i][ci.dst]).trim(),
      source_account_mandatory: toBool(values[i][ci.srcMandatory]),
      target_account_mandatory: toBool(values[i][ci.dstMandatory]),
    };
  }
  return map;
}

// ── Shared transaction record validator ───────────────────────────────────────
// Used by both createTransaction (UI form) and createTransactionsBulk (CSV import).
// catMap must be pre-built via _buildCategoryMap() — never fetch it here.
// accountMap (optional) — pass a pre-built _loadAccountMap() result to avoid a
//   redundant sheet read; if omitted or null, _validateFinancialRules loads it
//   internally. Callers that validate many rows in a loop MUST pass accountMap.
//
// Amount rules:
//   source_amount_local — always the primary amount; required and > 0 when source account is mandatory.
//   target_amount_local — only present for cross-currency transfers; if provided must be > 0.
//                   Same-currency transfers leave it blank; the core defaults to source_amount_local.
//
// TX-NEW-C-2: tx_amount_local is validated unconditionally (presence + isFinite) before
//   any category-conditional checks. This ensures NaN can never be written regardless
//   of whether a category has both mandatory flags false.

function validateTransactionRecord(body, catMap, accountMap) {
  if (body.tx_date_local === undefined || body.tx_date_local === null || String(body.tx_date_local).trim() === '')
    return { ok: false, error: 'missing_date' };
  if (body.tx_type === undefined || body.tx_type === null || String(body.tx_type).trim() === '' || !VALID_TRANSACTION_TYPES.includes(body.tx_type))
    return { ok: false, error: 'invalid_transaction_type' };

  // TX-NEW-C-2: unconditional amount validation — must run before category-conditional checks.
  // At least one of source_amount_local or target_amount_local must be a finite positive number.
  const srcAmtNum = (body.source_amount_local !== undefined && body.source_amount_local !== null && String(body.source_amount_local).trim() !== '') ? Number(body.source_amount_local) : NaN;
  const tgtAmtNum = (body.target_amount_local !== undefined && body.target_amount_local !== null && String(body.target_amount_local).trim() !== '') ? Number(body.target_amount_local) : NaN;
  if (!Number.isFinite(srcAmtNum) && !Number.isFinite(tgtAmtNum))
    return { ok: false, error: 'missing_source_amount' };
  if (Number.isFinite(srcAmtNum) && srcAmtNum <= 0)
    return { ok: false, error: 'missing_source_amount' };
  if (Number.isFinite(tgtAmtNum) && tgtAmtNum <= 0)
    return { ok: false, error: 'missing_target_amount' };

  if (body.major_category === undefined || body.major_category === null || String(body.major_category).trim() === '' ||
      body.minor_category === undefined || body.minor_category === null || String(body.minor_category).trim() === '')
    return { ok: false, error: 'missing_category' };

  const catKey = body.tx_type + '|' + body.major_category + '|' + body.minor_category;
  const cat    = catMap[catKey];
  if (!cat)
    return { ok: false, error: 'unknown_category' };

  if (cat.source_account_mandatory) {
    if (body.source_account === undefined || body.source_account === null || String(body.source_account).trim() === '')
      return { ok: false, error: 'missing_source_account' };
    if (body.source_amount_local === undefined || body.source_amount_local === null || !Number.isFinite(Number(body.source_amount_local)) || Number(body.source_amount_local) <= 0)
      return { ok: false, error: 'missing_source_amount' };
  }

  if (cat.target_account_mandatory) {
    if (body.target_account === undefined || body.target_account === null || String(body.target_account).trim() === '')
      return { ok: false, error: 'missing_target_account' };
    if (body.target_amount_local === undefined || body.target_amount_local === null || !Number.isFinite(Number(body.target_amount_local)) || Number(body.target_amount_local) <= 0)
      return { ok: false, error: 'missing_target_amount' };
  }

  const finErr = _validateFinancialRules(body, null, accountMap);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

// ── Update validator ──────────────────────────────────────────────────────────
// TX-NEW-H-2: catMap is an optional pre-built category map. If provided (not
//   undefined and not null), it is used directly — skipping the redundant sheet
//   read that _buildCategoryMap() would otherwise trigger. Callers that already
//   hold a catMap MUST pass it here.

function validateTransactionUpdate(body, oldRow, catMap) {
  if (body.row_num === undefined || body.row_num === null || String(body.row_num).trim() === '')
    return { ok: false, error: 'missing_row_num' };
  if (body.tx_date_local === undefined || body.tx_date_local === null || String(body.tx_date_local).trim() === '')
    return { ok: false, error: 'missing_date' };
  if (body.tx_type === undefined || body.tx_type === null || String(body.tx_type).trim() === '' || !VALID_TRANSACTION_TYPES.includes(body.tx_type))
    return { ok: false, error: 'invalid_transaction_type' };
  if (body.tx_amount_local === undefined || body.tx_amount_local === null || !Number.isFinite(Number(body.tx_amount_local)) || Number(body.tx_amount_local) <= 0)
    return { ok: false, error: 'invalid_amount' };
  if (body.account_id === undefined || body.account_id === null || String(body.account_id).trim() === '')
    return { ok: false, error: 'missing_account_id' };

  const fields = getFieldsForTransactionType(body.tx_type);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field.editable && field.key !== 'row_num' && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable', field: field.key };
    }
  }

  // T-H1: validate category FK when major_category or minor_category is being updated.
  if (body.major_category !== undefined || body.minor_category !== undefined) {
    const major = body.major_category !== undefined && body.major_category !== null ? String(body.major_category).trim() : '';
    const minor = body.minor_category !== undefined && body.minor_category !== null ? String(body.minor_category).trim() : '';
    if (major === '' || minor === '')
      return { ok: false, error: 'missing_category' };
    // TX-NEW-H-2: use caller-supplied catMap when available; fall back to building it.
    const resolvedCatMap = (catMap !== undefined && catMap !== null) ? catMap : _buildCategoryMap();
    const catKey = body.tx_type + '|' + major + '|' + minor;
    if (!resolvedCatMap[catKey])
      return { ok: false, error: 'unknown_category' };
  }

  const finErr = _validateFinancialRules(body, oldRow !== undefined ? oldRow : null);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

// ── Financial hard-block rules ────────────────────────────────────────────────
// TX-NEW-H-3: accountMap is an optional pre-built account map. If provided (not
//   undefined and not null), it is used directly. If omitted or null, the map is
//   built internally via _loadAccountMap(). Bulk callers MUST pass accountMap to
//   avoid N× sheet reads.

function _validateFinancialRules(body, oldRow, accountMap) {
  const resolvedAccountMap = (accountMap !== undefined && accountMap !== null) ? accountMap : _loadAccountMap();

  // T-H2: explicit presence checks — no falsy guards.
  // T-C2: error codes carry no embedded colon-data.
  if (body.account_id !== undefined && body.account_id !== null && body.account_id !== '') {
    if (!resolvedAccountMap[String(body.account_id)])
      return { ok: false, error: 'unknown_account_id' };
  }
  if (body.source_account !== undefined && body.source_account !== null && body.source_account !== '') {
    if (!resolvedAccountMap[String(body.source_account)])
      return { ok: false, error: 'unknown_source_account' };
  }
  if (body.target_account !== undefined && body.target_account !== null && body.target_account !== '') {
    if (!resolvedAccountMap[String(body.target_account)])
      return { ok: false, error: 'unknown_target_account' };
  }

  return { ok: true };
}

function _loadAccountMap() {
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const rows  = sheetToObjectsWithRow(sheet);
  const out   = {};
  rows.forEach(function(a) {
    if (a.id === undefined || a.id === null || String(a.id).trim() === '') return;
    const s = String(a.record_status);
    if (s === 'deleted' || s === 'inactive' || s === 'locked') return;
    out[String(a.id)] = a;
  });
  return out;
}

