// =============================================================================
// FULCRUM FORGE — Report views: list_reports_view, get_dashboard_layout
//
// Ready-to-render configuration for the Reports section and the Home layout
// editor: builder options from the contract, the pre-built catalogue, the
// user's reports with their status and allowed actions, and what each Home
// slot can hold. Nothing here computes report numbers (the analytics job does).
// Not cached: statuses come from report_status, which the job writes through
// the Sheets API without bumping data_version.
// Globals in this file use the vwRpt / _vwRpt prefix.
// =============================================================================

const _VWRPT_STATUS_LABELS = { queued: 'Queued', invalid: 'Invalid', ready: 'Ready', failed: 'Failed' };

function viewReportsRegister(actions) {
  actions.list_reports_view = { handler: function(ctx) { return listReportsView(ctx); }, cache: false };
  actions.get_dashboard_layout = { handler: function(ctx) { return getDashboardLayoutView(ctx); }, cache: false };
  // Backups for the CSV round trip (same shape as export_account_types).
  actions.export_reports = { handler: function(ctx) { return vwRptExportReports(ctx); }, cache: false };
  actions.export_dashboard_layout = { handler: function(ctx) { return vwRptExportLayout(ctx); }, cache: false };
}

// report_status is job-owned: read only if it exists (never getOrCreateSheet).
function _vwRptStatusIndex() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_STATUS_SHEET);
  const index = {};
  if (sheet === null) return index;
  sheetToObjects(sheet).forEach(function(row) {
    const id = _rptText(row.report_id).toLowerCase();
    if (id === '') return;
    index[id] = {
      status: _rptText(row.status), error_code: _rptText(row.error_code),
      definition_updated_at: _rptCellText('updated_at', row.definition_updated_at), published_at: _rptCellText('updated_at', row.published_at),
    };
  });
  return index;
}

// queued (waiting for the next run) | invalid (rejected by the sync, reason in
// sync_notes) | ready | failed (the job could not compute it). A user report's
// result counts only when it belongs to the definition as last saved.
function vwRptStatus(row, statusIndex) {
  const result = statusIndex[row.id];
  let status = 'queued', reason = '', publishedAt = '';
  if (row.report_type === 'user_defined' && (row.sync_status === SYNC_STATUS_CREATE_FAILED || row.sync_status === SYNC_STATUS_UPDATE_FAILED)) {
    status = 'invalid';
    reason = row.sync_notes;
  } else if (result !== undefined && (result.status === 'ready' || result.status === 'failed')
      && (row.report_type === 'predefined' || (row.sync_status === SYNC_STATUS_IN_SYNC && result.definition_updated_at === row.updated_at))) {
    status = result.status;
    reason = result.error_code;
    publishedAt = result.published_at;
  }
  return { status: status, status_label: _VWRPT_STATUS_LABELS[status], status_reason: reason, published_at: publishedAt };
}

function _vwRptLabel(list, key) {
  const item = rptChoice(list, key);
  return item === null ? key : item.label;
}

// "Spending · by month · per category and tag · last 6 months · vs previous period"
function vwRptSummary(row) {
  const def = REPORT_DEFINITION;
  const parts = [_vwRptLabel(def.measures, row.measure)];
  if (row.time_grain !== '' && row.time_grain !== 'none') parts.push('by ' + _vwRptLabel(def.time_grains, row.time_grain).toLowerCase());
  const groups = [row.group_by_1, row.group_by_2].filter(function(key) { return key !== ''; })
    .map(function(key) { return _vwRptLabel(def.group_by, key).toLowerCase(); });
  if (groups.length > 0) parts.push('per ' + groups.join(' and '));
  parts.push(row.period_preset === 'fixed' ? row.period_from + ' to ' + row.period_to : _vwRptLabel(def.period_presets, row.period_preset).toLowerCase());
  if (row.compare_mode !== '' && row.compare_mode !== 'none') parts.push('vs ' + _vwRptLabel(def.compare_modes, row.compare_mode).toLowerCase());
  const filters = def.filters.filter(function(filter) { return _rptText(row[filter.column]) !== ''; }).length;
  if (filters > 0) parts.push(filters + (filters === 1 ? ' filter' : ' filters'));
  return parts.join(' · ');
}

function _vwRptBuilderSchema() {
  const def = REPORT_DEFINITION;
  return {
    contract_version: def.contract_version, name: def.name, description: def.description,
    measures: def.measures, period_presets: def.period_presets, period_rules: def.period_rules,
    compare_modes: def.compare_modes, compare_rules: def.compare_rules, time_grains: def.time_grains,
    group_by: def.group_by, group_by_rules: def.group_by_rules, filters: def.filters, filter_rules: def.filter_rules,
    chart_kinds: def.chart_kinds, limits: def.limits, time_grain_days: def.time_grain_days, home: def.home,
  };
}

// Values the filter pickers offer: non-deleted accounts and categories, and
// the currencies those accounts use.
function _vwRptFilterOptions() {
  const accounts = sheetToObjects(getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns()))
    .filter(function(account) { return _rptText(account.id) !== '' && _rptText(account.record_status) !== 'deleted'; });
  const currencies = {};
  accounts.forEach(function(account) {
    const code = _rptText(account.account_currency_local).toUpperCase();
    if (code !== '') currencies[code] = true;
  });
  const categories = [], seenMajor = {};
  listCategories().forEach(function(category) {
    if (_rptText(category.record_status) === 'deleted') return;
    const major = _rptText(category.major_category_key), minor = _rptText(category.minor_category_key);
    if (major === '') return;
    if (seenMajor[major] !== true) {
      seenMajor[major] = true;
      categories.push({ value: major, label: _rptText(category.major_category_label) || major });
    }
    if (minor !== '') categories.push({ value: major + '|' + minor, label: (_rptText(category.major_category_label) || major) + ' › ' + (_rptText(category.minor_category_label) || minor) });
  });
  const byLabel = function(a, b) { return a.label.localeCompare(b.label); };
  return {
    accounts: accounts.map(function(account) { return { value: _rptText(account.id).toLowerCase(), label: _rptText(account.account_name) }; }).sort(byLabel),
    categories: categories.sort(byLabel),
    currencies: Object.keys(currencies).sort().map(function(code) { return { value: code, label: code }; }),
    tx_types: [{ value: 'money-in', label: 'Money in' }, { value: 'money-out', label: 'Money out' }],
  };
}

function _vwRptHomeSlot(chartKind) {
  if (chartKind === '') return null;
  return REPORT_DEFINITION.home.tile_kinds.indexOf(chartKind) !== -1 ? 'tile' : 'panel';
}

// params: include_deleted ('true' also lists deleted reports, for restore).
function listReportsView(ctx) {
  const includeDeleted = _rptText(ctx.params.include_deleted);
  if (includeDeleted !== '' && includeDeleted !== 'true' && includeDeleted !== 'false') return vmError('invalid_filter', 'include_deleted');
  const statusIndex = _vwRptStatusIndex();
  const rows = listReportRows();
  const predefinedRows = {};
  rows.forEach(function(row) { if (row.report_type === 'predefined') predefinedRows[row.id] = row; });

  const predefined = REPORT_PREDEFINED.groups.map(function(group) {
    const items = REPORT_PREDEFINED.reports.filter(function(report) { return report.group === group && report.kind !== 'dataset'; }).map(function(report) {
      const stored = predefinedRows[report.id];
      const row = { id: report.id, report_type: 'predefined', updated_at: stored === undefined ? '' : stored.updated_at };
      return Object.assign({
        id: report.id, key: report.key, title: report.title, description: report.description, kind: report.kind,
        home_slot: report.home_slot, default_period: report.default_period,
        periods: report.periods.map(function(key) { const preset = rptChoice(REPORT_DEFINITION.period_presets, key); return { value: key, label: preset === null ? key : preset.label }; }), allowed_actions: report.kind === 'number' ? ['add_to_home'] : ['open', 'customise', 'add_to_home'],
      }, vwRptStatus(row, statusIndex));
    });
    return { group: group, items: items };
  }).filter(function(group) { return group.items.length > 0; });

  const mine = rows.filter(function(row) {
    return row.report_type === 'user_defined' && (includeDeleted === 'true' || row.record_status !== 'deleted');
  }).sort(function(a, b) { return a.report_name.localeCompare(b.report_name); }).map(function(row) {
    const definition = {};
    getReportDefinitionColumns().forEach(function(column) { definition[column] = row[column]; });
    const deleted = row.record_status === 'deleted';
    return Object.assign({
      id: row.id, row_num: row._row, updated_at: row.updated_at, record_status: row.record_status,
      report_name: row.report_name, report_description: row.report_description, definition: definition,
      summary: vwRptSummary(row), home_slot: _vwRptHomeSlot(row.chart_kind),
      allowed_actions: deleted ? ['restore'] : row.record_status === 'locked' ? ['open', 'duplicate', 'add_to_home'] : ['open', 'edit', 'duplicate', 'add_to_home', 'delete'],
    }, vwRptStatus(row, statusIndex));
  });

  return vmEnvelope(ctx, { schema: _vwRptBuilderSchema(), filter_options: _vwRptFilterOptions(), predefined: predefined, mine: mine });
}

function getDashboardLayoutView(ctx) {
  const layout = readDashboardLayout();
  const catalog = dlReportCatalog();
  const statusIndex = _vwRptStatusIndex();
  const rowsById = {};
  listReportRows().forEach(function(row) { rowsById[row.id] = row; });
  const describe = function(entry) {
    const row = rowsById[entry.id] || { id: entry.id, report_type: entry.report_type, updated_at: '', sync_status: '' };
    return Object.assign({ report_id: entry.id, title: entry.title, report_type: entry.report_type }, vwRptStatus(row, statusIndex));
  };
  const slots = getDashboardSlots().map(function(slot) {
    const id = layout.slots[slot];
    const entry = id === '' ? undefined : catalog[id];
    const base = { slot: slot, area: rptSlotArea(slot) };
    // A report deleted by hand in the Sheet shows as an empty slot.
    return entry === undefined || entry.record_status === 'deleted' ? Object.assign(base, { report_id: '' }) : Object.assign(base, describe(entry));
  });
  const options = { tile: [], panel: [] };
  const order = REPORT_PREDEFINED.reports.map(function(report) { return report.id; });
  Object.keys(catalog).map(function(id) { return catalog[id]; })
    .filter(function(entry) { return entry.home_slot !== null && entry.record_status !== 'deleted' && entry.record_status !== 'inactive'; })
    .sort(function(a, b) {
      const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      return a.title.localeCompare(b.title);
    })
    .forEach(function(entry) { options[entry.home_slot].push({ report_id: entry.id, title: entry.title, report_type: entry.report_type }); });
  return vmEnvelope(ctx, { is_default: layout.is_default, updated_at: layout.updated_at, slots: slots, options: options, default_slots: _dlDefaultSlots() });
}

// Every report_master row (pre-built, user-defined, deleted), CSV columns only.
function vwRptExportReports(ctx) {
  const columns = getReportCsvColumns();
  const rows = listReportRows().map(function(source) {
    const row = {};
    columns.forEach(function(column) { row[column] = source[column]; });
    return row;
  });
  console.log('vwRptExportReports: rows=' + rows.length);
  return vmEnvelope(ctx, { filename: REPORT_MASTER_SHEET, columns: columns, rows: rows, count: rows.length }, []);
}

// The 8 slots in order: the saved layout, or the default until one is saved.
function vwRptExportLayout(ctx) {
  const layout = readDashboardLayout();
  const rows = getDashboardSlots().map(function(slot) { return { slot: slot, report_id: layout.slots[slot] }; });
  return vmEnvelope(ctx, { filename: DASHBOARD_LAYOUT_SHEET, columns: getDashboardLayoutCsvColumns(), rows: rows, count: rows.length, is_default: layout.is_default }, []);
}
