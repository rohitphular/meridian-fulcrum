// =============================================================================
// FULCRUM FORGE — Report Core: report_master create / update / delete /
// restore / duplicate, and the onEdit sync marker
//
// Stores report configuration only; reports are computed by the analytics job
// (data-synchronization/analytics). Pre-built rows (report_type predefined)
// are locked: the app never edits, deletes or duplicates them.
// Every write sets sync_status like the other masters, so ledger-sheet-extract
// stages the row and acknowledge writes the outcome back.
// =============================================================================

function _rptSheet() {
  return getOrCreateSheet(REPORT_MASTER_SHEET, getReportSheetColumns());
}

// Sheets turns some text into typed cells; read every definition cell back
// as the text form the contract uses.
function _rptCellText(column, value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (!Number.isFinite(value.getTime())) return '';
    const text = sheetLocalDateTimeText(value);
    return column === 'period_from' || column === 'period_to' ? text.slice(0, 10) : text;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return _rptText(value);
}

function _rptRowObject(cells, rowNum) {
  const row = { _row: rowNum };
  getReportSheetColumns().forEach(function(column, index) { row[column] = _rptCellText(column, cells[index]); });
  row.id = row.id.toLowerCase();
  return row;
}

// All rows as text objects with their sheet row number.
function listReportRows() {
  const values = _rptSheet().getDataRange().getValues();
  return values.slice(1).map(function(cells, index) { return _rptRowObject(cells, index + 2); })
    .filter(function(row) { return row.id !== ''; });
}

// What filters may reference: non-deleted accounts, their currencies and
// non-deleted category keys ('major' and 'major|minor').
function rptReferences() {
  const refs = { account_ids: {}, categories: {}, currencies: {} };
  sheetToObjects(getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns())).forEach(function(account) {
    if (_rptText(account.record_status) === 'deleted') return;
    const id = _rptText(account.id).toLowerCase();
    if (id !== '') refs.account_ids[id] = true;
    const currency = _rptText(account.account_currency_local).toUpperCase();
    if (currency !== '') refs.currencies[currency] = true;
  });
  listCategories().forEach(function(category) {
    if (_rptText(category.record_status) === 'deleted') return;
    const major = _rptText(category.major_category_key), minor = _rptText(category.minor_category_key);
    if (major === '') return;
    refs.categories[major] = true;
    if (minor !== '') refs.categories[major + '|' + minor] = true;
  });
  return refs;
}

function _rptNameTaken(rows, name, exceptId) {
  const wanted = name.toLowerCase();
  return rows.some(function(row) {
    return row.id !== exceptId && row.record_status !== 'deleted' && row.report_name.toLowerCase() === wanted;
  });
}

// "Copy of <name>", numbered "(2)", "(3)" … until unique, always ≤ the name limit.
function _rptCopyName(rows, name) {
  const max = REPORT_DEFINITION.name.max_length;
  const base = ('Copy of ' + name).slice(0, max).trim();
  let candidate = base;
  for (let number = 2; _rptNameTaken(rows, candidate, ''); number++) {
    const suffix = ' (' + number + ')';
    candidate = base.slice(0, max - suffix.length).trim() + suffix;
  }
  return candidate;
}

function _rptCells(row) {
  return getReportSheetColumns().map(function(column) {
    const value = row[column];
    return value === undefined || value === null ? '' : value;
  });
}

// Loads the row a row-number request points at, with the stale-record check.
function _rptTarget(body) {
  if (body === undefined || body === null) return { ok: false, error: 'missing_row_num' };
  if (body.row_num === undefined || body.row_num === null || _rptText(body.row_num) === '') return { ok: false, error: 'missing_row_num' };
  const rowNum = Number(body.row_num);
  const sheet = _rptSheet();
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > sheet.getLastRow()) return { ok: false, error: 'invalid_row' };
  const cells = sheet.getRange(rowNum, 1, 1, getReportSheetColumns().length).getValues()[0];
  const row = _rptRowObject(cells, rowNum);
  if (row.id === '') return { ok: false, error: 'report_not_found' };
  if (matchesExpectedRecord(body, cells[reportColIndex('id')], cells[reportColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };
  return { ok: true, sheet: sheet, row: row, rowNum: rowNum };
}

function _rptEditable(row) {
  if (row.report_type === 'predefined') return { ok: false, error: 'predefined_report_locked' };
  if (row.record_status === 'locked') return { ok: false, error: 'record_locked' };
  return { ok: true };
}

function _rptWrite(target, row) {
  target.sheet.getRange(target.rowNum, 1, 1, getReportSheetColumns().length).setValues([_rptCells(row)]);
}

function _rptQueued(row, now) {
  row.sync_status = computeSyncStatus(row.sync_status);
  row.sync_date = '';
  row.sync_notes = '';
  row.updated_at = now;
}

function _rptInsert(values) {
  const rows = listReportRows();
  if (_rptNameTaken(rows, values.report_name, '')) return { ok: false, error: 'duplicate_report_name', field: 'report_name' };
  const now = new Date().toISOString();
  const row = Object.assign({}, values, {
    id: Utilities.getUuid().toLowerCase(), report_type: 'user_defined', predefined_key: '', record_status: 'active',
    created_at: now, updated_at: now, sync_status: SYNC_STATUS_CREATE_PENDING, sync_date: '', sync_notes: '',
  });
  const sheet = _rptSheet();
  sheet.appendRow(_rptCells(row));
  console.log('createReport: created=1');
  return { ok: true, id: row.id, row_num: sheet.getLastRow() };
}

function createReport(body) {
  const validation = validateReportDefinition(body, rptReferences());
  if (validation.ok === false) return validation;
  return _rptInsert(validation.values);
}

function updateReport(body) {
  const target = _rptTarget(body);
  if (target.ok === false) return target;
  const editable = _rptEditable(target.row);
  if (editable.ok === false) return editable;
  if (target.row.record_status === 'deleted') return { ok: false, error: 'report_deleted' };
  const validation = validateReportDefinition(body, rptReferences());
  if (validation.ok === false) return validation;
  if (_rptNameTaken(listReportRows(), validation.values.report_name, target.row.id)) return { ok: false, error: 'duplicate_report_name', field: 'report_name' };
  const unchanged = getReportDefinitionColumns().every(function(column) {
    return _rptText(target.row[column]) === _rptCellText(column, validation.values[column]);
  });
  if (unchanged) return { ok: true, id: target.row.id, unchanged: true };
  const row = Object.assign({}, target.row, validation.values);
  _rptQueued(row, new Date().toISOString());
  _rptWrite(target, row);
  console.log('updateReport: updated=1');
  return { ok: true, id: row.id };
}

function deleteReport(body) {
  const target = _rptTarget(body);
  if (target.ok === false) return target;
  const editable = _rptEditable(target.row);
  if (editable.ok === false) return editable;
  if (target.row.record_status === 'deleted') return { ok: false, error: 'report_deleted' };
  const row = Object.assign({}, target.row, { record_status: 'deleted' });
  _rptQueued(row, new Date().toISOString());
  _rptWrite(target, row);
  const cleared = dashboardLayoutRemoveReport(row.id);
  console.log('deleteReport: deleted=1 layout_slots_cleared=' + cleared);
  return { ok: true, id: row.id, layout_slots_cleared: cleared };
}

function restoreReport(body) {
  const target = _rptTarget(body);
  if (target.ok === false) return target;
  const editable = _rptEditable(target.row);
  if (editable.ok === false) return editable;
  if (target.row.record_status !== 'deleted') return { ok: false, error: 'report_not_deleted' };
  if (_rptNameTaken(listReportRows(), target.row.report_name, target.row.id)) return { ok: false, error: 'duplicate_report_name', field: 'report_name' };
  const row = Object.assign({}, target.row, { record_status: 'active' });
  _rptQueued(row, new Date().toISOString());
  _rptWrite(target, row);
  console.log('restoreReport: restored=1');
  return { ok: true, id: row.id };
}

// Copies a user-defined report's definition into a new report named "Copy of …".
// The copy is validated again: a filter may point at an account deleted since.
function duplicateReport(body) {
  const target = _rptTarget(body);
  if (target.ok === false) return target;
  if (target.row.report_type === 'predefined') return { ok: false, error: 'predefined_report_locked' };
  if (target.row.record_status === 'deleted') return { ok: false, error: 'report_deleted' };
  const source = {};
  getReportDefinitionColumns().forEach(function(column) { source[column] = target.row[column]; });
  source.report_name = _rptCopyName(listReportRows(), target.row.report_name);
  const validation = validateReportDefinition(source, rptReferences());
  if (validation.ok === false) return validation;
  return _rptInsert(validation.values);
}

// A hand edit of a report's definition queues it for sync, like other masters.
// Only the sync cells and updated_at are rewritten.
function markReportEditPending(event) {
  const sheet = event.range.getSheet();
  if (sheet.getName() !== REPORT_MASTER_SHEET) return false;
  const columns = getReportSheetColumns();
  const business = columns.map(function(column, index) { return _RPT_SYSTEM_COLUMNS.indexOf(column) === -1 || column === 'record_status' ? index + 1 : 0; })
    .filter(function(position) { return position > 0; });
  const firstColumn = event.range.getColumn(), lastColumn = firstColumn + event.range.getNumColumns() - 1;
  if (!business.some(function(position) { return position >= firstColumn && position <= lastColumn; })) return true;
  const firstRow = Math.max(2, event.range.getRow());
  const lastRow = Math.min(sheet.getLastRow(), event.range.getRow() + event.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.length !== columns.length || headers.some(function(header, index) { return header !== columns[index]; }))
    throw new Error('sheet_header_mismatch');
  const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, columns.length).getValues();
  const now = new Date().toISOString();
  const statusAt = reportColIndex('sync_status');
  const sync = rows.map(function(row) {
    return _rptText(row[reportColIndex('id')]) === ''
      ? row.slice(statusAt, statusAt + 3)
      : [computeSyncStatus(_rptText(row[statusAt])), '', ''];
  });
  const updated = rows.map(function(row) { return [_rptText(row[reportColIndex('id')]) === '' ? row[reportColIndex('updated_at')] : now]; });
  sheet.getRange(firstRow, statusAt + 1, rows.length, 3).setValues(sync);
  sheet.getRange(firstRow, reportColIndex('updated_at') + 1, rows.length, 1).setValues(updated);
  return true;
}
