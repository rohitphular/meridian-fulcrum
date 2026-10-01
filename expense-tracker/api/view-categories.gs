// =============================================================================
// FULCRUM FORGE — Categories view: list view model + form options
//
// GET list_categories_view      → filtered / sorted / paged category rows with
//                                 type badge, account-type hint labels and
//                                 allowed_actions, plus filter facets.
// GET get_category_form_options → tx types, account-type hint groups for the
//                                 source/target checkboxes, status choices.
// Globals in this file use the vwCat / _vwCat prefix.
// =============================================================================

const _VWCAT_SORT_COLUMNS = ['row_num', 'tx_type_key', 'major_category_label', 'minor_category_label', 'record_status'];
const _VWCAT_TRISTATE = ['all', 'yes', 'no'];

function viewCategoriesRegister(actions) {
  actions.list_categories_view = { handler: function(ctx) { return vwCatListView(ctx); }, cache: true, ttl: 600 };
  actions.get_category_form_options = { handler: function(ctx) { return vwCatFormOptions(ctx); }, cache: true, ttl: 600 };
}

function _vwCatText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _vwCatTitle(value) {
  const text = _vwCatText(value);
  return text === '' ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

// Account-type hints grouped by account type family, from one account_types
// read. Mirrors getCategoryAccountTypeHints() (subtype keys, plus the broad
// "investment" key) grouped the way getAccountSchemaForClient() orders types.
// → { groups:[{type,label,hints:[{value,label}]}], labels:{key:label} }
function vwCatHintGroups(availableRows) {
  const hints = [];
  const byValue = Object.create(null);
  const addHint = function(value, label) {
    if (value === '' || byValue[value] !== undefined) return;
    byValue[value] = { value: value, label: label === '' ? value : label };
    hints.push(byValue[value]);
  };
  const types = [];
  const typeLabels = Object.create(null);
  const subtypes = Object.create(null);
  availableRows.forEach(function(row) {
    const type = _vwCatText(row.account_type_key), subtype = _vwCatText(row.account_subtype_key);
    addHint(subtype, _vwCatText(row.account_subtype_label));
    if (type === 'investment') addHint(type, _vwCatText(row.account_type_label));
    if (subtypes[type] === undefined) { subtypes[type] = []; types.push(type); }
    typeLabels[type] = _vwCatText(row.account_type_label) === '' ? type : _vwCatText(row.account_type_label);
    subtypes[type].push(subtype);
  });
  const groups = types.map(function(type) {
    return {
      type: type, label: typeLabels[type],
      hints: hints.filter(function(hint) { return hint.value === type || subtypes[type].indexOf(hint.value) !== -1; })
        .map(function(hint) { return { value: hint.value, label: hint.label }; }),
    };
  }).filter(function(group) { return group.hints.length > 0; });
  const labels = Object.create(null);
  hints.forEach(function(hint) { labels[hint.value] = hint.label; });
  return { groups: groups, labels: labels };
}

function _vwCatHintKeys(value) {
  return _vwCatText(value).split(',').map(function(item) { return _vwCatText(item).toLowerCase(); }).filter(function(item) { return item !== ''; });
}

// Row menu by record_status: locked → View / Transactions; deleted → View /
// Transactions / Restore; otherwise View / Edit / Transactions / Delete.
function vwCatAllowedActions(status) {
  if (status === 'locked') return ['view', 'transactions'];
  if (status === 'deleted') return ['view', 'transactions', 'restore'];
  return ['view', 'edit', 'transactions', 'delete'];
}


function _vwCatRow(cat, typeLabels, hintLabels) {
  const status = _vwCatText(cat.record_status);
  const type = _vwCatText(cat.tx_type_key);
  const source = _vwCatHintKeys(cat.source_account_types);
  const target = _vwCatHintKeys(cat.target_account_types);
  const label = function(key) { return hintLabels[key] !== undefined ? hintLabels[key] : key; };
  return Object.assign({}, cat, {
    row_num: cat._row,
    tx_type_label: typeLabels[type] !== undefined ? typeLabels[type] : type,
    type_badge: type === 'money-in' ? 'in' : 'out',
    source_account_type_labels: source.map(label),
    target_account_type_labels: target.map(label),
    allowed_actions: vwCatAllowedActions(status),
    readonly: status === 'locked' || status === 'deleted',
    transactions_filter: { major: [_vwCatText(cat.major_category_key)], minor: [_vwCatText(cat.minor_category_key)] },
  });
}

// ── Params ────────────────────────────────────────────────────────────────────

function _vwCatStatuses(value, allowed) {
  const text = _vwCatText(value);
  if (text === '') return { ok: true, value: allowed.slice(), all: true };
  if (text === 'none') return { ok: true, value: [], all: false };
  const list = text.split(',').map(_vwCatText).filter(function(item) { return item !== ''; });
  for (let i = 0; i < list.length; i++) {
    if (allowed.indexOf(list[i]) === -1) return { ok: false, error: vmError('invalid_filter', 'statuses', 'Choose statuses from the list.') };
  }
  return { ok: true, value: list, all: allowed.every(function(item) { return list.indexOf(item) !== -1; }) };
}

function _vwCatTristate(params, key) {
  const text = _vwCatText(params[key]) === '' ? 'all' : _vwCatText(params[key]);
  if (_VWCAT_TRISTATE.indexOf(text) === -1) return { ok: false, error: vmError('invalid_filter', key, 'Choose all, yes or no.') };
  return { ok: true, value: text };
}

function _vwCatPaging(params) {
  const sizeText = _vwCatText(params.page_size);
  let size = null;
  if (sizeText !== '' && sizeText !== 'all') {
    if (!/^\d+$/.test(sizeText) || Number(sizeText) < 1 || Number(sizeText) > 500)
      return { ok: false, error: vmError('invalid_page', 'page_size', 'Page size must be a whole number from 1 to 500, or all.') };
    size = Number(sizeText);
  }
  const pageText = _vwCatText(params.page);
  if (pageText !== '' && (!/^\d+$/.test(pageText) || Number(pageText) < 1))
    return { ok: false, error: vmError('invalid_page', 'page', 'Page must be a whole number from 1.') };
  return { ok: true, size: size, page: pageText === '' ? 1 : Number(pageText) };
}

function _vwCatCompare(col, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return function(a, b) {
    let result = 0;
    if (col === 'row_num') result = (a.row_num - b.row_num) * sign;
    else {
      const va = _vwCatText(a[col]).toLowerCase(), vb = _vwCatText(b[col]).toLowerCase();
      result = va < vb ? -sign : va > vb ? sign : 0;
    }
    return result !== 0 ? result : a.row_num - b.row_num;
  };
}

// Facets from active categories: majors (by key) and minors per major key.
function _vwCatFacets(categories, schema) {
  const majors = [];
  const majorSeen = Object.create(null);
  const minors = Object.create(null);
  categories.filter(function(row) { return _vwCatText(row.record_status) === 'active'; }).forEach(function(row) {
    const major = _vwCatText(row.major_category_key), minor = _vwCatText(row.minor_category_key);
    if (major === '') return;
    if (majorSeen[major] === undefined) {
      majorSeen[major] = true;
      majors.push({ key: major, label: _vwCatText(row.major_category_label) === '' ? major : _vwCatText(row.major_category_label) });
      minors[major] = [];
    }
    if (minor !== '' && !minors[major].some(function(item) { return item.key === minor; }))
      minors[major].push({ key: minor, label: _vwCatText(row.minor_category_label) === '' ? minor : _vwCatText(row.minor_category_label) });
  });
  const byLabel = function(a, b) { return a.label.localeCompare(b.label) || a.key.localeCompare(b.key); };
  majors.sort(byLabel);
  Object.keys(minors).forEach(function(key) { minors[key].sort(byLabel); });
  return {
    types: schema.types.map(function(type) { return { value: type.value, label: type.label }; }),
    majors: majors,
    minors_by_major: minors,
    statuses: schema.record_statuses.map(function(value) { return { value: value, label: _vwCatTitle(value) }; }),
    mandatory: [{ value: 'all', label: 'All' }, { value: 'yes', label: 'Required' }, { value: 'no', label: 'Optional' }],
    subscription_eligible: [{ value: 'all', label: 'All' }, { value: 'yes', label: 'Eligible' }, { value: 'no', label: 'Not eligible' }],
  };
}

// ── list_categories_view ──────────────────────────────────────────────────────

// Pure builder over listCategories() rows (booleans already coerced) and the
// available account_types rows (getAvailableAccountTypes()).
function vwCatBuildList(categories, accountTypeRows, params) {
  // Same types / statuses as getCategorySchemaForClient(), without its account_types read.
  const schema = { types: _vwCatSchemaTypes(), record_statuses: CATEGORY_SCHEMA.record_status.enum_values.slice() };
  const typeValues = schema.types.map(function(type) { return type.value; });
  const type = _vwCatText(params.type) === '' ? 'all' : _vwCatText(params.type);
  if (type !== 'all' && typeValues.indexOf(type) === -1) return { ok: false, error: vmError('invalid_filter', 'type', 'Choose a transaction type from the list.') };
  const major = _vwCatText(params.major) === '' ? 'all' : _vwCatText(params.major);
  const minor = _vwCatText(params.minor) === '' ? 'all' : _vwCatText(params.minor);
  const search = _vwCatText(params.search);
  const source = _vwCatTristate(params, 'source_mandatory');
  if (source.ok === false) return source;
  const target = _vwCatTristate(params, 'target_mandatory');
  if (target.ok === false) return target;
  const eligible = _vwCatTristate(params, 'subscription_eligible');
  if (eligible.ok === false) return eligible;
  const statuses = _vwCatStatuses(params.statuses, schema.record_statuses);
  if (statuses.ok === false) return statuses;
  const sortCol = _vwCatText(params.sort_col) === '' ? 'row_num' : _vwCatText(params.sort_col);
  if (_VWCAT_SORT_COLUMNS.indexOf(sortCol) === -1) return { ok: false, error: vmError('invalid_sort', 'sort_col', 'Choose a column to sort by from the table headings.') };
  const sortDir = _vwCatText(params.sort_dir) === '' ? 'asc' : _vwCatText(params.sort_dir);
  if (sortDir !== 'asc' && sortDir !== 'desc') return { ok: false, error: vmError('invalid_sort', 'sort_dir', 'Sort direction must be asc or desc.') };
  const paging = _vwCatPaging(params);
  if (paging.ok === false) return paging;

  const typeLabels = Object.create(null);
  schema.types.forEach(function(item) { typeLabels[item.value] = item.label; });
  const hintLabels = vwCatHintGroups(accountTypeRows).labels;
  const query = search.toLowerCase();
  const flag = function(value, wanted) { return wanted === 'all' || (value === true) === (wanted === 'yes'); };
  const filtered = categories.filter(function(cat) {
    if (type !== 'all' && _vwCatText(cat.tx_type_key) !== type) return false;
    if (major !== 'all' && _vwCatText(cat.major_category_key) !== major) return false;
    if (minor !== 'all' && _vwCatText(cat.minor_category_key) !== minor) return false;
    if (query !== '') {
      const hay = [cat.major_category_label, cat.minor_category_label, cat.description, cat.tag_keywords, cat.counterparty_examples]
        .map(_vwCatText).join(' ').toLowerCase();
      if (hay.indexOf(query) === -1) return false;
    }
    if (!flag(toBool(cat.source_account_mandatory), source.value)) return false;
    if (!flag(toBool(cat.target_account_mandatory), target.value)) return false;
    if (!flag(toBool(cat.is_subscription_eligible), eligible.value)) return false;
    if (!statuses.all && statuses.value.indexOf(_vwCatText(cat.record_status)) === -1) return false;
    return true;
  }).map(function(cat) { return _vwCatRow(cat, typeLabels, hintLabels); }).sort(_vwCatCompare(sortCol, sortDir));

  const total = filtered.length;
  let page = 1, pages = 1, rows = filtered;
  if (paging.size !== null) {
    pages = Math.max(1, Math.ceil(total / paging.size));
    page = Math.min(paging.page, pages);
    rows = filtered.slice((page - 1) * paging.size, page * paging.size);
  }
  let activeFilters = 0;
  [type, major, minor, source.value, target.value, eligible.value].forEach(function(value) { if (value !== 'all') activeFilters++; });
  if (search !== '') activeFilters++;
  if (!statuses.all) activeFilters++;

  return {
    ok: true,
    data: {
      rows: rows,
      count: total,
      total: total,
      total_all: categories.length,
      page: page,
      page_size: paging.size === null ? 'all' : paging.size,
      pages: pages,
      sort: { col: sortCol, dir: sortDir },
      filters: {
        type: type, major: major, minor: minor, search: search, source_mandatory: source.value,
        target_mandatory: target.value, subscription_eligible: eligible.value, statuses: statuses.value,
      },
      active_filter_count: activeFilters,
      facets: _vwCatFacets(categories, schema),
    },
  };
}

function _vwCatSchemaTypes() {
  return CATEGORY_SCHEMA.tx_type_key.enum_values.map(function(value) {
    return { value: value, label: value.split('-').map(function(word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(' ') };
  });
}

function vwCatListView(ctx) {
  const built = vwCatBuildList(vmLoad('categories'), getAvailableAccountTypes(), ctx.params);
  if (built.ok === false) return built.error;
  return vmEnvelope(ctx, built.data, []);
}

// ── get_category_form_options ─────────────────────────────────────────────────

function vwCatBuildFormOptions(accountTypeRows) {
  const statuses = CATEGORY_SCHEMA.record_status.enum_values.slice();
  const groups = vwCatHintGroups(accountTypeRows).groups;
  return {
    types: _vwCatSchemaTypes(),
    account_type_hint_groups: groups,
    statuses_for_add: statuses.filter(function(status) { return status === 'active'; }).map(function(value) { return { value: value, label: _vwCatTitle(value) }; }),
    statuses_for_edit: statuses.map(function(value) { return { value: value, label: _vwCatTitle(value) }; }),
  };
}

function vwCatFormOptions(ctx) {
  return vmEnvelope(ctx, vwCatBuildFormOptions(getAvailableAccountTypes()), []);
}
