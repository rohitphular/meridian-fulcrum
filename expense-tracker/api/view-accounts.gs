// =============================================================================
// FULCRUM FORGE — Accounts view: list_accounts_view, get_account_form_options,
// export_accounts
//
// Ready-to-render view models for the Accounts tab (dumb-UI phase 2–3):
// - list_accounts_view: server filter / sort / search / paging, rows with native
//   and quote balances, display signs, subtype labels, detail sheet, allowed
//   actions and editable fields; group totals over the whole filtered set; the
//   net-worth cards over ALL non-deleted accounts, independent of the filters;
//   facets (types, subtypes, currencies, statuses). Balances and the cards are
//   what the analytics job published (dataset-account-balances and
//   dataset-accounts-summary, report-store.gs), converted to the quote currency;
//   an account added since the last publish shows no balance yet.
// - get_account_form_options: add / edit / import form choices, plus the
//   editable fields of one account when `id` is given.
// - export_accounts: every account row (all statuses, filters ignored) in the
//   account_master import columns, so the file restores through Import.
// Actions are registered through viewAccountsRegister (get-registry.gs hook).
// Globals in this file use the vwAcc / _vwAcc prefix.
// =============================================================================

const _VWACC_STATUSES = ['active', 'inactive', 'deleted', 'locked'];
const _VWACC_EDIT_STATUSES = ['active', 'inactive', 'locked'];
// Fields update_account accepts (account-core.gs updateAccount writeField calls).
const _VWACC_EDIT_FIELDS = ['account_name', 'description', 'sub_type', 'account_closing_date_local', 'record_status'];
// Shown on the edit form but fixed after creation (preserveAccountImmutableFields).
const _VWACC_FIXED_FIELDS = ['legal_entity_name', 'type', 'account_currency_local', 'local_timezone',
  'account_opening_date_local', 'tracking_start_date_local', 'opening_value_local'];
const _VWACC_ADD_FIELDS = ['account_name', 'legal_entity_name', 'description', 'type', 'sub_type',
  'account_opening_date_local', 'tracking_start_date_local', 'opening_value_local', 'account_currency_local'];
const _VWACC_SORTS = ['sheet', 'account_name', 'sub_type', 'currency', 'balance', 'record_status'];
const _VWACC_SORT_LABELS = { sheet: 'Sheet order', account_name: 'Name', sub_type: 'Sub-type', currency: 'Currency', balance: 'Balance', record_status: 'Status' };
const _VWACC_MAX_PAGE_SIZE = 500;
// Import file types: account_master first, then the detail tabs (IMPORT_REGISTRY).
const _VWACC_IMPORT_LABELS = {
  account_master: 'Accounts (master)',
  account_deposit: 'Deposit',
  account_liability_credit_card: 'Credit card',
  account_liability_mortgage: 'Mortgage',
  account_liability_personal_loan: 'Personal loan',
  account_investment_property: 'Property',
  account_investment_stocks: 'Stock holdings',
};
const _VWACC_LIQUID_DETAIL_SHEET = 'account_deposit';
// account_master export / import columns (was app/core/utils.js ACC_COLS).
const _VWACC_EXPORT_COLUMNS = ['id', 'account_name', 'legal_entity_name', 'type', 'sub_type', 'account_currency_local', 'local_timezone',
  'account_opening_date_local', 'account_closing_date_local', 'tracking_start_date_local', 'opening_value_local', 'description', 'record_status'];

function viewAccountsRegister(actions) {
  actions.list_accounts_view = { handler: function(ctx) { return listAccountsView(ctx); }, cache: 'published', ttl: 600 };
  actions.get_account_form_options = { handler: function(ctx) { return getAccountFormOptions(ctx); }, cache: true, ttl: 600 };
  // Exports can exceed the cache payload limit; always computed.
  actions.export_accounts = { handler: function(ctx) { return vwAccExport(ctx); }, cache: false };
}

function _vwAccText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _vwAccTitle(value) {
  const text = _vwAccText(value);
  return text === '' ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

function _vwAccOptions(values, labels) {
  return values.map(function(value) {
    return { value: value, label: labels !== undefined && labels !== null && labels[value] !== undefined ? labels[value] : _vwAccTitle(value) };
  });
}

// ── Catalog (one account_types read per request via vmLoad) ───────────────────

// Mirrors getAccountSchemaForClient / getAvailableAccountTypes from the shared
// listAccountTypes() rows: available = active + locked unless the catalog still
// needs migration (legacy header without detail_sheet, or underscore keys).
function _vwAccCatalog() {
  const rows = vmLoad('account_types');
  const legacy = rows.some(function(row) { return !Object.prototype.hasOwnProperty.call(row, 'detail_sheet'); });
  const requiresMigration = legacy || rows.some(function(row) {
    return _vwAccText(row.account_type_key).indexOf('_') !== -1 || _vwAccText(row.account_subtype_key).indexOf('_') !== -1;
  });
  const typeLabels = Object.create(null);
  const subtypeLabels = Object.create(null);
  const detailBySubtype = Object.create(null);
  const familyOrder = [];
  rows.forEach(function(row) {
    const type = _vwAccText(row.account_type_key);
    const subtype = _vwAccText(row.account_subtype_key);
    if (familyOrder.indexOf(type) === -1) familyOrder.push(type);
    typeLabels[type] = row.account_type_label;
    subtypeLabels[subtype] = row.account_subtype_label;
    detailBySubtype[subtype] = _vwAccText(row.detail_sheet);
  });
  const available = requiresMigration ? [] : rows.filter(function(row) { return row.record_status === 'active' || row.record_status === 'locked'; });
  const subtypesByType = Object.create(null);
  const types = [];
  available.forEach(function(row) {
    const type = _vwAccText(row.account_type_key);
    if (subtypesByType[type] === undefined) {
      subtypesByType[type] = [];
      types.push({ value: type, label: typeLabels[type] });
    }
    subtypesByType[type].push(_vwAccText(row.account_subtype_key));
  });
  return {
    requires_migration: requiresMigration, types: types, subtypes_by_type: subtypesByType,
    type_labels: typeLabels, subtype_labels: subtypeLabels, detail_by_subtype: detailBySubtype, family_order: familyOrder,
  };
}

function _vwAccTypeLabel(type, catalog) {
  return catalog.type_labels[type] !== undefined ? catalog.type_labels[type] : _vwAccTitle(type);
}

function _vwAccSubtypeLabel(subtype, catalog) {
  if (subtype === '') return '—';
  return catalog.subtype_labels[subtype] !== undefined ? catalog.subtype_labels[subtype] : subtype;
}

function _vwAccSubtypeOptions(catalog) {
  const out = {};
  Object.keys(catalog.subtypes_by_type).forEach(function(type) {
    out[type] = catalog.subtypes_by_type[type].map(function(subtype) { return { value: subtype, label: _vwAccSubtypeLabel(subtype, catalog) }; });
  });
  return out;
}

function _vwAccDetailLabel(sheet) {
  return _VWACC_IMPORT_LABELS[sheet] !== undefined ? _VWACC_IMPORT_LABELS[sheet] : sheet;
}

// ── Rows ──────────────────────────────────────────────────────────────────────

// Liabilities are stored negative: 'owed' (shown as −magnitude, owed style) at
// or below zero, 'credit' above zero (an overpaid liability, shown positive).
// Other types: 'negative' / 'positive'. 'none' when the value is not a number.
function _vwAccDisplaySign(native, isLiability) {
  if (native === null || !Number.isFinite(native)) return 'none';
  if (isLiability) return native > 0 ? 'credit' : 'owed';
  return native < 0 ? 'negative' : 'positive';
}

function _vwAccAllowedActions(status) {
  if (status === 'locked') return ['view', 'transactions'];
  if (status === 'deleted') return ['view', 'transactions', 'restore'];
  return ['view', 'edit', 'transactions', 'delete'];
}

function _vwAccEditableFields(status) {
  return status === 'locked' || status === 'deleted' ? [] : _VWACC_EDIT_FIELDS.slice();
}

// published: { local, quote } from dataset-account-balances, or undefined.
function _vwAccRow(account, catalog, fx, published) {
  const type = _vwAccText(account.type);
  const subtype = _vwAccText(account.sub_type);
  const currency = _vwAccText(account.account_currency_local).toUpperCase();
  const status = _vwAccText(account.record_status);
  const isLiability = type === 'liability';
  const balance = {
    native: published === undefined || typeof published.local !== 'number' ? null : published.local,
    currency: currency, currency_symbol: fxSymbol(currency, fx.symbols),
    quote: published === undefined || typeof published.quote !== 'number' ? null : published.quote,
  };
  balance.display_sign = _vwAccDisplaySign(balance.native, isLiability);
  balance.is_foreign = currency !== fx.quote_currency;
  const opening = fxMoney(account.opening_value_local, currency, fx);
  opening.display_sign = _vwAccDisplaySign(opening.native, isLiability);
  const detailSheet = catalog.detail_by_subtype[subtype] !== undefined ? catalog.detail_by_subtype[subtype] : '';
  const editable = _vwAccEditableFields(status);
  return {
    id: _vwAccText(account.id), row_num: account._row, updated_at: _vwAccText(account.updated_at),
    account_name: _vwAccText(account.account_name), legal_entity_name: _vwAccText(account.legal_entity_name),
    description: _vwAccText(account.description),
    type: type, type_label: _vwAccTypeLabel(type, catalog), is_liability: isLiability,
    sub_type: subtype, sub_type_label: _vwAccSubtypeLabel(subtype, catalog),
    currency: currency, currency_symbol: balance.currency_symbol, local_timezone: _vwAccText(account.local_timezone),
    account_opening_date_local: _vwAccText(account.account_opening_date_local),
    account_closing_date_local: _vwAccText(account.account_closing_date_local),
    tracking_start_date_local: _vwAccText(account.tracking_start_date_local),
    balance: balance, opening: opening, display_sign: balance.display_sign,
    record_status: status, record_status_label: _vwAccTitle(status),
    sync_status: _vwAccText(account.sync_status), sync_notes: _vwAccText(account.sync_notes),
    detail_sheet: detailSheet, detail_sheet_label: detailSheet === '' ? '' : _vwAccDetailLabel(detailSheet),
    has_detail_sheet: detailSheet !== '', is_liquid: type === 'asset' && detailSheet === _VWACC_LIQUID_DETAIL_SHEET,
    allowed_actions: _vwAccAllowedActions(status),
    readonly: editable.length === 0,
    editable_fields: editable,
    readonly_fields: editable.length === 0 ? _VWACC_FIXED_FIELDS.concat(_VWACC_EDIT_FIELDS) : _VWACC_FIXED_FIELDS.slice(),
    statuses_for_edit: editable.length === 0 ? [] : _vwAccOptions(_VWACC_EDIT_STATUSES),
  };
}

// ── Params ────────────────────────────────────────────────────────────────────

function _vwAccAll(value) {
  const text = _vwAccText(value);
  return text === '' || text === 'all' ? 'all' : text;
}

// Returns { ok:true, filters, sort, dir, page, page_size } or a vmError.
// statuses: '' → all four; 'none' → no status (an explicit empty selection).
function _vwAccParams(params) {
  let statuses = _VWACC_STATUSES.slice();
  const rawStatuses = _vwAccText(params.statuses);
  if (rawStatuses === 'none') statuses = [];
  else if (rawStatuses !== '' && rawStatuses !== 'all') {
    statuses = [];
    const parts = rawStatuses.split(',').map(function(part) { return part.trim(); }).filter(function(part) { return part !== ''; });
    for (let i = 0; i < parts.length; i++) {
      if (_VWACC_STATUSES.indexOf(parts[i]) === -1)
        return vmError('invalid_statuses', 'statuses', 'Choose statuses from active, inactive, deleted and locked.');
      if (statuses.indexOf(parts[i]) === -1) statuses.push(parts[i]);
    }
    statuses = _VWACC_STATUSES.filter(function(status) { return statuses.indexOf(status) !== -1; });
  }
  const sort = _vwAccText(params.sort) === '' ? 'sheet' : _vwAccText(params.sort);
  if (_VWACC_SORTS.indexOf(sort) === -1) return vmError('invalid_sort', 'sort', 'Choose a sort column from the list.');
  const dir = _vwAccText(params.dir) === '' ? 'asc' : _vwAccText(params.dir);
  if (dir !== 'asc' && dir !== 'desc') return vmError('invalid_sort', 'dir', 'Sort direction must be asc or desc.');
  const paging = vwAccPaging(params, _VWACC_MAX_PAGE_SIZE);
  if (paging.ok !== true) return paging;
  const currency = _vwAccAll(params.currency);
  return {
    ok: true, sort: sort, dir: dir, page: paging.page, page_size: paging.page_size,
    filters: {
      type: _vwAccAll(params.type), sub_type: _vwAccAll(params.sub_type),
      currency: currency === 'all' ? 'all' : currency.toUpperCase(), search: _vwAccText(params.search), statuses: statuses,
    },
  };
}

// page (1-based, default 1) and page_size (default null = all rows, else 1..max).
// Shared by the list views in view-config-lists.gs.
function vwAccPaging(params, maxPageSize) {
  const pageText = _vwAccText(params.page);
  const sizeText = _vwAccText(params.page_size);
  const page = pageText === '' ? 1 : Number(pageText);
  if (!Number.isInteger(page) || page < 1) return vmError('invalid_page', 'page', 'Page must be a whole number from 1.');
  if (sizeText === '' || sizeText === 'all') return { ok: true, page: page, page_size: null };
  const size = Number(sizeText);
  if (!Number.isInteger(size) || size < 1 || size > maxPageSize)
    return vmError('invalid_page_size', 'page_size', 'Page size must be a whole number from 1 to ' + maxPageSize + '.');
  return { ok: true, page: page, page_size: size };
}

// Slices a sorted list: { rows, total, page (clamped), page_size, pages }.
function vwAccPage(rows, page, pageSize) {
  const total = rows.length;
  const size = pageSize === null ? Math.max(total, 1) : pageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  return {
    rows: rows.slice((current - 1) * size, current * size), total: total, page: current,
    page_size: pageSize === null ? total : pageSize, pages: pages,
  };
}

function _vwAccMatches(row, filters) {
  if (filters.type !== 'all' && row.type !== filters.type) return false;
  if (filters.sub_type !== 'all' && row.sub_type !== filters.sub_type) return false;
  if (filters.currency !== 'all' && row.currency !== filters.currency) return false;
  if (filters.search !== '') {
    const haystack = (row.account_name + ' ' + row.description).toLowerCase();
    if (haystack.indexOf(filters.search.toLowerCase()) === -1) return false;
  }
  return filters.statuses.indexOf(row.record_status) !== -1;
}

function _vwAccCompare(a, b, sort) {
  if (sort === 'balance') {
    const av = a.balance.quote, bv = b.balance.quote;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  }
  if (sort === 'sheet') return a.row_num - b.row_num;
  const key = sort === 'sub_type' ? 'sub_type_label' : sort;
  return String(a[key]).localeCompare(String(b[key]), 'en', { sensitivity: 'base' });
}

// Type groups in catalog family order, then unknown types by first appearance.
function _vwAccGroupOrder(rows, catalog) {
  const order = catalog.family_order.slice();
  rows.forEach(function(row) { if (order.indexOf(row.type) === -1) order.push(row.type); });
  return order;
}

// ── list_accounts_view ────────────────────────────────────────────────────────

// The published Accounts datasets: { summary: payload|null, balances: { id: { local, quote } },
// warnings } (payload money already in the quote currency).
function _vwAccPublished(ctx) {
  const meta = rsMeta();
  const summary = rsReadReport(ctx, meta, rptPredefinedByKey('dataset-accounts-summary').id, '');
  const balances = rsReadReport(ctx, meta, rptPredefinedByKey('dataset-account-balances').id, '');
  const byId = Object.create(null);
  if (balances.payload !== null && balances.payload.tables.length > 0) {
    balances.payload.tables[0].rows.forEach(function(row) {
      byId[_vwAccText(row.cells.account_id).toLowerCase()] = { local: row.cells.balance_local, quote: row.cells.balance };
    });
  }
  const warnings = [];
  summary.warnings.concat(balances.warnings).forEach(function(warning) {
    if (!warnings.some(function(seen) { return seen.code === warning.code; })) warnings.push(warning);
  });
  return { summary: summary.payload, balances: byId, warnings: warnings };
}

// Summary over ALL non-deleted accounts, whatever the filters (product decision):
// the published dataset-accounts-summary cards.
function _vwAccSummary(accounts, published) {
  const card = function(key) {
    const found = published.summary === null ? undefined : published.summary.stat_cards.find(function(item) { return item.key === key; });
    return found === undefined || typeof found.value !== 'number' ? null : found.value;
  };
  const missing = [];
  (published.summary === null ? [] : published.summary.warnings || []).forEach(function(warning) {
    if (warning.code === 'missing_rate') (warning.currencies || []).forEach(function(code) { if (missing.indexOf(code) === -1) missing.push(code); });
  });
  const tone = function(value) { return value !== null && value < 0 ? 'negative' : 'positive'; };
  const worth = card('net_worth'), liquid = card('liquid_cash');
  return {
    total_assets: card('total_assets'), total_liabilities: card('total_liabilities'),
    net_worth: worth, liquid_cash: liquid,
    missing_currencies: missing.sort(),
    account_count: accounts.filter(function(account) { return account.record_status !== 'deleted'; }).length,
    all_count: accounts.length,
    cards: [
      { key: 'total_assets', label: 'Total Assets', value: card('total_assets'), tone: 'positive' },
      { key: 'total_liabilities', label: 'Total Liabilities', value: card('total_liabilities'), tone: 'negative' },
      { key: 'net_worth', label: 'Net Worth', value: worth, tone: tone(worth) },
      { key: 'liquid_cash', label: 'Liquid Cash', value: liquid, tone: tone(liquid) },
    ],
  };
}

// Group total over every filtered, non-deleted row of the group (not just the
// page). Signed quote sum; liabilities are negative (owed). Missing rates are
// excluded and listed, never converted 1:1.
// quote is null when no row of the group has a published balance yet.
function _vwAccGroupTotal(rows, isLiability) {
  let total = 0, counted = 0;
  const missing = Object.create(null);
  rows.forEach(function(row) {
    if (row.record_status === 'deleted' || row.balance.native === null) return;
    if (row.balance.quote === null) { missing[row.currency === '' ? '(blank)' : row.currency] = true; return; }
    total += row.balance.quote;
    counted += 1;
  });
  const published = counted > 0 || Object.keys(missing).length > 0;
  return { quote: published ? total : null, display_sign: published ? _vwAccDisplaySign(total, isLiability) : 'none', missing_currencies: Object.keys(missing).sort() };
}

// GET list_accounts_view. Params: type, sub_type, currency, search, statuses
// (csv | 'none'), sort (sheet|account_name|sub_type|currency|balance|record_status),
// dir (asc|desc), page, page_size (omitted = all rows). See the file header.
function listAccountsView(ctx) {
  const parsed = _vwAccParams(ctx.params);
  if (parsed.ok !== true) return parsed;
  const fx = vmFx(ctx);
  const catalog = _vwAccCatalog();
  const published = _vwAccPublished(ctx);
  const rows = vmLoad('accounts_raw').map(function(account) { return _vwAccRow(account, catalog, fx, published.balances[_vwAccText(account.id).toLowerCase()]); });
  const filtered = rows.filter(function(row) { return _vwAccMatches(row, parsed.filters); });
  const order = _vwAccGroupOrder(rows, catalog);
  const sign = parsed.dir === 'desc' ? -1 : 1;
  const sorted = filtered.slice().sort(function(a, b) {
    const group = order.indexOf(a.type) - order.indexOf(b.type);
    if (group !== 0) return group;
    const primary = _vwAccCompare(a, b, parsed.sort);
    if (primary !== 0) return (parsed.sort === 'balance' && (a.balance.quote === null || b.balance.quote === null)) ? primary : sign * primary;
    return a.row_num - b.row_num;
  });
  const paged = vwAccPage(sorted, parsed.page, parsed.page_size);
  const groups = [];
  order.forEach(function(type) {
    const pageRows = paged.rows.filter(function(row) { return row.type === type; });
    if (pageRows.length === 0) return;
    const isLiability = type === 'liability';
    const all = filtered.filter(function(row) { return row.type === type; });
    groups.push({
      type: type, label: _vwAccTypeLabel(type, catalog), is_liability: isLiability,
      count: all.length, total: _vwAccGroupTotal(all, isLiability), rows: pageRows,
    });
  });
  const currencies = Object.create(null);
  rows.forEach(function(row) { if (row.currency !== '') currencies[row.currency] = row.currency_symbol; });
  const filters = parsed.filters;
  const activeCount = [filters.type !== 'all', filters.sub_type !== 'all', filters.currency !== 'all', filters.search !== '',
    filters.statuses.length < _VWACC_STATUSES.length].filter(function(flag) { return flag; }).length;
  const data = {
    summary: _vwAccSummary(rows, published),
    groups: groups,
    total: paged.total, page: paged.page, page_size: paged.page_size, pages: paged.pages,
    sort: { col: parsed.sort, dir: parsed.dir },
    filters: filters, active_filter_count: activeCount,
    facets: {
      types: catalog.types.map(function(type) { return { value: type.value, label: type.label }; }),
      sub_types_by_type: _vwAccSubtypeOptions(catalog),
      currencies: Object.keys(currencies).sort().map(function(code) { return { value: code, label: code, symbol: currencies[code] }; }),
      statuses: _vwAccOptions(_VWACC_STATUSES),
      sorts: _VWACC_SORTS.map(function(key) { return { value: key, label: _VWACC_SORT_LABELS[key] }; }),
    },
  };
  return rsEnvelope(ctx, rsMeta(), data, published.warnings);
}

// ── get_account_form_options ──────────────────────────────────────────────────

// GET get_account_form_options (optional id). data:
// { types, sub_types_by_type, currencies, statuses_for_edit, import_file_types,
//   detail_sheets, fields:{add, edit, fixed}, requires_migration, account|null }
function getAccountFormOptions(ctx) {
  const fx = vmFx(ctx);
  const catalog = _vwAccCatalog();
  const id = _vwAccText(ctx.params.id).toLowerCase();
  let account = null;
  if (id !== '') {
    const match = vmLoad('accounts_raw').filter(function(row) { return _vwAccText(row.id).toLowerCase() === id; });
    if (match.length !== 1) return vmError('unknown_account_id', 'id', 'This account could not be found. Refresh and try again.');
    const row = match[0];
    const status = _vwAccText(row.record_status);
    const editable = _vwAccEditableFields(status);
    const type = _vwAccText(row.type);
    account = {
      id: _vwAccText(row.id), row_num: row._row, type: type, sub_type: _vwAccText(row.sub_type), record_status: status,
      allowed_actions: _vwAccAllowedActions(status), editable_fields: editable,
      readonly_fields: editable.length === 0 ? _VWACC_FIXED_FIELDS.concat(_VWACC_EDIT_FIELDS) : _VWACC_FIXED_FIELDS.slice(),
      statuses_for_edit: editable.length === 0 ? [] : _vwAccOptions(_VWACC_EDIT_STATUSES),
      sub_types: (catalog.subtypes_by_type[type] || []).map(function(subtype) { return { value: subtype, label: _vwAccSubtypeLabel(subtype, catalog) }; }),
    };
  }
  const detailSheets = getAccountTypeDetailSheets();
  const data = {
    types: catalog.types.map(function(type) { return { value: type.value, label: type.label }; }),
    sub_types_by_type: _vwAccSubtypeOptions(catalog),
    currencies: fx.rates.map(function(rate) {
      const code = _vwAccText(rate.currency).toUpperCase();
      return { value: code, label: code, symbol: fxSymbol(code, fx.symbols) };
    }),
    statuses_for_edit: _vwAccOptions(_VWACC_EDIT_STATUSES),
    import_file_types: ['account_master'].concat(detailSheets).map(function(sheet) { return { value: sheet, label: _vwAccDetailLabel(sheet) }; }),
    detail_sheets: detailSheets.map(function(sheet) { return { value: sheet, label: _vwAccDetailLabel(sheet) }; }),
    fields: { add: _VWACC_ADD_FIELDS.slice(), edit: _VWACC_EDIT_FIELDS.slice(), fixed: _VWACC_FIXED_FIELDS.slice() },
    requires_migration: catalog.requires_migration,
    account: account,
  };
  return vmEnvelope(ctx, data, []);
}

// ── export_accounts ───────────────────────────────────────────────────────────

// GET export_accounts. data: { filename:'account_master', columns, rows, count }.
// Every account in Sheet order, all statuses, stored values only (no computed
// balances), so the download re-imports as-is through import_account_data.
function vwAccExport(ctx) {
  const rows = vmLoad('accounts_raw').map(function(account) {
    const row = {};
    _VWACC_EXPORT_COLUMNS.forEach(function(column) { row[column] = account[column] === undefined ? '' : account[column]; });
    return row;
  });
  console.log('vwAccExport: rows=' + rows.length);
  return vmEnvelope(ctx, { filename: 'account_master', columns: _VWACC_EXPORT_COLUMNS.slice(), rows: rows, count: rows.length }, []);
}
