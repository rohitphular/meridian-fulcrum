// =============================================================================
// FULCRUM FORGE — Dashboard Layout: the Home tiles and panels
//
// dashboard_layout holds 8 rows: tile_1…tile_4 (single-number reports) and
// panel_1…panel_4 (chart reports), each with a report_master id or blank.
// Display configuration only: no sync cells, nothing is computed from it.
// Until the first save the default layout from the contract applies, and a
// read never writes (a missing or incomplete tab reads as the default).
// Globals in this file use the dl / _dl prefix.
// =============================================================================

function _dlDefaultSlots() {
  const slots = {};
  const layout = REPORT_PREDEFINED.default_layout;
  getDashboardSlots().forEach(function(slot) {
    const area = rptSlotArea(slot);
    const keys = area === 'tile' ? layout.tiles : layout.panels;
    const report = rptPredefinedByKey(keys[Number(slot.split('_')[1]) - 1]);
    slots[slot] = report === null ? '' : report.id;
  });
  return slots;
}

// { slots: { tile_1: id|'' … }, updated_at, is_default }
function readDashboardLayout() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DASHBOARD_LAYOUT_SHEET);
  const fallback = { slots: _dlDefaultSlots(), updated_at: '', is_default: true };
  if (sheet === null) return fallback;
  const columns = getDashboardLayoutColumns();
  const values = sheet.getDataRange().getValues();
  if (values.length === 0 || columns.some(function(column, index) { return values[0][index] !== column; })) return fallback;
  const slots = {};
  let updatedAt = '';
  values.slice(1).forEach(function(row) {
    const slot = _rptText(row[0]);
    if (getDashboardSlots().indexOf(slot) === -1) return;
    slots[slot] = _rptText(row[1]).toLowerCase();
    const stamp = _rptCellText('updated_at', row[2]);
    if (stamp > updatedAt) updatedAt = stamp;
  });
  if (getDashboardSlots().some(function(slot) { return slots[slot] === undefined; })) return fallback;
  return { slots: slots, updated_at: updatedAt, is_default: false };
}

// What a slot can hold: tile ← single-number reports, panel ← chart reports.
// Pre-built reports come from the contract (whether or not their rows are
// seeded yet); user reports from report_master.
function dlReportCatalog() {
  const byId = {};
  REPORT_PREDEFINED.reports.forEach(function(report) {
    if (report.home_slot === null) return;
    byId[report.id] = { id: report.id, title: report.title, home_slot: report.home_slot, report_type: 'predefined', record_status: 'locked' };
  });
  listReportRows().forEach(function(row) {
    if (row.report_type === 'predefined') {
      if (byId[row.id] !== undefined) byId[row.id].record_status = row.record_status;
      return;
    }
    byId[row.id] = {
      id: row.id, title: row.report_name, report_type: 'user_defined', record_status: row.record_status,
      home_slot: row.chart_kind === '' ? null : (REPORT_DEFINITION.home.tile_kinds.indexOf(row.chart_kind) !== -1 ? 'tile' : 'panel'),
    };
  });
  return byId;
}

function _dlAvailable(entry) {
  return entry !== undefined && entry.record_status !== 'deleted' && entry.record_status !== 'inactive';
}

// body: { slots: { tile_1: id|'', … panel_4: id|'' } } — all 8 slots at once.
function updateDashboardLayout(body) {
  const input = body === undefined || body === null ? null : body.slots;
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_dashboard_layout' };
  const slots = getDashboardSlots();
  const unknown = Object.keys(input).find(function(slot) { return slots.indexOf(slot) === -1; });
  if (unknown !== undefined) return { ok: false, error: 'invalid_dashboard_slot', field: unknown };
  const missing = slots.find(function(slot) { return !Object.prototype.hasOwnProperty.call(input, slot); });
  if (missing !== undefined) return { ok: false, error: 'invalid_dashboard_layout', field: missing };
  const catalog = dlReportCatalog();
  const chosen = {};
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    const id = _rptText(input[slot]).toLowerCase();
    if (id === '') continue;
    const entry = catalog[id];
    if (entry === undefined) return { ok: false, error: 'report_not_found', field: slot };
    if (!_dlAvailable(entry)) return { ok: false, error: 'report_deleted', field: slot };
    if (entry.home_slot !== rptSlotArea(slot)) return { ok: false, error: 'report_not_allowed_in_slot', field: slot };
    if (chosen[id] === true) return { ok: false, error: 'duplicate_dashboard_report', field: slot };
    chosen[id] = true;
  }
  const now = new Date().toISOString();
  const rows = slots.map(function(slot) { return [slot, _rptText(input[slot]).toLowerCase(), now]; });
  const sheet = getOrCreateSheet(DASHBOARD_LAYOUT_SHEET, getDashboardLayoutColumns());
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  const extra = sheet.getLastRow() - (rows.length + 1);
  if (extra > 0) sheet.getRange(rows.length + 2, 1, extra, rows[0].length).setValues(Array.from({ length: extra }, function() { return ['', '', '']; }));
  console.log('updateDashboardLayout: slots=' + rows.length + ' filled=' + Object.keys(chosen).length);
  return { ok: true, updated_at: now };
}

// Empties every slot that shows the report (on delete). Returns how many.
function dashboardLayoutRemoveReport(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DASHBOARD_LAYOUT_SHEET);
  if (sheet === null) return 0;
  const values = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  let cleared = 0;
  values.forEach(function(row, index) {
    if (index === 0 || _rptText(row[1]).toLowerCase() !== id) return;
    sheet.getRange(index + 1, 2, 1, 2).setValues([['', now]]);
    cleared++;
  });
  return cleared;
}
