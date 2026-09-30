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
  const contextValidation = validateTransactionContext(body, body.tx_timezone_local);
  if (contextValidation.ok === false) return contextValidation;
  for (const field of ['source_amount_local', 'target_amount_local']) {
    const value = body[field];
    if (value !== undefined && value !== null && String(value).trim() !== ''
        && (isFiniteDecimal(value) === false || Number(value) <= 0))
      return { ok: false, error: field === 'source_amount_local' ? 'missing_source_amount' : 'missing_target_amount' };
  }

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

  if (cat.source_account_mandatory && cat.target_account_mandatory) {
    if (String(body.source_account).trim().toLowerCase() === String(body.target_account).trim().toLowerCase()) {
      return { ok: false, error: 'same_transfer_account' };
    }
    // A child retains the initiating category keys while reversing direction.
    // Require that exact classification before either leg can reach the Sheet.
    const reverseType = body.tx_type === 'money-out' ? 'money-in' : 'money-out';
    const reverseKey = reverseType + '|' + body.major_category + '|' + body.minor_category;
    if (catMap[reverseKey] === undefined) {
      return { ok: false, error: 'missing_reverse_transfer_category' };
    }
  }

  // The single-leg writer selects the target whenever source is not mandatory.
  // Validate that selected leg even for categories with both flags false.
  if (cat.source_account_mandatory !== true && cat.target_account_mandatory !== true) {
    if (body.target_account === undefined || body.target_account === null || String(body.target_account).trim() === '')
      return { ok: false, error: 'missing_target_account' };
    if (!Number.isFinite(tgtAmtNum) || tgtAmtNum <= 0)
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
  if (isFiniteDecimal(body.tx_amount_local) === false || Number(body.tx_amount_local) <= 0)
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

  const contextValidation = validateTransactionContext(body, oldRow[txColIndex('tx_timezone_local')]);
  if (contextValidation.ok === false) return contextValidation;

  // The writer replaces both category cells, so omitted keys must not erase a
  // previously valid classification and leave a row that extraction rejects.
  const major = body.major_category !== undefined && body.major_category !== null ? String(body.major_category).trim() : '';
  const minor = body.minor_category !== undefined && body.minor_category !== null ? String(body.minor_category).trim() : '';
  if (major === '' || minor === '') return { ok: false, error: 'missing_category' };
  const resolvedCatMap = (catMap !== undefined && catMap !== null) ? catMap : _buildCategoryMap();
  const catKey = body.tx_type + '|' + major + '|' + minor;
  if (!resolvedCatMap[catKey]) return { ok: false, error: 'unknown_category' };

  // An edit that keeps the row's account may target an inactive/locked (closed) account,
  // matching bulk import; moving a row onto a different account still requires an active one.
  const keepsAccount = oldRow !== undefined && oldRow !== null
    && body.account_id !== undefined && body.account_id !== null
    && String(body.account_id) === String(oldRow[txColIndex('account_id')]);
  const finErr = _validateFinancialRules(body, oldRow !== undefined ? oldRow : null,
    keepsAccount ? _loadAccountMap({ include_closed: true }) : undefined);
  if (!finErr.ok) return finErr;

  return { ok: true };
}

function validateTransactionContext(body, timezoneValue) {
  const key = localDateTimeKey(body.tx_date_local);
  if (key === null) return { ok: false, error: 'invalid_tx_date_local' };
  if (timezoneValue !== undefined && timezoneValue !== null && typeof timezoneValue !== 'string')
    return { ok: false, error: 'invalid_tx_timezone_local' };
  const timezone = timezoneValue === undefined || timezoneValue === null || timezoneValue.trim() === ''
    ? 'Europe/London' : timezoneValue.trim();
  try { ianaDateFormatter(timezone).format(new Date()); }
  catch (_) { return { ok: false, error: 'invalid_tx_timezone_local' }; }
  const wallError = localWallTimeError(key, timezone);
  if (wallError !== null) return { ok: false, error: wallError, field: 'tx_date_local' };
  let present = 0;
  for (const field of ['user_location_latitude', 'user_location_longitude']) {
    const value = body[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    present++;
    if (isFiniteDecimal(value) === false) return { ok: false, error: 'invalid_' + field };
    if (Math.abs(Number(value)) > (field === 'user_location_latitude' ? 90 : 180))
      return { ok: false, error: field === 'user_location_latitude' ? 'latitude_out_of_range' : 'longitude_out_of_range' };
  }
  if (present === 1) return { ok: false, error: 'incomplete_location_coordinates' };
  const beneficiaryValidation = validateTransactionBeneficiaries(body.beneficiaries);
  if (beneficiaryValidation.ok === false) return beneficiaryValidation;
  return { ok: true };
}

function validateTransactionBeneficiaries(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true };
  const entries = String(value).split(';').map(function(entry) { return entry.trim(); });
  if (entries.some(function(entry) { return entry === ''; })) return { ok: false, error: 'beneficiary_empty_name' };
  const explicit = entries.map(function(entry) { return entry.indexOf(':') !== -1; });
  if (explicit.some(Boolean) && !explicit.every(Boolean)) return { ok: false, error: 'beneficiary_inconsistent_percentage_format' };
  const names = [];
  if (explicit.every(Boolean)) {
    let totalUnits = 0;
    for (const entry of entries) {
      const separator = entry.indexOf(':');
      const name = entry.slice(0, separator).trim();
      if (name === '') return { ok: false, error: 'beneficiary_empty_name' };
      const key = decimalValueKey(entry.slice(separator + 1).trim());
      if (key === null || key === '0' || key[0] === '-') return { ok: false, error: 'beneficiary_invalid_percentage' };
      const parts = key.split('e'), digits = parts[0], exponent = Number(parts[1]);
      const magnitude = digits.length + exponent;
      if (magnitude > 3 || (magnitude === 3 && key !== '1e2')) return { ok: false, error: 'beneficiary_invalid_percentage' };
      // Exact decimal HALF_UP at four places without binary-float rounding.
      const places = digits.length + exponent + 4;
      let units = places <= 0 ? 0 : Number(digits.slice(0, places).padEnd(places, '0'));
      const nextDigit = places < 0 ? '0' : digits[places];
      if (nextDigit !== undefined && nextDigit >= '5') units++;
      if (units === 0) return { ok: false, error: 'beneficiary_percentage_rounds_to_zero' };
      totalUnits += units;
      names.push(name);
    }
    if (totalUnits !== 1000000) return { ok: false, error: 'beneficiary_percentages_do_not_sum_to_100' };
  } else {
    entries.forEach(function(entry) { names.push(entry); });
    const units = Math.floor(1000000 / names.length + 0.5);
    if (units <= 0 || 1000000 - units * (names.length - 1) <= 0) return { ok: false, error: 'too_many_beneficiaries' };
  }
  if (new Set(names).size !== names.length) return { ok: false, error: 'duplicate_beneficiary' };
  return { ok: true };
}

// Interactive operations remain single-leg edits. Check the resulting pair so
// a successful UI write cannot leave a relationship that extraction rejects.
function validateTransactionPairChange(sheet, rowNum, candidate) {
  const rows = sheet.getDataRange().getValues().slice(1);
  rows[rowNum - 2] = candidate;
  function identity(row, field) { return String(row[txColIndex(field)]).trim().toLowerCase(); }
  const changedId = identity(candidate, 'id');
  const changedParent = identity(candidate, 'parent_tx_id');
  const rootId = changedParent === '' ? changedId : changedParent;
  const roots = rows.filter(function(row) { return identity(row, 'id') === rootId; });
  const children = rows.filter(function(row) {
    return identity(row, 'parent_tx_id') === rootId && String(row[txColIndex('record_status')]) !== 'deleted';
  });
  if (children.length === 0) return { ok: true };
  if (roots.length !== 1 || children.length > 1) return { ok: false, error: 'invalid_transfer_pair' };
  const root = roots[0];
  if (String(root[txColIndex('record_status')]) === 'deleted')
    return { ok: false, error: 'transfer_parent_deleted' };
  if (identity(root, 'parent_tx_id') !== '') return { ok: false, error: 'invalid_transfer_pair' };
  const child = children[0];
  if (identity(root, 'account_id') === identity(child, 'account_id') || root[txColIndex('tx_type')] === child[txColIndex('tx_type')])
    return { ok: false, error: 'invalid_transfer_pair' };
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

// opts.include_closed === true keeps inactive/locked accounts in the map (deleted is
// always excluded). Used by the bulk transaction importer, where historical rows
// legitimately reference accounts that have since been closed. Omitted/false → strict
// map (active only) for interactive create, so new transactions can't be booked against
// a closed account (Round-14 guard).
function _loadAccountMap(opts) {
  const includeClosed = opts !== undefined && opts !== null && opts.include_closed === true;
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const rows  = sheetToObjectsWithRow(sheet);
  const out   = {};
  rows.forEach(function(a) {
    if (a.id === undefined || a.id === null || String(a.id).trim() === '') return;
    const s = String(a.record_status);
    if (s === 'deleted') return;
    if (includeClosed === false && (s === 'inactive' || s === 'locked')) return;
    out[String(a.id)] = a;
  });
  return out;
}
