// =============================================================================
// FULCRUM FORGE — Config list views: list_rates_view, list_account_types_view,
// export_account_types
//
// Ready-to-render lists for the Currencies and Configure tabs (dumb-UI phase 3):
// server search / filter / sort, display labels, and per-row allowed_actions /
// readonly flags (replacing configure.js _menuItems and its accounts scan).
// Actions are registered through viewConfigListsRegister (get-registry.gs hook).
// Globals in this file use the vwCfg / _vwCfg prefix.
// =============================================================================

const _VWCFG_BASE_CURRENCY = 'XAU';
const _VWCFG_RATE_SORTS = ['sheet', 'currency', 'rate', 'updated_at'];
const _VWCFG_TYPE_SORTS = ['type', 'subtype', 'status', 'sheet'];
const _VWCFG_TYPE_STATUSES = ['active', 'inactive', 'deleted', 'locked'];
// Account type fields the edit form may change (ACCOUNT_TYPE_SCHEMA editable).
const _VWCFG_TYPE_EDIT_FIELDS = ['account_type_label', 'account_subtype_label', 'description', 'detail_sheet', 'record_status'];
const _VWCFG_DETAIL_LABELS = {
  account_deposit: 'Deposit',
  account_liability_credit_card: 'Credit card',
  account_liability_mortgage: 'Mortgage',
  account_liability_personal_loan: 'Personal loan',
  account_investment_property: 'Property',
  account_investment_stocks: 'Stock holdings',
};

function viewConfigListsRegister(actions) {
  actions.list_rates_view = { handler: function(ctx) { return listRatesView(ctx); }, cache: true, ttl: 600 };
  actions.list_account_types_view = { handler: function(ctx) { return listAccountTypesView(ctx); }, cache: true, ttl: 600 };
  // Exports can exceed the cache payload limit; always computed.
  actions.export_account_types = { handler: function(ctx) { return vwCfgExportAccountTypes(ctx); }, cache: false };
}

// Legacy catalogs (no detail_sheet column, or underscore keys) must be
// upgraded by importing the updated CSV before they can be edited or restored.
function _vwCfgTypesRequireMigration(catalog) {
  const legacy = catalog.some(function(row) { return !Object.prototype.hasOwnProperty.call(row, 'detail_sheet'); });
  return legacy || catalog.some(function(row) {
    return _vwCfgText(row.account_type_key).indexOf('_') !== -1 || _vwCfgText(row.account_subtype_key).indexOf('_') !== -1;
  });
}

function _vwCfgText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _vwCfgTitle(value) {
  const text = _vwCfgText(value);
  return text === '' ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

function _vwCfgSortParams(params, sorts, fallback) {
  const sort = _vwCfgText(params.sort) === '' ? fallback : _vwCfgText(params.sort);
  if (sorts.indexOf(sort) === -1) return vmError('invalid_sort', 'sort', 'Choose a sort column from the list.');
  const dir = _vwCfgText(params.dir) === '' ? 'asc' : _vwCfgText(params.dir);
  if (dir !== 'asc' && dir !== 'desc') return vmError('invalid_sort', 'dir', 'Sort direction must be asc or desc.');
  return { ok: true, sort: sort, dir: dir };
}

function _vwCfgCompareText(a, b) {
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
}

// Display label for a rate: 2 decimals, up to 4 (as rates.js rendered it).
function _vwCfgRateLabel(rate) {
  if (!Number.isFinite(rate)) return '—';
  return rate.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// ── list_rates_view ───────────────────────────────────────────────────────────

// GET list_rates_view. Params: search (currency or symbol), sort
// (sheet|currency|rate|updated_at, default sheet order), dir. data:
// { rows:[{currency,symbol,rate,rate_label,updated_at,is_base,readonly,allowed_actions,
//          used_by_accounts,account_count}], total, total_all, sort, filters, base_currency }
function listRatesView(ctx) {
  const sorting = _vwCfgSortParams(ctx.params, _VWCFG_RATE_SORTS, 'sheet');
  if (sorting.ok !== true) return sorting;
  const search = _vwCfgText(ctx.params.search);
  // All account statuses count, as deleteRate (_countAccountsWithCurrency) does.
  const usedBy = Object.create(null);
  vmLoad('accounts_raw').forEach(function(account) {
    const code = _vwCfgText(account.account_currency_local).toUpperCase();
    if (code === '') return;
    if (usedBy[code] === undefined) usedBy[code] = [];
    usedBy[code].push(_vwCfgText(account.account_name));
  });
  const all = vmLoad('rates').map(function(rate, index) {
    const currency = _vwCfgText(rate.currency).toUpperCase();
    const value = Number(rate.rate);
    const isBase = currency === _VWCFG_BASE_CURRENCY;
    const names = usedBy[currency] === undefined ? [] : usedBy[currency].slice();
    return {
      currency: currency, symbol: rate.symbol === undefined || rate.symbol === null ? '' : String(rate.symbol),
      rate: Number.isFinite(value) ? value : null, rate_label: _vwCfgRateLabel(value),
      updated_at: _vwCfgText(rate.updated_at), is_base: isBase, readonly: isBase,
      allowed_actions: isBase ? [] : ['edit', 'delete'],
      used_by_accounts: names, account_count: names.length, _order: index,
    };
  });
  const query = search.toLowerCase();
  const rows = all.filter(function(row) {
    return query === '' || row.currency.toLowerCase().indexOf(query) !== -1 || row.symbol.toLowerCase().indexOf(query) !== -1;
  });
  const sign = sorting.dir === 'desc' ? -1 : 1;
  rows.sort(function(a, b) {
    let primary = 0;
    if (sorting.sort === 'currency') primary = _vwCfgCompareText(a.currency, b.currency);
    else if (sorting.sort === 'rate') primary = (a.rate === null ? Infinity : a.rate) - (b.rate === null ? Infinity : b.rate);
    else if (sorting.sort === 'updated_at') primary = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
    else primary = a._order - b._order;
    if (!Number.isFinite(primary)) primary = 0;
    return primary !== 0 ? sign * primary : a._order - b._order;
  });
  rows.forEach(function(row) { delete row._order; });
  return vmEnvelope(ctx, {
    rows: rows, total: rows.length, total_all: all.length,
    sort: { col: sorting.sort, dir: sorting.dir }, filters: { search: search },
    base_currency: _VWCFG_BASE_CURRENCY,
  }, []);
}

// ── list_account_types_view ───────────────────────────────────────────────────

function _vwCfgTypeActions(row, requiresMigration) {
  if (requiresMigration) return ['view'];
  if (row.record_status === 'deleted') return ['view', 'restore'];
  if (row.record_status === 'locked') return ['view', 'unlock'];
  return ['view', 'edit', 'delete'];
}

// GET list_account_types_view. Params: search (keys, labels, description),
// status (all | a record status), type (all | account_type_key), sort
// (type = type key then subtype label [default] | subtype | status | sheet), dir.
function listAccountTypesView(ctx) {
  const sorting = _vwCfgSortParams(ctx.params, _VWCFG_TYPE_SORTS, 'type');
  if (sorting.ok !== true) return sorting;
  const status = _vwCfgText(ctx.params.status) === '' ? 'all' : _vwCfgText(ctx.params.status);
  if (status !== 'all' && _VWCFG_TYPE_STATUSES.indexOf(status) === -1)
    return vmError('invalid_record_status', 'status', 'Choose a status from the list.');
  const type = _vwCfgText(ctx.params.type) === '' ? 'all' : _vwCfgText(ctx.params.type);
  const search = _vwCfgText(ctx.params.search);
  const catalog = vmLoad('account_types');
  const requiresMigration = _vwCfgTypesRequireMigration(catalog);
  // Accounts per type|subtype, every status, keys normalised as the
  // account_type_in_use rule does (_countAccountTypeReferences, accounts only).
  const counts = Object.create(null);
  vmLoad('accounts_raw').forEach(function(account) {
    const key = _accountTypeKey(account.type) + '|' + _accountTypeKey(account.sub_type);
    counts[key] = (counts[key] || 0) + 1;
  });
  const families = [];
  const seen = Object.create(null);
  catalog.forEach(function(row) {
    if (seen[row.account_type_key] === true) return;
    seen[row.account_type_key] = true;
    families.push({ value: row.account_type_key, label: row.account_type_label });
  });
  const query = search.toLowerCase();
  const rows = catalog.filter(function(row) {
    if (status !== 'all' && row.record_status !== status) return false;
    if (type !== 'all' && row.account_type_key !== type) return false;
    return [row.account_type_key, row.account_type_label, row.account_subtype_key, row.account_subtype_label, row.description]
      .some(function(value) { return _vwCfgText(value).toLowerCase().indexOf(query) !== -1; });
  }).map(function(row, index) {
    const accountCount = counts[_accountTypeKey(row.account_type_key) + '|' + _accountTypeKey(row.account_subtype_key)] || 0;
    const locked = row.record_status === 'locked';
    const readonly = locked ? _VWCFG_TYPE_EDIT_FIELDS.filter(function(key) { return key !== 'record_status'; }) : [];
    if (accountCount > 0 && readonly.indexOf('detail_sheet') === -1) readonly.push('detail_sheet');
    const detail = _vwCfgText(row.detail_sheet);
    return Object.assign({}, row, {
      type_label: row.account_type_label, subtype_label: row.account_subtype_label,
      record_status_label: _vwCfgTitle(row.record_status),
      detail_sheet_label: detail === '' ? 'None' : (_VWCFG_DETAIL_LABELS[detail] !== undefined ? _VWCFG_DETAIL_LABELS[detail] : detail),
      has_accounts: accountCount > 0, account_count: accountCount,
      readonly_fields: readonly,
      statuses_for_edit: _VWCFG_TYPE_STATUSES.filter(function(value) { return !locked || value !== 'deleted'; })
        .map(function(value) { return { value: value, label: _vwCfgTitle(value) }; }),
      allowed_actions: _vwCfgTypeActions(row, requiresMigration),
      _order: index,
    });
  });
  const sign = sorting.dir === 'desc' ? -1 : 1;
  rows.sort(function(a, b) {
    let primary = 0;
    if (sorting.sort === 'type') primary = _vwCfgCompareText(a.account_type_key, b.account_type_key) || _vwCfgCompareText(a.account_subtype_label, b.account_subtype_label);
    else if (sorting.sort === 'subtype') primary = _vwCfgCompareText(a.account_subtype_label, b.account_subtype_label);
    else if (sorting.sort === 'status') primary = _VWCFG_TYPE_STATUSES.indexOf(a.record_status) - _VWCFG_TYPE_STATUSES.indexOf(b.record_status);
    else primary = a.row_num - b.row_num;
    return primary !== 0 ? sign * primary : a._order - b._order;
  });
  rows.forEach(function(row) { delete row._order; delete row._row; });
  const activeCount = [search !== '', status !== 'all', type !== 'all'].filter(function(flag) { return flag; }).length;
  return vmEnvelope(ctx, {
    rows: rows, total: rows.length, total_all: catalog.length, requires_migration: requiresMigration,
    sort: { col: sorting.sort, dir: sorting.dir }, filters: { search: search, status: status, type: type },
    active_filter_count: activeCount,
    facets: {
      types: families,
      statuses: _VWCFG_TYPE_STATUSES.map(function(value) { return { value: value, label: _vwCfgTitle(value) }; }),
      sorts: _VWCFG_TYPE_SORTS.map(function(value) { return { value: value, label: { type: 'Type', subtype: 'Subtype', status: 'Status', sheet: 'Sheet order' }[value] }; }),
    },
  }, []);
}

// ── export_account_types ──────────────────────────────────────────────────────

// GET export_account_types. data: { filename:'account_types', columns, rows,
// count, requires_migration }. The whole catalog (every status, filters
// ignored) in the exact columns importAccountTypesCsv requires
// (getAccountTypeSheetColumns), existing UUIDs kept: a complete restore point.
// A legacy catalog still exports, as a reference copy (requires_migration).
function vwCfgExportAccountTypes(ctx) {
  const catalog = vmLoad('account_types');
  const columns = getAccountTypeSheetColumns();
  const rows = catalog.map(function(source) {
    const row = {};
    columns.forEach(function(column) { row[column] = source[column] === undefined ? '' : source[column]; });
    return row;
  });
  console.log('vwCfgExportAccountTypes: rows=' + rows.length + ' columns=' + columns.length);
  return vmEnvelope(ctx, { filename: 'account_types', columns: columns, rows: rows, count: rows.length,
    requires_migration: _vwCfgTypesRequireMigration(catalog) }, []);
}
