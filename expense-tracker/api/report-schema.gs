// =============================================================================
// FULCRUM FORGE — Report Schema: report_master / dashboard_layout columns
//
// Columns and allowed values come from the generated report-contract.gs
// (data-synchronization/analytics/contract). Read them through these
// functions at call time: GAS file load order is not guaranteed.
// Globals in this file use the rpt / _rpt prefix.
// =============================================================================

// Columns the app owns on every row; the rest describe the report.
const _RPT_SYSTEM_COLUMNS = ['id', 'report_type', 'predefined_key', 'record_status', 'created_at', 'updated_at', 'sync_status', 'sync_date', 'sync_notes'];

function getReportSheetColumns() {
  return REPORT_DEFINITION.columns.slice();
}

// report_master.csv: business columns and record_status only, like the other
// master CSVs (audit and sync columns are server-owned).
function getReportCsvColumns() {
  return REPORT_DEFINITION.csv_columns.slice();
}

function reportColIndex(key) {
  const index = REPORT_DEFINITION.columns.indexOf(key);
  if (index === -1) throw new Error('unknown_report_column: ' + key);
  return index;
}

// The columns a user defines (name, description, measure … chart_kind).
function getReportDefinitionColumns() {
  return REPORT_DEFINITION.columns.filter(function(column) { return _RPT_SYSTEM_COLUMNS.indexOf(column) === -1; });
}

function rptSheetTab(name) {
  const tab = REPORT_SHEET_TABS.tabs.find(function(candidate) { return candidate.name === name; });
  if (tab === undefined) throw new Error('unknown_report_tab: ' + name);
  return tab;
}

function getDashboardLayoutColumns() {
  return rptSheetTab(DASHBOARD_LAYOUT_SHEET).columns.slice();
}

function getDashboardLayoutCsvColumns() {
  return rptSheetTab(DASHBOARD_LAYOUT_SHEET).csv_columns.slice();
}

function getDashboardSlots() {
  return rptSheetTab(DASHBOARD_LAYOUT_SHEET).slots.slice();
}

// 'tile_1' → 'tile', 'panel_3' → 'panel'.
function rptSlotArea(slot) {
  return String(slot).split('_')[0];
}

function rptPredefinedById(id) {
  const key = String(id === undefined || id === null ? '' : id).trim().toLowerCase();
  return REPORT_PREDEFINED.reports.find(function(report) { return report.id === key; }) || null;
}

function rptPredefinedByKey(key) {
  return REPORT_PREDEFINED.reports.find(function(report) { return report.key === key; }) || null;
}

function rptChoice(list, value) {
  const key = value === undefined || value === null ? '' : String(value).trim();
  return list.find(function(item) { return item.key === key; }) || null;
}
