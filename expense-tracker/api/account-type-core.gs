function listAccountTypes() {
  const state = _readAccountTypeState();
  const validation = _validateAccountTypeIdentities(state.rows, state.requires_migration);
  if (validation.ok === false) throw new Error('invalid_account_types');
  return state.rows.filter(function(row) { return row.id !== ''; });
}
function createAccountType() { return { ok: false, error: 'account_type_creation_restricted' }; }

// doPost holds the script lock. A complete CSV can bootstrap an empty Sheet;
// once populated, imports may update existing UUIDs only.
function createAccountTypesBulk(body) {
  return _importAccountTypeCatalog(body.account_types, false);
}
function _importAccountTypeCatalog(incoming, fullCatalog) {
  if (!Array.isArray(incoming) || incoming.length === 0) return { ok: false, error: 'missing_account_types' };
  const prepared = [];
  for (const source of incoming) {
    const validation = validateAccountTypeCreate(source, true, false);
    if (validation.ok === false) return validation;
    prepared.push(_accountTypeDefaults(source, null));
  }
  const inputValidation = _validateAccountTypeIdentities(prepared, false);
  if (inputValidation.ok === false) return inputValidation;
  const state = _readAccountTypeState();
  const existingValidation = _validateAccountTypeIdentities(state.rows, state.requires_migration);
  if (existingValidation.ok === false) return existingValidation;
  const existing = state.rows.filter(function(row) { return row.id !== ''; });
  const importedIds = new Set(prepared.map(function(row) { return row.id; }));
  if ((state.requires_migration || fullCatalog) && existing.some(function(row) { return importedIds.has(row.id) === false; }))
    return { ok: false, error: 'complete_account_type_catalog_required' };
  const rows = state.rows.slice();
  const results = [];
  for (let index = 0; index < prepared.length; index++) {
    const incomingRow = prepared[index];
    const rowIndex = rows.findIndex(function(row) { return row.id === incomingRow.id; });
    if (rowIndex === -1 && existing.length > 0) return { ok: false, error: 'account_type_creation_restricted' };
    const previous = rowIndex === -1 ? null : rows[rowIndex];
    const replacement = _accountTypeDefaults(incoming[index], previous);
    if (previous !== null) {
      const validation = _validateAccountTypeReplacement(previous, replacement, state.requires_migration);
      if (validation.ok === false) return validation;
    } else if (replacement.record_status === 'inactive' || replacement.record_status === 'deleted') {
      const count = _countAccountTypeReferences(replacement);
      if (count > 0) return { ok: false, error: 'account_type_in_use', referenced_count: count };
    }
    // Same values as stored: keep the stored row (and its sync status) as it is.
    const columns = getAccountTypeSheetColumns();
    if (previous !== null && importRowUnchanged(columns, columns.map(function(column) { return previous[column]; }), columns.map(function(column) { return replacement[column]; }))) {
      results.push({ key: previous.id, id: previous.id, ok: true, action: 'unchanged' });
      continue;
    }
    if (rowIndex === -1) rows.push(replacement);
    else rows[rowIndex] = replacement;
    results.push({ key: replacement.id, id: replacement.id, ok: true, action: previous === null ? 'created' : 'updated' });
  }
  const finalValidation = _validateAccountTypeIdentities(rows, false);
  if (finalValidation.ok === false) return finalValidation;
  const plan = _planAccountTypeReferences(rows);
  if (plan.ok === false) return plan;
  // Every row identical to the stored catalog: leave the tab as it is (a legacy layout
  // still gets its upgrade write). Dependent reference updates below still apply,
  // so a retry after a failed dependent write completes the migration.
  const catalogWritten = state.requires_migration || results.some(function(row) { return row.action !== 'unchanged'; });
  let sheetWritten = false;
  try {
    if (catalogWritten) { _writeAccountTypeRows(rows, state); sheetWritten = true; }
    plan.writes.forEach(function(write) {
      if (write.row_num < 2 || write.row_num > write.sheet.getLastRow()
          || _accountTypeText(write.sheet.getRange(write.row_num, write.id_column).getValues()[0][0]).toLowerCase() !== write.id)
        throw new Error('source_row_changed');
      write.sheet.getRange(write.row_num, write.column, 1, write.values.length).setValues([write.values]);
      sheetWritten = true;
    });
  } catch (_) {
    console.error('_importAccountTypeCatalog: error=account_type_import_failed retry=import_complete_catalog sheet_written=' + sheetWritten);
    // sheet_written: part of the change reached the Sheet, so cached views must be refreshed.
    return { ok: false, error: 'account_type_import_failed', sheet_written: sheetWritten };
  }
  const created = results.filter(function(row) { return row.action === 'created'; }).length;
  const skipped = results.filter(function(row) { return row.action === 'unchanged'; }).length;
  const updated = results.length - created - skipped;
  console.log('_importAccountTypeCatalog: created=' + created + ' updated=' + updated + ' unchanged=' + skipped + ' references_migrated=' + plan.changed_rows);
  return { ok: true, created: created, updated: updated, skipped: skipped, failed: 0, results: results, references_migrated: plan.changed_rows, catalog_written: catalogWritten };
}
function updateAccountType(body) { return _changeAccountType(body, null); }
function deleteAccountType(body) { return _changeAccountType(body, 'deleted'); }
function restoreAccountType(body) { return _changeAccountType(body, 'active'); }
function _changeAccountType(body, status) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const rowNum = Number(body.row_num);
  if (!Number.isInteger(rowNum) || rowNum < 2) return { ok: false, error: 'invalid_row' };
  const state = _readAccountTypeState();
  if (state.requires_migration) return { ok: false, error: 'account_type_migration_required' };
  if (state.sheet === null || rowNum > state.sheet.getLastRow()) return { ok: false, error: 'invalid_row' };
  const previous = state.rows[rowNum - 2];
  if (matchesExpectedRecord(body, previous.id, previous.updated_at) === false) return { ok: false, error: 'stale_record' };
  if (body.id !== undefined && _accountTypeText(body.id).toLowerCase() !== previous.id) return { ok: false, error: 'stale_row' };
  const candidate = Object.assign({}, previous);
  for (const field of ['id', 'account_type_key', 'account_subtype_key']) {
    if (body[field] !== undefined && _accountTypeText(body[field]) !== previous[field]) return { ok: false, error: 'field_not_editable', field: field };
  }
  function writeField(key) {
    if (ACCOUNT_TYPE_SCHEMA[key].editable && body[key] !== undefined) candidate[key] = body[key];
  }
  if (status === null) {
    for (const key of ['account_type_label', 'account_subtype_label', 'description', 'detail_sheet', 'record_status']) writeField(key);
  } else {
    if (status === 'active' && previous.record_status !== 'deleted') return { ok: false, error: 'account_type_not_deleted' };
    candidate.record_status = status;
  }
  const validation = validateAccountTypeCreate(candidate, true, false);
  if (validation.ok === false) return validation;
  const replacement = _accountTypeDefaults(candidate, previous);
  const replacementValidation = _validateAccountTypeReplacement(previous, replacement, false);
  if (replacementValidation.ok === false) return replacementValidation;
  const rows = state.rows.slice();
  rows[rowNum - 2] = replacement;
  // Family labels are one shared value. Editing it updates every sibling, with
  // the same locked-row checks and pending metadata as a direct row edit.
  for (let index = 0; index < rows.length; index++) {
    const sibling = state.rows[index];
    if (index === rowNum - 2 || sibling.account_type_key !== previous.account_type_key || sibling.account_type_label === replacement.account_type_label) continue;
    const changed = _accountTypeDefaults(Object.assign({}, sibling, { account_type_label: replacement.account_type_label }), sibling);
    const siblingValidation = _validateAccountTypeReplacement(sibling, changed, false);
    if (siblingValidation.ok === false) return siblingValidation;
    rows[index] = changed;
  }
  const identities = _validateAccountTypeIdentities(rows, false);
  if (identities.ok === false) return identities;
  _writeAccountTypeRows(rows, state);
  return { ok: true, id: replacement.id };
}
function markAccountTypeEditPending(event) {
  const edited = event.range.getSheet();
  if (edited.getName() !== ACCOUNT_TYPES_SHEET) return false;
  const state = _readAccountTypeState();
  if (state.requires_migration) throw new Error('account_type_migration_required');
  if (event.range.getColumn() > accountTypeColIndex('record_status') + 1) return true;
  const firstRow = Math.max(2, event.range.getRow());
  const lastRow = Math.min(edited.getLastRow(), event.range.getRow() + event.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const sheet = getOrCreateSheet(ACCOUNT_TYPES_SHEET, getAccountTypeSheetColumns());
  const rows = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  for (let rowNum = firstRow; rowNum <= lastRow; rowNum++) {
    if (rowNum < 2 || rowNum > sheet.getLastRow()) throw new Error('invalid_row');
    if (_accountTypeText(rows[rowNum - 1][0]) === '') continue;
    sheet.getRange(rowNum, accountTypeColIndex('sync_status') + 1, 1, 3).setValues([[computeSyncStatus(_accountTypeText(rows[rowNum - 1][accountTypeColIndex('sync_status')])), '', '']]);
    sheet.getRange(rowNum, accountTypeColIndex('updated_at') + 1).setValue(now);
  }
  return true;
}
