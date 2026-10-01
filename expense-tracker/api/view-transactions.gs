// =============================================================================
// FULCRUM FORGE — Transactions view: server list, detail, form options,
// prefill and export for app/sections/transactions.js (a pure renderer).
//
// GET actions (registered through viewTransactionsRegister):
//   list_transactions_view       filter / sort / page + rows shaped for the table
//   get_transaction_facets       filter-bar options (loaded once per data refresh,
//                                kept out of every list page to stay under the
//                                view-cache payload cap)
//   get_transaction              one leg with its counter leg (view panel)
//   get_transaction_form_options category tree + eligible accounts (add / edit)
//   get_transaction_prefill      add-form (copy) or subscription (subscribe) prefill
//   export_transactions          compact import-format rows (transfers as one row)
//
// Rules:
// - Transfer pairing always runs over the full sheet (ldgPairLegs), never over
//   the filtered or paged rows; filters only select rows.
// - Rows keep every leg (both transfer legs, deleted rows) exactly as the table
//   showed them.
// - Date filters use the recorded wall date (ldgTxDateKey); range=all (the
//   default when absent) is unbounded at both ends. A row whose date
//   cannot be read passes the date filter and is reported in warn_rows, as the
//   old client did (it never silently disappears).
// - Account names / currencies come from accounts_raw (a bad opening value on
//   one account must not take down the list).
// Globals in this file use the vwTx / _vwTx prefix.
// =============================================================================

const _VWTX_PAGE_SIZES = [10, 25, 50];
const _VWTX_DEFAULT_PAGE_SIZE = 50;
const _VWTX_SORT_COLS = ['tx_date_local', 'tx_type', 'account', 'amount', 'category'];
const _VWTX_SORT_ALIASES = { account_id: 'account', major_category: 'category', tx_amount_local: 'amount' };
const _VWTX_SORT_LABELS = { tx_date_local: 'Date', tx_type: 'Type', account: 'Account', amount: 'Amount', category: 'Category' };
// Date-range choices offered by the filter bar (all are ldg periods).
const _VWTX_RANGES = ['last_30', 'this_month', 'last_month', 'last_3', 'last_6', 'last_12', 'ytd', 'all', 'custom'];
const _VWTX_EXPORT_COLUMNS = [
  'id', 'tx_date_local', 'tx_timezone_local', 'tx_type', 'source_account', 'target_account',
  'user_location_area', 'user_location_city', 'user_location_country',
  'user_location_latitude', 'user_location_longitude',
  'source_amount_local', 'target_amount_local', 'major_category', 'minor_category',
  'description', 'counterparty_name', 'tx_tags', 'beneficiaries', 'record_status',
];
// Both legs of a compact import row share these values and one lifecycle.
const _VWTX_SHARED_LEG_FIELDS = ['tx_date_local', 'tx_timezone_local', 'major_category', 'minor_category',
  'user_location_area', 'user_location_city', 'user_location_country', 'user_location_latitude',
  'user_location_longitude', 'description', 'counterparty_name', 'tx_tags', 'beneficiaries'];
const _VWTX_MESSAGES = {
  transaction_not_found: 'This transaction could not be found. Refresh and try again.',
  invalid_sort: 'Choose a valid sort column and direction.',
  invalid_page: 'Page must be a whole number from 1.',
  invalid_page_size: 'Page size must be 10, 25 or 50.',
  invalid_form_mode: 'The form mode must be create or edit.',
  invalid_prefill_mode: 'The prefill mode must be copy or subscribe.',
  already_subscribed: 'Already tracked as a subscription.',
  not_subscription_eligible: 'This transaction\'s category cannot be used for subscriptions.',
  transfer_export_lossy: 'This transfer has separately edited or deleted legs that cannot fit one import row. Export transaction_master directly from Google Sheets to preserve both rows.',
  transaction_locked: 'This transaction is locked and cannot be changed.',
  transaction_deleted: 'This transaction is deleted. Restore it before editing.',
};

function viewTransactionsRegister(actions) {
  actions.list_transactions_view = { handler: function(ctx) { return vwTxListView(ctx); }, cache: true, ttl: 600 };
  actions.get_transaction_facets = { handler: function(ctx) { return vwTxFacetsView(ctx); }, cache: true, ttl: 600 };
  actions.get_transaction = { handler: function(ctx) { return vwTxGet(ctx); }, cache: true, ttl: 600 };
  actions.get_transaction_form_options = { handler: function(ctx) { return vwTxFormOptions(ctx); }, cache: true, ttl: 600 };
  actions.get_transaction_prefill = { handler: function(ctx) { return vwTxPrefill(ctx); }, cache: true, ttl: 600 };
  // Exports can exceed the cache payload limit; always computed.
  actions.export_transactions = { handler: function(ctx) { return vwTxExport(ctx); }, cache: false };
}

function _vwTxText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _vwTxLower(value) {
  return _vwTxText(value).toLowerCase();
}

function _vwTxError(code, field, details) {
  return vmError(code, field, _VWTX_MESSAGES[code], details);
}

function _vwTxRaw(value) {
  if (value === undefined || value === null) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  return String(value);
}

// en-GB money text with 2 decimals (mirrors the client fmtNative / fmtBase).
function _vwTxMoneyText(value, symbol) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return symbol + value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Shared index (one per request; every sheet read once via vmLoad) ─────────

function _vwTxIndex(ctx) {
  const txs = vmLoad('transactions');
  const accountsRaw = vmLoad('accounts_raw');
  const categories = vmLoad('categories');
  const fx = vmFx(ctx);
  const accounts = Object.create(null);
  accountsRaw.forEach(function(account) {
    const id = _vwTxLower(account.id);
    if (id !== '' && accounts[id] === undefined) accounts[id] = account;
  });
  const byId = Object.create(null);
  txs.forEach(function(tx) { const id = _vwTxLower(tx.id); if (id !== '' && byId[id] === undefined) byId[id] = tx; });
  const accountTypeLabels = Object.create(null);
  vmLoad('account_types').forEach(function(row) {
    const key = _vwTxText(row.account_type_key);
    if (key !== '' && accountTypeLabels[key] === undefined) accountTypeLabels[key] = _vwTxText(row.account_type_label) === '' ? key : _vwTxText(row.account_type_label);
  });
  const typeLabels = Object.create(null);
  getTransactionSchemaForClient().types.forEach(function(type) { typeLabels[type.value] = type.label; });
  return {
    ctx: ctx, txs: txs, by_id: byId, pairs: ldgPairLegs(txs), accounts_raw: accountsRaw, accounts: accounts,
    categories: categories, fx: fx, type_labels: typeLabels, account_type_labels: accountTypeLabels, subscriptions: null,
  };
}

function _vwTxAccount(index, accountId) {
  const account = index.accounts[_vwTxLower(accountId)];
  return account === undefined ? null : account;
}

function _vwTxAccountName(index, accountId) {
  const account = _vwTxAccount(index, accountId);
  return account === null ? '—' : _vwTxText(account.account_name);
}

function _vwTxAccountCurrency(index, accountId) {
  const account = _vwTxAccount(index, accountId);
  return account === null ? '' : _vwTxText(account.account_currency_local).toUpperCase();
}

// ── Categories (legacy label values resolve to keys, as _normCatKeys did) ────

// Returns { major_key, minor_key, major_label, minor_label, label, category }.
function _vwTxCategory(index, type, majorValue, minorValue) {
  const major = _vwTxText(majorValue), minor = _vwTxText(minorValue), txType = _vwTxText(type);
  if (major === '' && minor === '') return { major_key: '', minor_key: '', major_label: '—', minor_label: '—', label: '—', category: null };
  let majorKey = major, minorKey = minor;
  if (major !== '') {
    let match = index.categories.find(function(c) {
      return c.tx_type_key === txType && c.major_category_key === major && (minor === '' || c.minor_category_key === minor);
    });
    if (match !== undefined) { majorKey = match.major_category_key; minorKey = minor; }
    else {
      match = index.categories.find(function(c) {
        return c.tx_type_key === txType && c.major_category_label === major && (minor === '' || c.minor_category_label === minor);
      });
      if (match !== undefined) { majorKey = match.major_category_key; minorKey = minor === '' ? '' : match.minor_category_key; }
    }
  }
  const category = majorKey === '' || minorKey === '' ? undefined : index.categories.find(function(c) {
    return c.tx_type_key === txType && c.major_category_key === majorKey && c.minor_category_key === minorKey;
  });
  if (category === undefined) {
    return {
      major_key: majorKey, minor_key: minorKey, major_label: major === '' ? '—' : major, minor_label: minor === '' ? '—' : minor,
      label: [major, minor].filter(function(v) { return v !== ''; }).join(' → '), category: null,
    };
  }
  return {
    major_key: majorKey, minor_key: minorKey,
    major_label: _vwTxText(category.major_category_label), minor_label: _vwTxText(category.minor_category_label),
    label: _vwTxText(category.major_category_label) + ' → ' + _vwTxText(category.minor_category_label), category: category,
  };
}

// ── Subscription eligibility (ports _isCatSubEligible / _isAlreadySubscribed) ─

function _vwTxSubscriptions(index) {
  if (index.subscriptions === null) index.subscriptions = vmLoad('subscriptions');
  return index.subscriptions;
}

function _vwTxIsSubscriptionEligible(index, tx) {
  if (_vwTxText(tx.major_category) === '' || _vwTxText(tx.minor_category) === '') return false;
  const resolved = _vwTxCategory(index, tx.tx_type, tx.major_category, tx.minor_category);
  return resolved.category !== null && toBool(resolved.category.is_subscription_eligible) === true;
}

// Subscriptions have no transaction FK: counterparty + account + the optional
// classification (blank = wildcard) is the matching heuristic.
function _vwTxIsAlreadySubscribed(index, tx) {
  const counterparty = _vwTxLower(tx.counterparty_name);
  if (counterparty === '') return false;
  return _vwTxSubscriptions(index).some(function(sub) {
    if (_vwTxText(sub.record_status) === 'deleted') return false;
    if (_vwTxLower(sub.counterparty_name) !== counterparty) return false;
    if (_vwTxLower(sub.source_account) !== _vwTxLower(tx.account_id)) return false;
    return ['tx_type', 'major_category', 'minor_category'].every(function(key) {
      const selected = _vwTxText(sub[key]);
      return selected === '' || selected === _vwTxText(tx[key]);
    });
  });
}

// ── Row shaping ───────────────────────────────────────────────────────────────

function _vwTxAllowedActions(index, tx) {
  const status = _vwTxText(tx.record_status);
  if (status === 'locked') return ['view'];
  if (status === 'deleted') return ['view', 'restore'];
  const actions = ['view', 'edit', 'copy', 'delete'];
  if (_vwTxIsSubscriptionEligible(index, tx) && !_vwTxIsAlreadySubscribed(index, tx)) actions.push('subscribe');
  return actions;
}

function _vwTxMoney(index, amount, currency) {
  const fx = index.fx;
  const money = fxMoney(amount, currency, fx);
  const rate = fx.rate_map[money.currency];
  money.native_display = _vwTxMoneyText(money.native, money.currency_symbol);
  money.quote_display = _vwTxMoneyText(money.quote, fx.quote_symbol);
  money.show_quote = money.currency !== fx.quote_currency;
  money.missing_rate = !(typeof rate === 'number' && rate > 0);
  return money;
}

function _vwTxTags(value) {
  return _vwTxText(value).split(';').map(function(tag) { return tag.trim(); }).filter(function(tag) { return tag !== ''; });
}

// "Alice:60;Bob:40" → [{ name, pct }] (pct null when not given).
function _vwTxBeneficiaries(value) {
  const text = _vwTxText(value);
  if (text === '') return [];
  return text.split(';').map(function(part) {
    const at = part.indexOf(':');
    if (at === -1) return { name: part.trim(), pct: null };
    return { name: part.slice(0, at).trim(), pct: part.slice(at + 1).trim() };
  }).filter(function(entry) { return entry.name !== '' || entry.pct !== null; });
}

// Table / card row. Also the base of the detail record.
function _vwTxRow(index, tx) {
  const type = _vwTxText(tx.tx_type);
  const accountId = _vwTxText(tx.account_id);
  const currency = _vwTxAccountCurrency(index, accountId);
  const accountName = _vwTxAccountName(index, accountId);
  const sibling = ldgSibling(tx, index.pairs);
  let counterLeg = null;
  let accountLabel = accountName;
  if (sibling !== null) {
    const siblingName = _vwTxAccountName(index, sibling.account_id);
    counterLeg = {
      id: _vwTxText(sibling.id), row_num: sibling._row, account_id: _vwTxText(sibling.account_id), account_name: siblingName,
      tx_type: _vwTxText(sibling.tx_type), record_status: _vwTxText(sibling.record_status),
      amount: _vwTxMoney(index, sibling.tx_amount_local, _vwTxAccountCurrency(index, sibling.account_id)),
    };
    accountLabel = type === 'money-out' ? accountName + ' → ' + siblingName : siblingName + ' → ' + accountName;
  }
  const category = _vwTxCategory(index, type, tx.major_category, tx.minor_category);
  const status = _vwTxText(tx.record_status);
  return {
    id: _vwTxText(tx.id), row_num: tx._row, updated_at: _vwTxRaw(tx.updated_at),
    tx_date_local: _vwTxText(tx.tx_date_local), tx_timezone_local: _vwTxText(tx.tx_timezone_local),
    tx_type: type, tx_type_label: index.type_labels[type] !== undefined ? index.type_labels[type] : type,
    badge: type === 'money-in' ? 'in' : type === 'money-out' ? 'out' : 'transfer',
    account: { id: accountId, name: accountName, currency: currency },
    account_label: accountLabel, counter_leg: counterLeg, is_transfer_leg: ldgIsTransferLeg(tx, index.pairs),
    amount: _vwTxMoney(index, tx.tx_amount_local, currency),
    category: { major_key: category.major_key, minor_key: category.minor_key, major_label: category.major_label, minor_label: category.minor_label, label: category.label },
    counterparty_name: _vwTxText(tx.counterparty_name),
    record_status: status, sync_status: _vwTxText(tx.sync_status),
    readonly: status === 'locked' || status === 'deleted',
    allowed_actions: _vwTxAllowedActions(index, tx),
  };
}

// Full record for the view panel / edit form (row + every stored field).
function _vwTxDetail(index, tx) {
  const row = _vwTxRow(index, tx);
  const dateText = _vwTxText(tx.tx_date_local);
  return Object.assign(row, {
    parent_tx_id: _vwTxText(tx.parent_tx_id),
    tx_amount_local: _vwTxRaw(tx.tx_amount_local).trim(),
    tx_date_input: dateText.replace(' ', 'T').substring(0, 16),
    major_category: _vwTxText(tx.major_category), minor_category: _vwTxText(tx.minor_category),
    description: _vwTxText(tx.description),
    tx_tags: _vwTxText(tx.tx_tags), tags: _vwTxTags(tx.tx_tags), tags_display: _vwTxTags(tx.tx_tags).join(', '),
    beneficiaries: _vwTxText(tx.beneficiaries), beneficiaries_list: _vwTxBeneficiaries(tx.beneficiaries),
    location: {
      area: _vwTxText(tx.user_location_area), city: _vwTxText(tx.user_location_city), country: _vwTxText(tx.user_location_country),
      latitude: _vwTxRaw(tx.user_location_latitude).trim(), longitude: _vwTxRaw(tx.user_location_longitude).trim(),
    },
    sync_notes: _vwTxText(tx.sync_notes),
  });
}

// ── Filters ───────────────────────────────────────────────────────────────────

function _vwTxList(value) {
  return splitToList(value);
}

// Parses filter params shared by the list and the export.
// Returns { ok:true, filters } or a vmError envelope.
function _vwTxFilters(ctx) {
  const p = ctx.params;
  const range = _vwTxText(p.range) === '' ? 'all' : _vwTxText(p.range);
  const bounds = ldgPeriodBounds(range, ctx.today, p.from, p.to);
  if (bounds === null) return vmError('invalid_period', 'range');
  // "All" in the list means every row, including future-dated ones.
  const to = range === 'all' ? null : bounds.to;
  return {
    ok: true,
    filters: {
      range: range, from: bounds.from, to: to, range_label: bounds.label,
      custom_from: range === 'custom' ? _vwTxText(p.from) : '', custom_to: range === 'custom' ? _vwTxText(p.to) : '',
      types: _vwTxList(p.types), account_ids: _vwTxList(p.account_ids).map(function(id) { return id.toLowerCase(); }),
      account_types: _vwTxList(p.account_types), major: _vwTxList(p.major), minor: _vwTxList(p.minor),
      user_location_country: _vwTxLower(p.user_location_country), user_location_city: _vwTxLower(p.user_location_city),
      user_location_area: _vwTxLower(p.user_location_area), tag: _vwTxLower(p.tag),
      counterparty: _vwTxLower(p.counterparty), search: _vwTxLower(p.search),
    },
  };
}

// Number of active (non-default) filters, for the "Filters (n)" label.
function _vwTxActiveFilterCount(filters) {
  let count = filters.range === 'last_30' ? 0 : 1;
  ['types', 'account_ids', 'account_types', 'major', 'minor'].forEach(function(key) { count += filters[key].length; });
  ['user_location_country', 'user_location_city', 'user_location_area', 'tag', 'counterparty', 'search'].forEach(function(key) { if (filters[key] !== '') count += 1; });
  return count;
}

function _vwTxMatches(index, tx, filters) {
  // An unreadable date passes the date filter (reported in warn_rows).
  const dateKey = ldgTxDateKey(tx);
  if (dateKey !== null && !ldgInRange(dateKey, filters.from, filters.to)) return false;
  if (filters.types.length > 0 && filters.types.indexOf(_vwTxText(tx.tx_type)) === -1) return false;
  if (filters.account_ids.length > 0 && filters.account_ids.indexOf(_vwTxLower(tx.account_id)) === -1) return false;
  if (filters.account_types.length > 0) {
    const account = _vwTxAccount(index, tx.account_id);
    if (account === null || filters.account_types.indexOf(_vwTxText(account.type)) === -1) return false;
  }
  if (filters.major.length > 0 && filters.major.indexOf(_vwTxText(tx.major_category)) === -1) return false;
  if (filters.minor.length > 0 && filters.minor.indexOf(_vwTxText(tx.minor_category)) === -1) return false;
  if (filters.user_location_country !== '' && _vwTxLower(tx.user_location_country).indexOf(filters.user_location_country) === -1) return false;
  if (filters.user_location_city !== '' && _vwTxLower(tx.user_location_city).indexOf(filters.user_location_city) === -1) return false;
  if (filters.user_location_area !== '' && _vwTxLower(tx.user_location_area).indexOf(filters.user_location_area) === -1) return false;
  if (filters.tag !== '' && !_vwTxTags(tx.tx_tags).some(function(tag) { return tag.toLowerCase().indexOf(filters.tag) !== -1; })) return false;
  if (filters.counterparty !== '' && _vwTxLower(tx.counterparty_name) !== filters.counterparty) return false;
  if (filters.search !== '') {
    const account = _vwTxAccount(index, tx.account_id);
    const hay = [tx.counterparty_name, tx.description, account === null ? '' : account.account_name]
      .map(function(value) { return _vwTxText(value); }).join(' ').toLowerCase();
    if (hay.indexOf(filters.search) === -1) return false;
  }
  return true;
}

// Missing id, unreadable date or an unknown type (the old warn split, R17).
function _vwTxWarnReason(tx) {
  if (_vwTxText(tx.id) === '') return 'missing_id';
  if (ldgTxDateKey(tx) === null) return 'invalid_date';
  if (VALID_TRANSACTION_TYPES.indexOf(_vwTxText(tx.tx_type)) === -1) return 'invalid_type';
  return null;
}

// ── Sort / page ───────────────────────────────────────────────────────────────

function _vwTxSort(ctx) {
  const rawCol = _vwTxText(ctx.params.sort_col);
  const aliased = _VWTX_SORT_ALIASES[rawCol] !== undefined ? _VWTX_SORT_ALIASES[rawCol] : rawCol;
  const col = aliased === '' ? 'tx_date_local' : aliased;
  const dir = _vwTxText(ctx.params.sort_dir) === '' ? 'desc' : _vwTxText(ctx.params.sort_dir).toLowerCase();
  if (_VWTX_SORT_COLS.indexOf(col) === -1) return vmError('invalid_sort', 'sort_col', _VWTX_MESSAGES.invalid_sort);
  if (dir !== 'asc' && dir !== 'desc') return vmError('invalid_sort', 'sort_dir', _VWTX_MESSAGES.invalid_sort);
  return { ok: true, sort: { col: col, dir: dir } };
}

function _vwTxSortValue(row, col, dateKeys) {
  if (col === 'tx_date_local') return dateKeys[row.id + '|' + row.row_num];
  if (col === 'tx_type') return row.tx_type === '' ? null : row.tx_type.toLowerCase();
  if (col === 'account') return row.account_label === '—' ? null : row.account_label.toLowerCase();
  if (col === 'amount') return row.amount.quote === null ? null : row.amount.quote;
  if (col === 'category') return row.category.label === '—' || row.category.label === '' ? null : row.category.label.toLowerCase();
  return null;
}

// Blanks sort last in both directions; ties keep sheet order (row number).
function _vwTxSortRows(rows, sort, dateKeys) {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort(function(a, b) {
    const va = _vwTxSortValue(a, sort.col, dateKeys), vb = _vwTxSortValue(b, sort.col, dateKeys);
    const aNil = va === null || va === undefined, bNil = vb === null || vb === undefined;
    if (aNil && !bNil) return 1;
    if (bNil && !aNil) return -1;
    if (!aNil && !bNil && va !== vb) return va < vb ? -factor : factor;
    return Number(a.row_num) - Number(b.row_num);
  });
}

function _vwTxPaging(ctx) {
  const pageText = _vwTxText(ctx.params.page), sizeText = _vwTxText(ctx.params.page_size);
  const page = pageText === '' ? 1 : Number(pageText);
  const size = sizeText === '' ? _VWTX_DEFAULT_PAGE_SIZE : Number(sizeText);
  if (!Number.isInteger(page) || page < 1) return vmError('invalid_page', 'page', _VWTX_MESSAGES.invalid_page);
  if (_VWTX_PAGE_SIZES.indexOf(size) === -1) return vmError('invalid_page_size', 'page_size', _VWTX_MESSAGES.invalid_page_size);
  return { ok: true, page: page, page_size: size };
}

// ── Facets (full dataset, independent of the applied filters) ────────────────

function _vwTxDistinct(values) {
  const seen = Object.create(null);
  values.forEach(function(value) { const text = _vwTxText(value); if (text !== '') seen[text] = true; });
  return Object.keys(seen).sort();
}

function _vwTxByLabel(a, b) { return a.label.localeCompare(b.label); }

// Suggestions for datalists / tag autocomplete (non-deleted rows; as get_transaction_metadata).
function _vwTxSuggestionLists(index) {
  const live = index.txs.filter(function(tx) { return _vwTxText(tx.record_status) !== 'deleted'; });
  const tags = [];
  live.forEach(function(tx) { _vwTxTags(tx.tx_tags).forEach(function(tag) { tags.push(tag); }); });
  return {
    countries: _vwTxDistinct(live.map(function(tx) { return tx.user_location_country; })),
    cities: _vwTxDistinct(live.map(function(tx) { return tx.user_location_city; })),
    areas: _vwTxDistinct(live.map(function(tx) { return tx.user_location_area; })),
    counterparties: _vwTxDistinct(live.map(function(tx) { return tx.counterparty_name; })),
    tags: _vwTxDistinct(tags),
  };
}

function _vwTxFacets(index) {
  const typeCounts = Object.create(null);
  const accountTypes = [];
  const accountsByType = Object.create(null);
  const accounts = index.accounts_raw.filter(function(account) { return _vwTxText(account.id) !== ''; }).map(function(account) {
    const type = _vwTxText(account.type);
    if (typeCounts[type] === undefined) {
      typeCounts[type] = 0;
      accountsByType[type] = [];
      accountTypes.push({ value: type, label: index.account_type_labels[type] !== undefined ? index.account_type_labels[type] : type });
    }
    typeCounts[type] += 1;
    accountsByType[type].push(_vwTxText(account.id));
    return { id: _vwTxText(account.id), name: _vwTxText(account.account_name), type: type, record_status: _vwTxText(account.record_status) };
  });
  accountTypes.forEach(function(entry) { entry.count = typeCounts[entry.value]; });
  const majors = Object.create(null), minors = Object.create(null), minorsByMajor = Object.create(null);
  index.categories.forEach(function(category) {
    const major = _vwTxText(category.major_category_key), minor = _vwTxText(category.minor_category_key);
    if (major === '') return;
    majors[major] = _vwTxText(category.major_category_label) === '' ? major : _vwTxText(category.major_category_label);
    if (minor === '') return;
    const minorLabel = _vwTxText(category.minor_category_label) === '' ? minor : _vwTxText(category.minor_category_label);
    minors[minor] = minorLabel;
    if (minorsByMajor[major] === undefined) minorsByMajor[major] = Object.create(null);
    minorsByMajor[major][minor] = minorLabel;
  });
  const entries = function(map) { return Object.keys(map).map(function(key) { return { key: key, label: map[key] }; }).sort(_vwTxByLabel); };
  const byMajor = {};
  Object.keys(minorsByMajor).forEach(function(major) { byMajor[major] = entries(minorsByMajor[major]); });
  const lists = _vwTxSuggestionLists(index);
  return {
    types: getTransactionSchemaForClient().types,
    account_types: accountTypes,
    accounts: accounts.sort(function(a, b) { return a.name.localeCompare(b.name); }),
    accounts_by_type: accountsByType,
    majors: entries(majors), minors: entries(minors), minors_by_major: byMajor,
    countries: lists.countries, cities: lists.cities, areas: lists.areas, tags: lists.tags, counterparties: lists.counterparties,
    ranges: _VWTX_RANGES.map(function(key) { return { value: key, label: LDG_PERIOD_LABELS[key] }; }),
    sort_cols: _VWTX_SORT_COLS.map(function(key) { return { value: key, label: _VWTX_SORT_LABELS[key] }; }),
    page_sizes: _VWTX_PAGE_SIZES.slice(),
  };
}

// ── get_transaction_facets ────────────────────────────────────────────────────

// GET get_transaction_facets (no screen params). data: { types, account_types,
// accounts, accounts_by_type, majors, minors, minors_by_major, countries, cities,
// areas, tags, counterparties, ranges, sort_cols, page_sizes }. Independent of
// the list query, so the filter bar fetches it once per data refresh.
function vwTxFacetsView(ctx) {
  return vmEnvelope(ctx, _vwTxFacets(_vwTxIndex(ctx)), []);
}

// ── list_transactions_view ────────────────────────────────────────────────────
// Params: range (default all), from, to (custom), types, account_ids,
// account_types, major, minor (csv), user_location_country / _city / _area,
// tag (substring), counterparty (exact), search (counterparty, description,
// account name), sort_col (tx_date_local|tx_type|account|amount|category),
// sort_dir (asc|desc), page (1-based), page_size (10|25|50).
function vwTxListView(ctx) {
  const parsed = _vwTxFilters(ctx);
  if (parsed.ok !== true) return parsed;
  const sorted = _vwTxSort(ctx);
  if (sorted.ok !== true) return sorted;
  const paging = _vwTxPaging(ctx);
  if (paging.ok !== true) return paging;
  const filters = parsed.filters;
  const index = _vwTxIndex(ctx);

  const matched = index.txs.filter(function(tx) { return _vwTxMatches(index, tx, filters); });
  const warnRows = [];
  const valid = [];
  matched.forEach(function(tx) {
    const reason = _vwTxWarnReason(tx);
    if (reason === null) { valid.push(tx); return; }
    warnRows.push({ id: _vwTxText(tx.id), row_num: tx._row, tx_type: _vwTxText(tx.tx_type), tx_date_local: _vwTxText(tx.tx_date_local), reason: reason });
  });

  const dateKeys = Object.create(null);
  const shaped = valid.map(function(tx) {
    const row = _vwTxRow(index, tx);
    dateKeys[row.id + '|' + row.row_num] = ldgTxLocalKey(tx);
    return row;
  });
  const ordered = _vwTxSortRows(shaped, sorted.sort, dateKeys);
  const total = ordered.length;
  const pages = Math.max(1, Math.ceil(total / paging.page_size));
  const page = Math.min(paging.page, pages);
  const rows = ordered.slice((page - 1) * paging.page_size, page * paging.page_size);

  // Currencies of the matched rows drive the missing-rate warning.
  const currencies = Object.create(null);
  shaped.forEach(function(row) { if (row.amount.currency !== '') currencies[row.amount.currency] = true; });

  const data = {
    rows: rows, total: total, page: page, page_size: paging.page_size, pages: pages, sort: sorted.sort,
    range: { key: filters.range, label: filters.range_label, from: filters.from, to: filters.to },
    filters: {
      range: filters.range, from: filters.custom_from, to: filters.custom_to, types: filters.types, account_ids: filters.account_ids,
      account_types: filters.account_types, major: filters.major, minor: filters.minor,
      user_location_country: filters.user_location_country, user_location_city: filters.user_location_city,
      user_location_area: filters.user_location_area, tag: filters.tag, counterparty: filters.counterparty, search: filters.search,
    },
    active_filter_count: _vwTxActiveFilterCount(filters),
    warn_rows: warnRows,
  };
  console.log('vwTxListView: matched=' + matched.length + ' valid=' + total + ' warn=' + warnRows.length + ' page=' + page + '/' + pages);
  return vmEnvelope(ctx, data, [fxMissingRateWarning(Object.keys(currencies), index.fx)]);
}

// ── get_transaction ───────────────────────────────────────────────────────────

function _vwTxFind(index, id) {
  const key = _vwTxLower(id);
  if (key === '') return null;
  const tx = index.by_id[key];
  return tx === undefined ? null : tx;
}

// Params: id. data: { transaction: detail } (detail.counter_leg = the other leg).
function vwTxGet(ctx) {
  const index = _vwTxIndex(ctx);
  const tx = _vwTxFind(index, ctx.params.id);
  if (tx === null) return _vwTxError('transaction_not_found', 'id');
  const detail = _vwTxDetail(index, tx);
  return vmEnvelope(ctx, { transaction: detail }, [fxMissingRateWarning([detail.amount.currency], index.fx)]);
}

// ── get_transaction_form_options ──────────────────────────────────────────────

// A category hint lists account types / subtypes allowed for a leg. Shared
// with the CSV importer (txAccountsForCategoryHint in transaction-import.gs).
function _vwTxEligibleIds(activeAccounts, hint) {
  return txAccountsForCategoryHint(activeAccounts, hint).map(function(account) { return _vwTxText(account.id); });
}

// Categories repeat the same few hints, so each distinct hint's eligible
// accounts are sent once (account_sets) and legs reference them by key.
// Key = normalised hint tokens ('' = no hint = every active account).
function _vwTxAccountSet(sets, activeAccounts, hint) {
  const key = splitToList(hint).map(function(token) { return token.toLowerCase(); }).sort().join(',');
  if (sets[key] === undefined) sets[key] = _vwTxEligibleIds(activeAccounts, key);
  return key;
}

function _vwTxOptionAccount(index, account) {
  const currency = _vwTxText(account.account_currency_local).toUpperCase();
  const status = _vwTxText(account.record_status);
  return {
    id: _vwTxText(account.id), name: _vwTxText(account.account_name), currency: currency,
    currency_symbol: fxSymbol(currency, index.fx.symbols), record_status: status,
    label: _vwTxText(account.account_name) + ' (' + currency + ')' + (status === 'active' ? '' : ' · ' + status),
  };
}

// tx_type → majors → minors, each minor with the source / target leg rule
// { mandatory, account_set } (eligible ids in account_sets[account_set]).
function _vwTxCategoryTree(index, activeAccounts, sets) {
  const tree = {};
  VALID_TRANSACTION_TYPES.forEach(function(type) { tree[type] = { majors: [] }; });
  const majors = Object.create(null);
  index.categories.forEach(function(category) {
    const type = _vwTxText(category.tx_type_key), majorKey = _vwTxText(category.major_category_key), minorKey = _vwTxText(category.minor_category_key);
    if (tree[type] === undefined || majorKey === '' || minorKey === '') return;
    const id = type + '|' + majorKey;
    if (majors[id] === undefined) {
      majors[id] = { key: majorKey, label: _vwTxText(category.major_category_label) === '' ? majorKey : _vwTxText(category.major_category_label), active: false, minors: [] };
      tree[type].majors.push(majors[id]);
    }
    const active = _vwTxText(category.record_status) === 'active';
    if (active) majors[id].active = true;
    const sourceMandatory = toBool(category.source_account_mandatory), targetMandatory = toBool(category.target_account_mandatory);
    majors[id].minors.push({
      key: minorKey, label: _vwTxText(category.minor_category_label) === '' ? minorKey : _vwTxText(category.minor_category_label),
      active: active, record_status: _vwTxText(category.record_status),
      source: { mandatory: sourceMandatory, account_set: _vwTxAccountSet(sets, activeAccounts, category.source_account_types) },
      target: { mandatory: targetMandatory, account_set: _vwTxAccountSet(sets, activeAccounts, category.target_account_types) },
      is_transfer: sourceMandatory && targetMandatory,
      is_subscription_eligible: toBool(category.is_subscription_eligible),
    });
  });
  return tree;
}

// Params: mode (create|edit, default create), id (edit).
// data: { mode, tx_types, categories, uncategorised, account_sets, accounts, datalists, edit }
function vwTxFormOptions(ctx) {
  const mode = _vwTxText(ctx.params.mode) === '' ? 'create' : _vwTxText(ctx.params.mode);
  if (mode !== 'create' && mode !== 'edit') return _vwTxError('invalid_form_mode', 'mode');
  const index = _vwTxIndex(ctx);
  let tx = null;
  if (mode === 'edit') {
    tx = _vwTxFind(index, ctx.params.id);
    if (tx === null) return _vwTxError('transaction_not_found', 'id');
    const status = _vwTxText(tx.record_status);
    if (status === 'locked') return _vwTxError('transaction_locked', 'id');
    if (status === 'deleted') return _vwTxError('transaction_deleted', 'id');
  }
  const active = index.accounts_raw.filter(function(account) { return _vwTxText(account.id) !== '' && _vwTxText(account.record_status) === 'active'; });
  const activeIds = active.map(function(account) { return _vwTxText(account.id); });
  const accounts = active.map(function(account) { return _vwTxOptionAccount(index, account); });
  let edit = null;
  if (tx !== null) {
    const detail = _vwTxDetail(index, tx);
    // An edit may keep a row on its inactive / locked (closed) account; it is
    // never offered as a new choice, and a deleted account is never offered.
    const current = _vwTxAccount(index, tx.account_id);
    let keep = null;
    if (current !== null && _vwTxText(current.record_status) !== 'deleted') {
      keep = _vwTxText(current.id);
      if (activeIds.indexOf(keep) === -1) accounts.unshift(_vwTxOptionAccount(index, current));
    }
    edit = {
      record: detail,
      account_field: detail.tx_type === 'money-out' ? 'source' : 'target',
      category: { major_key: detail.category.major_key, minor_key: detail.category.minor_key },
      keep_account_id: keep,
      counter_leg_account_name: detail.counter_leg === null ? null : detail.counter_leg.account_name,
    };
  }
  const sets = {};
  sets[''] = activeIds;
  const data = {
    mode: mode,
    tx_types: getTransactionSchemaForClient().types,
    categories: _vwTxCategoryTree(index, active, sets),
    // Before a category is chosen: money-out books a source account, money-in
    // books to an external source; every active account is a candidate.
    uncategorised: {
      'money-in': { source: { mandatory: false, account_set: '' }, target: { mandatory: false, account_set: '' }, is_transfer: false },
      'money-out': { source: { mandatory: true, account_set: '' }, target: { mandatory: false, account_set: '' }, is_transfer: false },
    },
    account_sets: sets,
    accounts: accounts,
    datalists: _vwTxSuggestionLists(index),
    edit: edit,
  };
  return vmEnvelope(ctx, data, []);
}

// ── get_transaction_prefill ───────────────────────────────────────────────────

// Add-form prefill from an existing leg; transfers rebuild both sides from the
// counter leg (which may be on another page).
function _vwTxCopyPrefill(index, tx) {
  const sibling = ldgSibling(tx, index.pairs);
  const type = _vwTxText(tx.tx_type);
  let source = '', target = '', sourceAmount = _vwTxRaw(tx.tx_amount_local).trim(), targetAmount = '';
  if (type === 'money-out') {
    source = _vwTxText(tx.account_id);
    if (sibling !== null && _vwTxText(sibling.tx_type) === 'money-in') {
      target = _vwTxText(sibling.account_id);
      targetAmount = _vwTxRaw(sibling.tx_amount_local).trim();
    }
  } else {
    target = _vwTxText(tx.account_id);
    if (sibling !== null && _vwTxText(sibling.tx_type) === 'money-out') {
      source = _vwTxText(sibling.account_id);
      sourceAmount = _vwTxRaw(sibling.tx_amount_local).trim();
      targetAmount = _vwTxRaw(tx.tx_amount_local).trim();
    }
  }
  const category = _vwTxCategory(index, type, tx.major_category, tx.minor_category);
  return {
    tx_type: type, major_category: category.major_key, minor_category: category.minor_key,
    source_account: source, target_account: target, source_amount: sourceAmount, target_amount: targetAmount,
    counterparty_name: _vwTxText(tx.counterparty_name),
    user_location_area: _vwTxText(tx.user_location_area), user_location_city: _vwTxText(tx.user_location_city),
    user_location_country: _vwTxText(tx.user_location_country),
    tx_tags: _vwTxText(tx.tx_tags), description: _vwTxText(tx.description),
  };
}

// Subscription-form prefill (state.subPrefill shape used by subscriptions.js).
function _vwTxSubscriptionPrefill(tx) {
  return {
    name: _vwTxText(tx.counterparty_name), counterparty_name: _vwTxText(tx.counterparty_name),
    amount: Number(tx.tx_amount_local), source_account: _vwTxText(tx.account_id), tx_type: _vwTxText(tx.tx_type),
    major_category: _vwTxText(tx.major_category), minor_category: _vwTxText(tx.minor_category), tx_tags: _vwTxText(tx.tx_tags),
  };
}

// Params: id, mode (copy|subscribe). data: { mode, prefill }.
function vwTxPrefill(ctx) {
  const mode = _vwTxText(ctx.params.mode) === '' ? 'copy' : _vwTxText(ctx.params.mode);
  if (mode !== 'copy' && mode !== 'subscribe') return _vwTxError('invalid_prefill_mode', 'mode');
  const index = _vwTxIndex(ctx);
  const tx = _vwTxFind(index, ctx.params.id);
  if (tx === null) return _vwTxError('transaction_not_found', 'id');
  if (mode === 'copy') return vmEnvelope(ctx, { mode: mode, prefill: _vwTxCopyPrefill(index, tx) }, []);
  if (!_vwTxIsSubscriptionEligible(index, tx)) return _vwTxError('not_subscription_eligible', 'id');
  if (_vwTxIsAlreadySubscribed(index, tx)) return _vwTxError('already_subscribed', 'id');
  return vmEnvelope(ctx, { mode: mode, prefill: _vwTxSubscriptionPrefill(tx) }, []);
}

// ── export_transactions ───────────────────────────────────────────────────────

// Account reference for an import row: the name when it identifies one
// non-deleted account, else the UUID (the importer accepts both).
function _vwTxExportAccountRefs(index) {
  const counts = Object.create(null);
  index.accounts_raw.forEach(function(account) {
    if (_vwTxText(account.record_status) === 'deleted') return;
    const key = _vwTxLower(account.account_name);
    counts[key] = (counts[key] === undefined ? 0 : counts[key]) + 1;
  });
  return function(accountId) {
    const account = _vwTxAccount(index, accountId);
    if (account === null) return _vwTxText(accountId);
    return counts[_vwTxLower(account.account_name)] === 1 ? _vwTxText(account.account_name) : _vwTxText(account.id);
  };
}

function _vwTxChildrenByParent(txs) {
  const children = Object.create(null);
  txs.forEach(function(tx) {
    const parent = _vwTxLower(tx.parent_tx_id);
    if (parent === '') return;
    if (children[parent] === undefined) children[parent] = [];
    children[parent].push(tx);
  });
  return children;
}

// Rebuilds compact import rows (source / target) from single-leg rows.
// Returns { ok:true, rows } or { ok:false, id } for a transfer whose legs
// cannot share one import row (separately edited / deleted legs, several
// children, or a child without its parent).
function _vwTxExportRows(index, selected) {
  const children = _vwTxChildrenByParent(index.txs);
  const accountRef = _vwTxExportAccountRefs(index);
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    const parentKey = _vwTxLower(row.parent_tx_id);
    const parent = parentKey === '' ? undefined : index.by_id[parentKey];
    const tx = parent !== undefined ? parent : row;
    const txKey = _vwTxLower(tx.id);
    const sibling = ldgSibling(tx, index.pairs);
    if (parentKey !== '' && (parent === undefined || sibling !== row)) return { ok: false, id: _vwTxText(row.id) };
    if (children[txKey] !== undefined && children[txKey].length > 1) return { ok: false, id: _vwTxText(tx.id) };
    if (sibling !== null) {
      const status = function(value) { return _vwTxText(value) === '' ? 'active' : _vwTxText(value); };
      if (status(tx.record_status) !== status(sibling.record_status)
          || _VWTX_SHARED_LEG_FIELDS.some(function(key) { return _vwTxRaw(tx[key]) !== _vwTxRaw(sibling[key]); })) return { ok: false, id: _vwTxText(tx.id) };
    }
    if (seen[txKey] === true) continue;
    seen[txKey] = true;
    if (sibling !== null) seen[_vwTxLower(sibling.id)] = true;
    const own = accountRef(tx.account_id);
    const amount = _vwTxRaw(tx.tx_amount_local).trim();
    let source = '', target = '', sourceAmount = '', targetAmount = '';
    if (sibling !== null) {
      const other = accountRef(sibling.account_id);
      const otherAmount = _vwTxRaw(sibling.tx_amount_local).trim();
      if (_vwTxText(tx.tx_type) === 'money-out') { source = own; target = other; sourceAmount = amount; targetAmount = otherAmount; }
      else { source = other; target = own; sourceAmount = otherAmount; targetAmount = amount; }
    } else if (_vwTxText(tx.tx_type) === 'money-out') { source = own; sourceAmount = amount; }
    else { target = own; targetAmount = amount; }
    const record = {};
    _VWTX_EXPORT_COLUMNS.forEach(function(column) { record[column] = _vwTxRaw(tx[column]); });
    record.source_account = source; record.target_account = target;
    record.source_amount_local = sourceAmount; record.target_amount_local = targetAmount;
    out.push(record);
  }
  return { ok: true, rows: out };
}

// Same filter params as the list (range default all; no paging).
// data: { filename, columns, rows, legs, count }. Refuses a lossy transfer with
// transfer_export_lossy (details.id = the leg that cannot be exported).
function vwTxExport(ctx) {
  const parsed = _vwTxFilters(ctx);
  if (parsed.ok !== true) return parsed;
  const index = _vwTxIndex(ctx);
  const selected = index.txs.filter(function(tx) { return _vwTxMatches(index, tx, parsed.filters); });
  const built = _vwTxExportRows(index, selected);
  if (built.ok !== true) {
    console.warn('vwTxExport: refused=transfer_export_lossy legs=' + selected.length);
    return _vwTxError('transfer_export_lossy', null, { id: built.id });
  }
  console.log('vwTxExport: legs=' + selected.length + ' rows=' + built.rows.length);
  return vmEnvelope(ctx, { filename: 'transaction_master', columns: _VWTX_EXPORT_COLUMNS.slice(), rows: built.rows, legs: selected.length, count: built.rows.length }, []);
}
