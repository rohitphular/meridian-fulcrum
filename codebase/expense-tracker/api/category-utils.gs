// =============================================================================
// FULCRUM FORGE — Category Utils
// =============================================================================

function normaliseKeywords(keywords) {
  return splitToList(keywords).map(function(k) { return k.toLowerCase(); }).join(', ');
}

function normaliseCandidates(str) {
  return splitToList(str).join(', ');
}

// Hint values come from configured classifications; investment retains its
// established group shorthand. Labels and subtype membership come from the Sheet.
function _categoryHintContext() {
  try {
    const state = _readAccountTypeState();
    if (state.requires_migration) return { ok: false, error: 'account_types_migration_required', field: 'account_types' };
    const rows = state.rows.filter(function(row) { return !_accountTypeRowIsBlank(row); });
    if (rows.length === 0) return { ok: false, error: 'account_types_missing', field: 'account_types' };
    const validation = _validateAccountTypeIdentities(rows, false);
    if (!validation.ok) return { ok: false, error: 'invalid_account_types', field: 'account_types', reason: validation.error };
    const valid = new Set();
    rows.forEach(function(row) {
      if (row.record_status !== 'active' && row.record_status !== 'locked') return;
      valid.add(row.account_subtype_key);
      if (row.account_type_key === 'investment') valid.add('investment');
    });
    return { ok: true, valid: valid };
  } catch (error) {
    if (error.message === 'account_types_is_loan_column_present') return { ok: false, error: error.message, field: 'account_types' };
    return { ok: false, error: 'invalid_account_types', field: 'account_types' };
  }
}

function _canonicalCategoryHint(value, context) {
  const key = value.toLowerCase();
  if (context.ok && context.valid.has(key)) return key;
  const migrated = key.replace(/_/g, '-');
  if (context.ok && context.valid.has(migrated)) return migrated;
  return key;
}

function normaliseAccountTypes(str, context) {
  const values = splitToList(str);
  if (values.length === 0) return '';
  const hints = context === undefined ? _categoryHintContext() : context;
  // Validation rejects unknown tokens. Never silently drop a supplied hint.
  return values.map(function(key) { return _canonicalCategoryHint(key, hints); }).join(', ');
}

function validateCategoryAccountTypeHints(body, context) {
  const hints = ['source_account_types', 'target_account_types'];
  if (hints.every(function(field) { return splitToList(body[field]).length === 0; })) return { ok: true };
  const configured = context === undefined ? _categoryHintContext() : context;
  if (!configured.ok) return configured;
  for (const field of hints) {
    const unknown = splitToList(body[field]).filter(function(key) { return !configured.valid.has(_canonicalCategoryHint(key, configured)); });
    if (unknown.length > 0)
      return { ok: false, error: 'invalid_' + field, field: field, invalid_values: unknown };
  }
  return { ok: true };
}

function _categoryImportResult(cat, index, result) {
  const response = Object.assign({ index: index, key: cat && cat.id !== undefined ? strField(cat.id) : '' }, result);
  if (cat && Number.isInteger(cat.csv_row_num) && cat.csv_row_num >= 2) response.csv_row_num = cat.csv_row_num;
  if (!response.ok && response.reason === undefined) response.reason = response.error;
  return response;
}

// Read existing dependencies without creating tabs during an import preflight.
function _countCategoryKeyReferences(row) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = spreadsheet.getSheets();
  let count = 0;
  for (const name of [TRANSACTIONS_SHEET, SUBSCRIPTIONS_SHEET]) {
    _assertMasterSheetNameReady(spreadsheet, name);
    const sheet = sheets.find(function(candidate) { return candidate.getName() === name; });
    if (sheet === undefined || sheet.getLastRow() === 0) continue;
    const values = sheet.getDataRange().getValues();
    const fields = ['tx_type', 'major_category', 'minor_category'];
    if (fields.some(function(field) { return values[0].indexOf(field) === -1; })) throw new Error('sheet_header_mismatch');
    const expected = [row[catColIndex('tx_type_key')], row[catColIndex('major_category_key')], row[catColIndex('minor_category_key')]];
    values.slice(1).forEach(function(candidate) {
      if (fields.every(function(field, index) { return strField(candidate[values[0].indexOf(field)]) === expected[index]; })) count++;
    });
  }
  return count;
}
