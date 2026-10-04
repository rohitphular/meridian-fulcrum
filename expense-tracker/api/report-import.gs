// =============================================================================
// FULCRUM FORGE — Report CSV import: create_reports_bulk, import_dashboard_layout
//
// The backup round trip for report configuration (ledger-sheet-load and the app).
// Like the other master CSVs, the files hold business columns only: created_at,
// updated_at and the sync cells are set here and ignored if a file has them.
// report_master.csv holds pre-built and user-defined rows in one file, matched by
// id. Pre-built rows must carry the catalogue's id and predefined_key; their
// name and description always come from the contract and they stay locked.
// The whole file is validated before anything is written; rows equal to the
// stored row are left untouched (skipped), so their sync status is kept.
// dashboard_layout.csv holds the 8 Home slots and is saved like the app's
// layout editor (updateDashboardLayout).
// =============================================================================

const REPORT_IMPORT_REQUIRED_HEADERS = ['id', 'report_type', 'report_name'];
const DASHBOARD_IMPORT_REQUIRED_HEADERS = ['slot', 'report_id'];

function _rptImportError(row, error, field) {
  return 'Row ' + row._line + ': ' + error + (field === undefined || field === '' ? '' : ' (' + field + ')') + '.';
}

// One CSV row → the values to store, or an error line. refs null = format only.
function _rptImportShape(row, refs) {
  const id = _rptText(row.id).toLowerCase();
  if (!isAccountUuid(id)) return { ok: false, line: _rptImportError(row, 'invalid_id', 'id') };
  const type = _rptText(row.report_type) === '' ? 'user_defined' : _rptText(row.report_type);
  if (rptChoice(REPORT_DEFINITION.report_types, type) === null) return { ok: false, line: _rptImportError(row, 'invalid_report_type', 'report_type') };
  const status = _rptText(row.record_status);
  if (status !== '' && VALID_RECORD_STATUSES.indexOf(status) === -1) return { ok: false, line: _rptImportError(row, 'invalid_record_status', 'record_status') };
  const values = {};
  if (type === 'predefined') {
    const report = rptPredefinedByKey(_rptText(row.predefined_key));
    if (report === null) return { ok: false, line: _rptImportError(row, 'invalid_predefined_key', 'predefined_key') };
    if (report.id !== id) return { ok: false, line: _rptImportError(row, 'invalid_predefined_key', 'id') };
    getReportDefinitionColumns().forEach(function(column) { values[column] = ''; });
    values.report_name = report.title.slice(0, REPORT_DEFINITION.name.max_length);
    values.report_description = report.description.slice(0, REPORT_DEFINITION.description.max_length);
    return { ok: true, id: id, report_type: type, predefined_key: report.key, record_status: REPORT_DEFINITION.predefined_record_status, values: values };
  }
  if (_rptText(row.predefined_key) !== '') return { ok: false, line: _rptImportError(row, 'invalid_predefined_key', 'predefined_key') };
  const validation = validateReportDefinition(row, refs);
  if (validation.ok === false) return { ok: false, line: _rptImportError(row, validation.error, validation.field) };
  return { ok: true, id: id, report_type: type, predefined_key: '', record_status: status, values: validation.values };
}

function _rptImportShapeAll(rows, refs) {
  const errors = [], shaped = [], lineById = {}, lineByName = {};
  rows.forEach(function(row) {
    const result = _rptImportShape(row, refs);
    if (result.ok === false) { errors.push(result.line); return; }
    if (lineById[result.id] !== undefined) { errors.push(_rptImportError(row, 'id repeats row ' + lineById[result.id], 'id')); return; }
    lineById[result.id] = row._line;
    if (result.report_type === 'user_defined' && result.record_status !== 'deleted') {
      const name = result.values.report_name.toLowerCase();
      if (lineByName[name] !== undefined) { errors.push(_rptImportError(row, 'duplicate_report_name', 'report_name')); return; }
      lineByName[name] = row._line;
    }
    result.line = row._line;
    shaped.push(result);
  });
  return { errors: errors, shaped: shaped };
}

function importReportsCsv(body) {
  const parsed = parseCsvImport(body);
  if (!parsed.ok) return parsed;
  const missing = REPORT_IMPORT_REQUIRED_HEADERS.filter(function(header) { return parsed.headers.indexOf(header) === -1; });
  if (missing.length > 0) return { ok: false, error: 'invalid_csv_headers', errors: ['Missing required headers: ' + missing.join(', ') + '.'] };
  const format = _rptImportShapeAll(parsed.rows, null);
  if (format.errors.length > 0) {
    console.log('importReportsCsv: rows=' + parsed.rows.length + ' error=invalid_csv_rows count=' + format.errors.length);
    return csvRowErrors(format.errors);
  }
  if (isDryRun(body)) return { ok: true, dry_run: true, rows: parsed.rows.length };

  // Filters must point at accounts, categories and currencies that exist now.
  const checked = _rptImportShapeAll(parsed.rows, rptReferences());
  const errors = checked.errors.slice();
  const existing = {};
  listReportRows().forEach(function(row) { existing[row.id] = row; });
  const incoming = {};
  checked.shaped.forEach(function(item) { incoming[item.id] = item; });
  checked.shaped.forEach(function(item) {
    const stored = existing[item.id];
    if (stored !== undefined && stored.report_type !== item.report_type) errors.push('Row ' + item.line + ': invalid_report_type (report_type).');
  });
  // A name must also be free among the stored reports this file does not change.
  Object.keys(existing).forEach(function(id) {
    const stored = existing[id];
    if (incoming[id] !== undefined || stored.report_type !== 'user_defined' || stored.record_status === 'deleted') return;
    checked.shaped.forEach(function(item) {
      if (item.report_type === 'user_defined' && item.record_status !== 'deleted' && item.values.report_name.toLowerCase() === stored.report_name.toLowerCase())
        errors.push('Row ' + item.line + ': duplicate_report_name (report_name).');
    });
  });
  if (errors.length > 0) {
    console.log('importReportsCsv: rows=' + parsed.rows.length + ' error=invalid_csv_rows count=' + errors.length);
    return csvRowErrors(errors);
  }

  const sheet = _rptSheet();
  const now = new Date().toISOString();
  const results = [];
  let created = 0, updated = 0, skipped = 0;
  checked.shaped.forEach(function(item) {
    const stored = existing[item.id];
    const status = item.record_status !== '' ? item.record_status : (stored === undefined ? 'active' : stored.record_status);
    const next = Object.assign({}, stored === undefined ? {} : stored, item.values, {
      id: item.id, report_type: item.report_type, predefined_key: item.predefined_key, record_status: status,
    });
    if (stored !== undefined) {
      const unchanged = ['report_type', 'predefined_key', 'record_status'].concat(getReportDefinitionColumns()).every(function(column) {
        return _rptText(stored[column]) === _rptCellText(column, next[column]);
      });
      if (unchanged) { skipped++; results.push({ key: item.id, line: item.line, ok: true, action: 'unchanged' }); return; }
      _rptQueued(next, now);
      sheet.getRange(stored._row, 1, 1, getReportSheetColumns().length).setValues([_rptCells(next)]);
      if (status === 'deleted' && stored.record_status !== 'deleted') dashboardLayoutRemoveReport(item.id);
      updated++;
      results.push({ key: item.id, line: item.line, ok: true, action: 'updated' });
      return;
    }
    Object.assign(next, { created_at: now, updated_at: now, sync_status: SYNC_STATUS_CREATE_PENDING, sync_date: '', sync_notes: '' });
    sheet.appendRow(_rptCells(next));
    created++;
    results.push({ key: item.id, line: item.line, ok: true, action: 'created' });
  });
  console.log('importReportsCsv: created=' + created + ' updated=' + updated + ' unchanged=' + skipped);
  return { ok: true, created: created, updated: updated, skipped: skipped, failed: 0, results: results, rows: parsed.rows.length };
}

function importDashboardLayoutCsv(body) {
  const parsed = parseCsvImport(body);
  if (!parsed.ok) return parsed;
  const missing = DASHBOARD_IMPORT_REQUIRED_HEADERS.filter(function(header) { return parsed.headers.indexOf(header) === -1; });
  if (missing.length > 0) return { ok: false, error: 'invalid_csv_headers', errors: ['Missing required headers: ' + missing.join(', ') + '.'] };
  const slots = getDashboardSlots();
  const errors = [], chosen = {};
  parsed.rows.forEach(function(row) {
    const slot = _rptText(row.slot), id = _rptText(row.report_id).toLowerCase();
    if (slots.indexOf(slot) === -1) { errors.push(_rptImportError(row, 'invalid_dashboard_slot', 'slot')); return; }
    if (chosen[slot] !== undefined) { errors.push(_rptImportError(row, 'slot repeats', 'slot')); return; }
    if (id !== '' && !isAccountUuid(id)) { errors.push(_rptImportError(row, 'invalid_id', 'report_id')); return; }
    chosen[slot] = id;
  });
  const absent = slots.filter(function(slot) { return chosen[slot] === undefined; });
  if (errors.length === 0 && absent.length > 0) errors.push('Missing slots: ' + absent.join(', ') + '.');
  if (errors.length > 0) return csvRowErrors(errors);
  if (isDryRun(body)) return { ok: true, dry_run: true, rows: parsed.rows.length };
  const current = readDashboardLayout();
  if (current.is_default === false && slots.every(function(slot) { return current.slots[slot] === chosen[slot]; })) {
    console.log('importDashboardLayoutCsv: unchanged=' + slots.length);
    return { ok: true, created: 0, updated: 0, skipped: slots.length, failed: 0, rows: parsed.rows.length };
  }
  const saved = updateDashboardLayout({ slots: chosen });
  if (saved.ok === false) return saved;
  // The first save of a layout creates its 8 rows; later saves update them.
  const created = current.is_default ? slots.length : 0;
  console.log('importDashboardLayoutCsv: slots=' + slots.length);
  return { ok: true, created: created, updated: slots.length - created, skipped: 0, failed: 0, rows: parsed.rows.length };
}
