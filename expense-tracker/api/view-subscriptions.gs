// =============================================================================
// FULCRUM FORGE — Subscriptions view: list view model + form options
//
// GET list_subscriptions_view     → filtered / sorted / paged rows with schedule
//                                   status, next payment, due-in days, monthly
//                                   equivalent (native + quote), allowed_actions,
//                                   facets and the section summary.
// GET get_subscription_form_options → eligible category tree, source accounts,
//                                   frequencies, day labels (edit: pass `id`).
// Schedules come from listSubscriptions() (subscription-core.gs); this file
// never recomputes next_payment_date / schedule_status.
// Globals in this file use the vwSub / _vwSub prefix.
// =============================================================================

const _VWSUB_FREQUENCY_SHORT = { weekly: 'wk', monthly: 'mo', quarterly: 'qtr', annual: 'yr' };
const _VWSUB_DAYS_OF_WEEK = [
  { value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' }, { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' }, { value: '5', label: 'Friday' }, { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];
const _VWSUB_SORT_COLUMNS = ['next_payment_date', 'subscription_name', 'account_name', 'amount_monthly_quote', 'frequency', 'record_status'];
const _VWSUB_DEFAULT_TIMEZONE = 'Europe/London';

function viewSubscriptionsRegister(actions) {
  actions.list_subscriptions_view = { handler: function(ctx) { return vwSubListView(ctx); }, cache: true, ttl: 300 };
  actions.get_subscription_form_options = { handler: function(ctx) { return vwSubFormOptions(ctx); }, cache: true, ttl: 600 };
}

function _vwSubText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _vwSubTitle(value) {
  const text = _vwSubText(value);
  return text === '' ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

// 'money-out' → 'Money Out' (same labels as getCategorySchemaForClient().types).
function _vwSubTypeLabel(value) {
  return _vwSubText(value).split('-').map(function(word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(' ');
}

// Monthly equivalent of a decimal amount: weekly × 52 ÷ 12, quarterly ÷ 3, annual ÷ 12.
function vwSubMonthlyAmount(amount, frequency) {
  if (!isFiniteDecimal(amount)) return NaN;
  const n = Number(amount);
  if (frequency === 'weekly') return n * 52 / 12;
  if (frequency === 'monthly') return n;
  if (frequency === 'quarterly') return n / 3;
  if (frequency === 'annual') return n / 12;
  return NaN;
}

function vwSubIsScheduled(sub) {
  return _vwSubText(sub.record_status) === 'active' && (sub.schedule_status === 'current' || sub.schedule_status === 'upcoming');
}

// Days from "today" in the subscription's own timezone to the next payment date.
function vwSubDueInDays(nextDate, timezone, now) {
  if (!ldgIsDateKey(nextDate)) return null;
  const zone = _vwSubText(timezone) === '' ? _VWSUB_DEFAULT_TIMEZONE : _vwSubText(timezone);
  let today;
  try { today = _subscriptionLocalDate(now === undefined ? new Date() : now, zone); }
  catch (_) { return null; }
  if (!ldgIsDateKey(today)) return null;
  const toUtc = function(key) { return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))); };
  return Math.round((toUtc(nextDate) - toUtc(today)) / 86400000);
}

// Row menu by record_status: locked → Transactions only; deleted → Restore;
// otherwise Edit, Pause/Resume, Transactions, Delete.
function vwSubAllowedActions(status) {
  if (status === 'locked') return ['transactions'];
  if (status === 'deleted') return ['restore', 'transactions'];
  return ['edit', status === 'active' ? 'pause' : 'resume', 'transactions', 'delete'];
}

function _vwSubById(rows) {
  const map = Object.create(null);
  rows.forEach(function(row) {
    const id = _vwSubText(row.id).toLowerCase();
    if (id !== '' && map[id] === undefined) map[id] = row;
  });
  return map;
}

// Major label per major key (a live category wins over a deleted one).
function _vwSubMajorLabels(categories) {
  const labels = Object.create(null);
  const live = Object.create(null);
  categories.forEach(function(row) {
    const key = _vwSubText(row.major_category_key);
    if (key === '') return;
    const isLive = _vwSubText(row.record_status) !== 'deleted';
    if (labels[key] === undefined || (isLive && live[key] !== true)) {
      labels[key] = _vwSubText(row.major_category_label) === '' ? key : _vwSubText(row.major_category_label);
      live[key] = isLive;
    }
  });
  return labels;
}

function _vwSubCategoryLabels(categories) {
  const labels = Object.create(null);
  categories.forEach(function(row) {
    const key = [row.tx_type_key, row.major_category_key, row.minor_category_key].map(_vwSubText).join('|');
    if (labels[key] !== undefined && _vwSubText(row.record_status) === 'deleted') return;
    labels[key] = (_vwSubText(row.major_category_label) || _vwSubText(row.major_category_key)) + ' → '
      + (_vwSubText(row.minor_category_label) || _vwSubText(row.minor_category_key));
  });
  return labels;
}

// One ready-to-render row. Keeps every stored field (edit form, export, mutations).
function _vwSubRow(sub, accountsById, categoryLabels, fx, now) {
  const account = accountsById[_vwSubText(sub.source_account).toLowerCase()];
  const currency = account === undefined ? '' : _vwSubText(account.account_currency_local).toUpperCase();
  const status = _vwSubText(sub.record_status);
  const monthly = vwSubMonthlyAmount(sub.subscription_amount_local, sub.frequency);
  const scheduled = vwSubIsScheduled(sub);
  const nextDate = _vwSubText(sub.next_payment_date);
  const monthlyMoney = fxMoney(Number.isFinite(monthly) ? monthly : null, currency, fx);
  const categoryKey = [sub.tx_type, sub.major_category, sub.minor_category].map(_vwSubText).join('|');
  const row = Object.assign({}, sub, {
    row_num: sub._row,
    account_name: account === undefined ? '' : _vwSubText(account.account_name),
    account_currency: currency,
    currency_symbol: fxSymbol(currency, fx.symbols),
    amount: fxMoney(isFiniteDecimal(sub.subscription_amount_local) ? Number(sub.subscription_amount_local) : null, currency, fx),
    frequency_label: _vwSubTitle(sub.frequency),
    frequency_short: _VWSUB_FREQUENCY_SHORT[sub.frequency] !== undefined ? _VWSUB_FREQUENCY_SHORT[sub.frequency] : (_vwSubText(sub.frequency) === '' ? '—' : _vwSubText(sub.frequency)),
    monthly: monthlyMoney,
    amount_monthly_quote: monthlyMoney.quote,
    is_foreign: currency !== '' && currency !== fx.quote_currency,
    category_label: categoryLabels[categoryKey] !== undefined ? categoryLabels[categoryKey] : '',
    is_scheduled: scheduled,
    next_payment_date: nextDate,
    due_in_days: scheduled && nextDate !== '' ? vwSubDueInDays(nextDate, sub.subscription_timezone_local, now) : null,
    allowed_actions: vwSubAllowedActions(status),
    readonly: status === 'locked' || status === 'deleted',
    transactions_search: _vwSubText(sub.counterparty_name) !== '' ? _vwSubText(sub.counterparty_name) : _vwSubText(sub.subscription_name),
  });
  return row;
}

// ── Params ────────────────────────────────────────────────────────────────────

function _vwSubInvalid(field, message) {
  return vmError('invalid_filter', field, message);
}

// '' → all statuses; 'none' → empty selection; csv otherwise.
function _vwSubStatuses(value, allowed) {
  const text = _vwSubText(value);
  if (text === '') return { ok: true, value: allowed.slice(), all: true };
  if (text === 'none') return { ok: true, value: [], all: false };
  const list = text.split(',').map(_vwSubText).filter(function(item) { return item !== ''; });
  for (let i = 0; i < list.length; i++) {
    if (allowed.indexOf(list[i]) === -1) return { ok: false, error: _vwSubInvalid('statuses', 'Choose statuses from the list.') };
  }
  return { ok: true, value: list, all: allowed.every(function(item) { return list.indexOf(item) !== -1; }) };
}

// page_size: '' | 'all' → every row; else an integer 1..500. page: integer ≥ 1.
function _vwSubPaging(params) {
  const sizeText = _vwSubText(params.page_size);
  let size = null;
  if (sizeText !== '' && sizeText !== 'all') {
    if (!/^\d+$/.test(sizeText) || Number(sizeText) < 1 || Number(sizeText) > 500)
      return { ok: false, error: vmError('invalid_page', 'page_size', 'Page size must be a whole number from 1 to 500, or all.') };
    size = Number(sizeText);
  }
  const pageText = _vwSubText(params.page);
  if (pageText !== '' && (!/^\d+$/.test(pageText) || Number(pageText) < 1))
    return { ok: false, error: vmError('invalid_page', 'page', 'Page must be a whole number from 1.') };
  return { ok: true, size: size, page: pageText === '' ? 1 : Number(pageText) };
}

function _vwSubPage(rows, paging) {
  const total = rows.length;
  if (paging.size === null) return { rows: rows, total: total, page: 1, page_size: 'all', pages: 1 };
  const pages = Math.max(1, Math.ceil(total / paging.size));
  const page = Math.min(paging.page, pages);
  return { rows: rows.slice((page - 1) * paging.size, page * paging.size), total: total, page: page, page_size: paging.size, pages: pages };
}

function _vwSubCompare(col, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return function(a, b) {
    let result = 0;
    if (col === 'amount_monthly_quote') {
      const va = a.amount_monthly_quote, vb = b.amount_monthly_quote;
      const aMissing = va === null || !Number.isFinite(va), bMissing = vb === null || !Number.isFinite(vb);
      if (aMissing && bMissing) result = 0;
      else if (aMissing) return 1;          // missing conversions last in both directions
      else if (bMissing) return -1;
      else result = (va - vb) * sign;
    } else if (col === 'next_payment_date') {
      const va = a.next_payment_date === '' ? '9999-12-31' : a.next_payment_date;
      const vb = b.next_payment_date === '' ? '9999-12-31' : b.next_payment_date;
      result = va < vb ? -sign : va > vb ? sign : 0;
    } else {
      const va = _vwSubText(a[col]).toLowerCase(), vb = _vwSubText(b[col]).toLowerCase();
      result = va < vb ? -sign : va > vb ? sign : 0;
    }
    return result !== 0 ? result : a.row_num - b.row_num;
  };
}

// ── list_subscriptions_view ───────────────────────────────────────────────────

// Pure builder: subs = listSubscriptions() rows, accounts = accounts_raw rows.
// Returns { ok:true, data, warning } or { ok:false, error } (vmError envelope).
function vwSubBuildList(subs, accounts, categories, fx, params, now) {
  const schema = getSubscriptionSchemaForClient();
  const statuses = _vwSubStatuses(params.statuses, schema.record_statuses);
  if (statuses.ok === false) return { ok: false, error: statuses.error };
  const frequency = _vwSubText(params.frequency) === '' ? 'all' : _vwSubText(params.frequency);
  if (frequency !== 'all' && schema.frequencies.indexOf(frequency) === -1) return { ok: false, error: _vwSubInvalid('frequency', 'Choose a frequency from the list.') };
  const major = _vwSubText(params.major) === '' ? 'all' : _vwSubText(params.major);
  const search = _vwSubText(params.search);
  const sortCol = _vwSubText(params.sort_col) === '' ? 'next_payment_date' : _vwSubText(params.sort_col);
  if (_VWSUB_SORT_COLUMNS.indexOf(sortCol) === -1) return { ok: false, error: vmError('invalid_sort', 'sort_col', 'Choose a column to sort by from the table headings.') };
  const sortDir = _vwSubText(params.sort_dir) === '' ? 'asc' : _vwSubText(params.sort_dir);
  if (sortDir !== 'asc' && sortDir !== 'desc') return { ok: false, error: vmError('invalid_sort', 'sort_dir', 'Sort direction must be asc or desc.') };
  const paging = _vwSubPaging(params);
  if (paging.ok === false) return { ok: false, error: paging.error };

  const accountsById = _vwSubById(accounts);
  const categoryLabels = _vwSubCategoryLabels(categories);
  const all = subs.map(function(sub) { return _vwSubRow(sub, accountsById, categoryLabels, fx, now); });

  // Summary covers every subscription (not the filtered set), as the section shows it.
  let estimate = 0, missing = 0, scheduledCount = 0;
  const missingCurrencies = [];
  all.forEach(function(row) {
    if (!row.is_scheduled) return;
    scheduledCount++;
    if (row.monthly.quote === null) {
      missing++;
      if (row.account_currency !== '') missingCurrencies.push(row.account_currency);
      return;
    }
    estimate += row.monthly.quote;
  });

  const query = search.toLowerCase();
  const filtered = all.filter(function(row) {
    if (statuses.value.indexOf(_vwSubText(row.record_status)) === -1) return false;
    if (major !== 'all' && _vwSubText(row.major_category) !== major) return false;
    if (frequency !== 'all' && row.frequency !== frequency) return false;
    if (query !== '') {
      const hay = (_vwSubText(row.subscription_name) + ' ' + _vwSubText(row.counterparty_name) + ' ' + _vwSubText(row.description)).toLowerCase();
      if (hay.indexOf(query) === -1) return false;
    }
    return true;
  }).sort(_vwSubCompare(sortCol, sortDir));
  const paged = _vwSubPage(filtered, paging);

  const majorLabels = _vwSubMajorLabels(categories);
  const majorKeys = [];
  subs.forEach(function(sub) {
    const key = _vwSubText(sub.major_category);
    if (key !== '' && majorKeys.indexOf(key) === -1) majorKeys.push(key);
  });
  const majors = majorKeys.map(function(key) { return { key: key, label: majorLabels[key] !== undefined ? majorLabels[key] : key }; })
    .sort(function(a, b) { return a.label.localeCompare(b.label) || a.key.localeCompare(b.key); });

  let activeFilters = 0;
  if (!statuses.all) activeFilters++;
  if (major !== 'all') activeFilters++;
  if (frequency !== 'all') activeFilters++;
  if (search !== '') activeFilters++;

  return {
    ok: true,
    warning: fxMissingRateWarning(missingCurrencies, fx),
    data: {
      summary: {
        scheduled_count: scheduledCount,
        total_count: all.length,
        est_monthly_quote: estimate,
        missing_rate_count: missing,
        partial: missing > 0,
      },
      rows: paged.rows,
      total: paged.total,
      page: paged.page,
      page_size: paged.page_size,
      pages: paged.pages,
      sort: { col: sortCol, dir: sortDir },
      filters: { statuses: statuses.value, major: major, frequency: frequency, search: search },
      active_filter_count: activeFilters,
      facets: {
        majors: majors,
        frequencies: schema.frequencies.map(function(value) { return { value: value, label: _vwSubTitle(value) }; }),
        statuses: schema.record_statuses.map(function(value) { return { value: value, label: _vwSubTitle(value) }; }),
      },
    },
  };
}

function vwSubListView(ctx) {
  const built = vwSubBuildList(vmLoad('subscriptions'), vmLoad('accounts_raw'), vmLoad('categories'), vmFx(ctx), ctx.params, new Date());
  if (built.ok === false) return built.error;
  return vmEnvelope(ctx, built.data, [built.warning]);
}

// ── get_subscription_form_options ─────────────────────────────────────────────

// tx_type → majors → minors of subscription-eligible, non-deleted categories.
// An entry is active only when the category is active and eligible (a major
// when any of its minors is). The edited record's stored keys stay visible as
// { stored:true, active:false } when they are no longer eligible.
function _vwSubCategoryTree(categories, txTypes, stored) {
  const tree = Object.create(null);
  txTypes.forEach(function(type) { tree[type] = { tx_type: type, label: _vwSubTypeLabel(type), majors: [] }; });
  const majors = Object.create(null);
  categories.forEach(function(row) {
    const type = _vwSubText(row.tx_type_key), major = _vwSubText(row.major_category_key), minor = _vwSubText(row.minor_category_key);
    if (tree[type] === undefined || major === '' || minor === '') return;
    const status = _vwSubText(row.record_status);
    const eligible = toBool(row.is_subscription_eligible) === true;
    const storedMajor = stored !== null && stored.tx_type === type && stored.major_category === major;
    const storedMinor = storedMajor && stored.minor_category === minor;
    if (!storedMajor && (!eligible || status === 'deleted')) return;
    const majorKey = type + '|' + major;
    if (majors[majorKey] === undefined) {
      majors[majorKey] = { key: major, label: _vwSubText(row.major_category_label) === '' ? major : _vwSubText(row.major_category_label), active: false, stored: false, minors: [] };
      tree[type].majors.push(majors[majorKey]);
    }
    const entry = majors[majorKey];
    if (storedMajor) entry.stored = true;
    const active = status === 'active' && eligible;
    if (active) entry.active = true;
    if (!storedMinor && (!eligible || status === 'deleted')) return;
    if (entry.minors.some(function(item) { return item.key === minor; })) return;
    entry.minors.push({ key: minor, label: _vwSubText(row.minor_category_label) === '' ? minor : _vwSubText(row.minor_category_label), active: active, stored: storedMinor });
  });
  return txTypes.map(function(type) {
    // A stored major with no eligible minor left is kept only for the stored record.
    tree[type].majors = tree[type].majors.filter(function(major) { return major.minors.length > 0 || major.stored; });
    return tree[type];
  });
}

function _vwSubSourceAccounts(accounts, currentId, fx) {
  const current = _vwSubText(currentId).toLowerCase();
  return accounts.filter(function(account) {
    const id = _vwSubText(account.id);
    if (id === '') return false;
    return _vwSubText(account.record_status) === 'active' || (current !== '' && id.toLowerCase() === current);
  }).map(function(account) {
    const status = _vwSubText(account.record_status);
    const currency = _vwSubText(account.account_currency_local).toUpperCase();
    return {
      id: _vwSubText(account.id), account_name: _vwSubText(account.account_name), currency: currency,
      currency_symbol: fxSymbol(currency, fx.symbols), record_status: status, active: status === 'active',
      label: _vwSubText(account.account_name) + ' (' + currency + ')' + (status === 'active' ? '' : ' — ' + status),
    };
  });
}

// Pure builder. params.id (optional) names the subscription being edited.
function vwSubBuildFormOptions(subs, accounts, categories, fx, params) {
  const schema = getSubscriptionSchemaForClient();
  const id = _vwSubText(params.id);
  let current = null;
  if (id !== '') {
    if (subscriptionUuid(id) === null) return { ok: false, error: vmError('invalid_id', 'id') };
    const match = subs.find(function(sub) { return _vwSubText(sub.id).toLowerCase() === id.toLowerCase(); });
    if (match === undefined) return { ok: false, error: vmError('invalid_row', 'id') };
    current = {
      id: _vwSubText(match.id), row_num: match._row, source_account: _vwSubText(match.source_account),
      tx_type: _vwSubText(match.tx_type), major_category: _vwSubText(match.major_category), minor_category: _vwSubText(match.minor_category),
    };
  }
  return {
    ok: true,
    data: {
      tx_types: schema.tx_types.map(function(value) { return { value: value, label: _vwSubTypeLabel(value) }; }),
      frequencies: schema.frequencies.map(function(value) { return { value: value, label: _vwSubTitle(value), short: _VWSUB_FREQUENCY_SHORT[value] }; }),
      days_of_week: _VWSUB_DAYS_OF_WEEK.map(function(day) { return { value: day.value, label: day.label }; }),
      day_of_month: { min: 1, max: 31 },
      default_frequency: 'monthly',
      default_timezone: schema.default_timezone,
      record_statuses: schema.record_statuses.slice(),
      categories: _vwSubCategoryTree(categories, schema.tx_types, current),
      source_accounts: _vwSubSourceAccounts(accounts, current === null ? '' : current.source_account, fx),
      current: current,
    },
  };
}

function vwSubFormOptions(ctx) {
  const built = vwSubBuildFormOptions(vmLoad('subscriptions'), vmLoad('accounts_raw'), vmLoad('categories'), vmFx(ctx), ctx.params);
  if (built.ok === false) return built.error;
  return vmEnvelope(ctx, built.data, []);
}
