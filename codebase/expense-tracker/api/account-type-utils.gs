// Read-only inspection: an empty store is not a request to invent classifications.
function _readAccountTypeState() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets().find(function(candidate) { return candidate.getName() === ACCOUNT_TYPES_SHEET; });
  if (sheet === undefined || sheet.getLastRow() === 0) return { sheet: sheet === undefined ? null : sheet, rows: [], requires_migration: false };
  const values = sheet.getDataRange().getValues();
  const columns = getAccountTypeSheetColumns();
  const legacyColumns = columns.filter(function(key) { return key !== 'detail_sheet'; });
  const headers = values[0];
  const matches = function(expected) { return headers.length === expected.length && headers.every(function(value, index) { return value === expected[index]; }); };
  const legacy = matches(legacyColumns);
  // The retired is_loan column must be deleted from the Sheet; positional writes cannot skip it.
  if (headers.indexOf('is_loan') !== -1) throw new Error('account_types_is_loan_column_present');
  if (!legacy && !matches(columns)) throw new Error('sheet_header_mismatch: account_types');
  const rows = values.slice(1).map(function(row, index) {
    const accountType = { _row: index + 2, row_num: index + 2 };
    headers.forEach(function(column, position) {
      accountType[column] = _accountTypeText(row[position]);
    });
    accountType.id = accountType.id.toLowerCase();
    return accountType;
  });
  const requiresMigration = legacy || rows.some(function(row) { return row.account_type_key.indexOf('_') !== -1 || row.account_subtype_key.indexOf('_') !== -1; });
  return { sheet: sheet, rows: rows, requires_migration: requiresMigration };
}
function _accountTypeDefaults(body, previous) {
  const now = new Date().toISOString();
  return {
    id: _accountTypeText(body.id).toLowerCase(), account_type_key: _accountTypeText(body.account_type_key),
    account_type_label: _accountTypeText(body.account_type_label), account_subtype_key: _accountTypeText(body.account_subtype_key),
    account_subtype_label: _accountTypeText(body.account_subtype_label), description: _accountTypeText(body.description),
    detail_sheet: _accountTypeText(body.detail_sheet),
    record_status: _accountTypeText(body.record_status) === '' ? (previous === null ? 'active' : previous.record_status) : _accountTypeText(body.record_status),
    sync_status: previous === null ? SYNC_STATUS_CREATE_PENDING : computeSyncStatus(previous.sync_status),
    sync_date: '', sync_notes: '', created_at: previous === null ? now : previous.created_at, updated_at: now,
  };
}
function _writeAccountTypeRows(rows, state) {
  const columns = getAccountTypeSheetColumns();
  const matrix = [columns].concat(rows.map(function(row) { return columns.map(function(column) { return row[column] === undefined ? '' : row[column]; }); }));
  // Explicit legacy upgrade is authorized only after complete import preflight.
  // One matrix replaces headers and values together so metadata never shifts alone.
  const sheet = state !== undefined && state.requires_migration && state.sheet !== null
    ? state.sheet : getOrCreateSheet(ACCOUNT_TYPES_SHEET, columns);
  sheet.getRange(1, 1, matrix.length, columns.length).setValues(matrix);
}
function getAvailableAccountTypes() {
  const state = _readAccountTypeState();
  if (state.requires_migration) return [];
  const validation = _validateAccountTypeIdentities(state.rows, false);
  if (validation.ok === false) throw new Error('invalid_account_types');
  return state.rows.filter(function(row) { return row.record_status === 'active' || row.record_status === 'locked'; });
}
function getCategoryAccountTypeHints() {
  const hints = new Map();
  getAvailableAccountTypes().forEach(function(row) {
    hints.set(row.account_subtype_key, { value: row.account_subtype_key, label: row.account_subtype_label });
    // Keep the established broad investment hint alongside specific subtypes.
    if (row.account_type_key === 'investment' && hints.has(row.account_type_key) === false)
      hints.set(row.account_type_key, { value: row.account_type_key, label: row.account_type_label });
  });
  return Array.from(hints.values());
}
function _countAccountTypeReferences(accountType, accountsOnly) {
  let count = 0;
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const names = accountsOnly ? [ACCOUNTS_SHEET] : [ACCOUNTS_SHEET, CATEGORIES_SHEET];
  for (const name of names) _assertMasterSheetNameReady(spreadsheet, name);
  const sheets = spreadsheet.getSheets();
  for (const name of names) {
    const sheet = sheets.find(function(candidate) { return candidate.getName() === name; });
    if (sheet === undefined || sheet.getLastRow() === 0) continue;
    const headers = sheet.getDataRange().getValues()[0];
    const required = name === ACCOUNTS_SHEET ? ['type', 'sub_type'] : ['source_account_types', 'target_account_types'];
    if (required.some(function(key) { return headers.indexOf(key) === -1; })) throw new Error('sheet_header_mismatch: ' + name);
    sheetToObjects(sheet).forEach(function(row) {
      if (name === ACCOUNTS_SHEET) {
        if (_accountTypeKey(row.type) === _accountTypeKey(accountType.account_type_key) && _accountTypeKey(row.sub_type) === _accountTypeKey(accountType.account_subtype_key)) count++;
      } else {
        const hints = splitToList(row.source_account_types).concat(splitToList(row.target_account_types)).map(_accountTypeKey);
        if (hints.indexOf(_accountTypeKey(accountType.account_subtype_key)) !== -1 || (_accountTypeKey(accountType.account_type_key) === 'investment' && hints.indexOf('investment') !== -1)) count++;
      }
    });
  }
  return count;
}
