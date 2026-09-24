// Pass the parsed complete 14-column CSV rows. Policy values come from that CSV,
// never from an embedded catalog. The UI's CSV import runs the same preflight.
function migrateAccountTypeKeys(catalogRows) {
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) === false) return { ok: false, error: 'busy_retry' };
  try { return _importAccountTypeCatalog(catalogRows, true); }
  catch (_) {
    console.error('migrateAccountTypeKeys: error=account_type_migration_failed');
    return { ok: false, error: 'account_type_migration_failed' };
  } finally { lock.releaseLock(); }
}
function _planAccountTypeReferences(catalog) {
  const pairs = new Set();
  const hints = new Set();
  catalog.forEach(function(row) {
    if (row.id === '') return;
    pairs.add(row.account_type_key + '|' + row.account_subtype_key);
    hints.add(row.account_subtype_key);
    if (row.account_type_key === 'investment') hints.add(row.account_type_key);
  });
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const writes = [];
  let changedRows = 0;
  for (const name of [ACCOUNTS_SHEET, CATEGORIES_SHEET]) {
    _assertMasterSheetNameReady(spreadsheet, name);
    const sheet = spreadsheet.getSheets().find(function(candidate) { return candidate.getName() === name; });
    if (sheet === undefined || sheet.getLastRow() === 0) continue;
    const rows = sheet.getDataRange().getValues();
    const headers = rows[0];
    const expected = name === ACCOUNTS_SHEET ? getAccountSheetColumns() : getCategorySheetColumns();
    if (headers.length !== expected.length || headers.some(function(header, index) { return header !== expected[index]; }))
      return { ok: false, error: 'sheet_header_mismatch', sheet_name: name };
    const ids = new Set();
    for (let index = 1; index < rows.length; index++) {
      const cells = rows[index];
      if (cells.every(function(value) { return _accountTypeText(value) === ''; })) continue;
      const id = _accountTypeText(cells[headers.indexOf('id')]).toLowerCase();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) === false || ids.has(id))
        return { ok: false, error: 'invalid_reference_identity', sheet_name: name };
      ids.add(id);
      let rowChanged = false;
      const changedCells = [];
      const fields = name === ACCOUNTS_SHEET ? ['type', 'sub_type'] : ['source_account_types', 'target_account_types'];
      for (const field of fields) {
        const position = headers.indexOf(field);
        const previous = _accountTypeText(cells[position]);
        const next = name === ACCOUNTS_SHEET ? _accountTypeKey(previous) : splitToList(previous).map(_accountTypeKey).join(', ');
        if (name === CATEGORIES_SHEET && splitToList(next).some(function(key) { return hints.has(key) === false; }))
          return { ok: false, error: 'unknown_account_type_reference', sheet_name: name };
        if (next !== previous) {
          cells[position] = next; rowChanged = true;
          changedCells.push({ column: position + 1, values: [next] });
        }
      }
      if (name === ACCOUNTS_SHEET && pairs.has(cells[headers.indexOf('type')] + '|' + cells[headers.indexOf('sub_type')]) === false)
        return { ok: false, error: 'unknown_account_type_reference', sheet_name: name };
      if (rowChanged) {
        // Queue before changing references, so a failed write never leaves a
        // changed key claiming to be in-sync. No financial/formula cells are written.
        const metadata = [
          { column: headers.indexOf('sync_status') + 1, values: [computeSyncStatus(_accountTypeText(cells[headers.indexOf('sync_status')])), '', ''] },
          { column: headers.indexOf('updated_at') + 1, values: [new Date().toISOString()] },
        ];
        metadata.concat(changedCells).forEach(function(change) {
          writes.push({ sheet: sheet, row_num: index + 1, id_column: headers.indexOf('id') + 1, id: id, column: change.column, values: change.values });
        });
        changedRows++;
      }
    }
  }
  return { ok: true, writes: writes, changed_rows: changedRows };
}
