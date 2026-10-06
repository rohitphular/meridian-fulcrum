// =============================================================================
// FULCRUM FORGE — Account types: CSV import endpoint (create_account_types_bulk)
// The browser sends the raw file; parsing and every row rule live here.
// Field and identity rules reuse validateAccountTypeCreate and
// _validateAccountTypeIdentities; Sheet-dependent rules (existing UUIDs only,
// immutable keys, complete legacy catalog) stay in createAccountTypesBulk.
// =============================================================================

const ACCOUNT_TYPE_IMPORT_MESSAGES = {
  missing_id: 'a valid UUID is required.',
  invalid_id: 'a valid UUID is required.',
  invalid_account_type_key: 'a hyphenated type key and label are required.',
  missing_account_type_label: 'a hyphenated type key and label are required.',
  invalid_account_subtype_key: 'a hyphenated subtype key and label are required.',
  missing_account_subtype_label: 'a hyphenated subtype key and label are required.',
  invalid_detail_sheet: 'unsupported detail sheet.',
  invalid_record_status: 'invalid record status.',
  duplicate_account_type_id: 'duplicate UUID.',
  duplicate_account_type: 'duplicate type/subtype key.',
  duplicate_account_subtype_key: 'duplicate type/subtype key.',
  inconsistent_account_type_label: 'conflicting labels for the same type.',
  reserved_account_subtype_key: 'subtype keys must differ from type keys.',
};

// Like the other master CSVs, the file holds the business columns and
// record_status only; audit and sync columns are server-owned. An older file
// that still has them is accepted and those columns are ignored.
const ACCOUNT_TYPE_SERVER_COLUMNS = ['sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];

function getAccountTypeCsvColumns() {
  return getAccountTypeSheetColumns().filter(function(column) { return ACCOUNT_TYPE_SERVER_COLUMNS.indexOf(column) === -1; });
}

// body: { csv, dry_run? }. dry_run checks the file only and never reads a Sheet,
// so the factory-reset preflight can run it against an old spreadsheet.
function importAccountTypesCsv(body) {
  const parsed = parseCsvImport(body);
  if (parsed.ok === false) return parsed;
  const columns = getAccountTypeCsvColumns();
  const unexpected = parsed.headers.filter(function(header) { return columns.indexOf(header) === -1 && ACCOUNT_TYPE_SERVER_COLUMNS.indexOf(header) === -1; });
  if (unexpected.length > 0 || columns.some(function(column) { return parsed.headers.indexOf(column) === -1; })) {
    const retired = parsed.headers.indexOf('is_loan') === -1 ? '' : ' The retired is_loan column must be removed.';
    return { ok: false, error: 'invalid_csv_headers', errors: ['CSV headers must match the account_types export: ' + columns.join(', ') + '.' + retired] };
  }
  const rows = parsed.rows.map(function(row) {
    const shaped = {};
    columns.forEach(function(column) { shaped[column] = row[column]; });
    shaped.id = shaped.id.toLowerCase();
    return shaped;
  });
  const errors = _accountTypeCsvErrors(rows, parsed.rows);
  if (errors.length > 0) return csvRowErrors(errors);
  if (isDryRun(body)) return { ok: true, dry_run: true, rows: rows.length };
  const result = createAccountTypesBulk({ account_types: rows });
  if (Array.isArray(result.results)) {
    // Bulk results are pushed in input order, one per row.
    result.results.forEach(function(entry, index) { entry.line = parsed.rows[index]._line; });
  }
  console.log('importAccountTypesCsv: rows=' + rows.length + ' ok=' + (result.ok === true));
  return Object.assign({ rows: rows.length }, result);
}

// Row-level format and whole-file identity checks, each reported with its CSV line.
function _accountTypeCsvErrors(rows, sourceRows) {
  const errors = [];
  const message = function(index, code) {
    const text = ACCOUNT_TYPE_IMPORT_MESSAGES[code] === undefined ? code : ACCOUNT_TYPE_IMPORT_MESSAGES[code];
    return 'Row ' + sourceRows[index]._line + ': ' + text;
  };
  rows.forEach(function(row, index) {
    // Import requires an explicit status; a blank would silently default.
    const validation = row.record_status === '' ? { ok: false, error: 'invalid_record_status' } : validateAccountTypeCreate(row, true, false);
    if (validation.ok === false) errors.push(message(index, validation.error));
  });
  if (errors.length > 0) return errors;
  // Grow the accepted set one row at a time so a whole-catalog rule failure
  // points at the row that introduced it; a rejected row is left out.
  let accepted = [];
  rows.forEach(function(row, index) {
    const candidate = accepted.concat([row]);
    const validation = _validateAccountTypeIdentities(candidate, false);
    if (validation.ok === false) errors.push(message(index, validation.error));
    else accepted = candidate;
  });
  return errors;
}
