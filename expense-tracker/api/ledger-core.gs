// =============================================================================
// FULCRUM FORGE — Ledger core: balance replay, snapshots, periods, transfer pairs
//
// Ported from app/sections/insights/insight-utils.js (_balanceEvents,
// _balanceSnapshots, accountBalanceByMonth, computeBalancesAt,
// computeDailyTotalAssets, getPeriodBounds), app/core/daterange.js and
// app/core/date-utils.js. Current balances follow _buildAccountNetMap
// (account-core.gs) exactly so ledger totals equal listAccounts().
//
// Rules:
// - Tracking start: accountLocalDateTimeKey (date-only / HH:MM allowed). For an
//   account with local_timezone the cutoff is compared as a UTC instant;
//   without a zone (legacy) wall-time keys are compared.
// - Transaction dates: strict localDateTimeKey (seconds required); blank
//   tx_timezone_local means Europe/London. Rows without seconds are skipped.
// - Movement: non-deleted, known account, finite amount > 0, money-in (+) or
//   money-out (-). Transfer legs are included (they move balances).
// - Dated snapshots bucket each event by calendar date: for zoned accounts the
//   instant's date in the request tz, for legacy accounts the wall date.
// - Period filters / income-spend buckets use the recorded wall date
//   (ldgTxDateKey); "today" is the zoned today of the request tz.
//   "Balance at D" = all events with date key <= D. No new Date(string) parsing.
// - Income / spend eligibility excludes deleted rows and own-account transfers.
// All amounts are native (account currency); convert with fx-utils.gs.
// Globals in this file use the ldg / _ldg prefix.
// =============================================================================

const LDG_DEFAULT_TIMEZONE = 'Europe/London';
const _LDG_MEMO_LIMIT = 20000;
const _ldgFormatters = new Map();
const _ldgInstantMemo = new Map();

function _ldgText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _ldgFormatter(timezone) {
  if (_ldgFormatters.has(timezone)) return _ldgFormatters.get(timezone);
  const formatter = ianaDateFormatter(timezone);
  _ldgFormatters.set(timezone, formatter);
  return formatter;
}

// Unique UTC instant (ms) of a 'YYYY-MM-DD HH:MM:SS[.ffffff]' wall key in a
// zone, or NaN for gaps, folds, invalid zones. Reuses localWallTimeCandidates.
function _ldgWallInstant(key, timezone) {
  const memoKey = timezone + '|' + key;
  if (_ldgInstantMemo.has(memoKey)) return _ldgInstantMemo.get(memoKey);
  let result = NaN;
  try {
    const matches = localWallTimeCandidates(key, timezone);
    if (matches.length === 1) result = matches[0] + Number('0.' + (key.length > 20 ? key.slice(20) : '0')) * 1000;
  } catch (_) { result = NaN; }
  if (_ldgInstantMemo.size >= _LDG_MEMO_LIMIT) _ldgInstantMemo.clear();
  _ldgInstantMemo.set(memoKey, result);
  return result;
}

// 'YYYY-MM-DD' of an instant in a zone.
function ldgDateKeyInZone(instant, timezone) {
  const parts = zonedDateParts(new Date(Math.floor(instant)), _ldgFormatter(timezone));
  return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
}

// ── Calendar-key arithmetic (UTC date math on 'YYYY-MM-DD') ──────────────────

function ldgIsDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const calendar = localCalendarDate(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

function _ldgKey(date) {
  return String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
}

function _ldgDate(key) {
  return localCalendarDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}

function ldgAddDays(key, days) {
  const date = _ldgDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return _ldgKey(date);
}

// First day of the month `months` away from key's month.
function ldgMonthStart(key, months) {
  const shift = months === undefined ? 0 : months;
  return _ldgKey(localCalendarDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + shift, 1));
}

function ldgMonthEnd(key, months) {
  const shift = months === undefined ? 0 : months;
  return _ldgKey(localCalendarDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)) + shift, 0));
}

// Inclusive day count between two date keys.
function ldgDaysBetween(fromKey, toKey) {
  return Math.round((_ldgDate(toKey).getTime() - _ldgDate(fromKey).getTime()) / 86400000) + 1;
}

// Ordered 'YYYY-MM-DD' keys from → to inclusive.
function ldgDateKeys(fromKey, toKey) {
  const keys = [];
  if (!ldgIsDateKey(fromKey) || !ldgIsDateKey(toKey) || fromKey > toKey) return keys;
  for (let key = fromKey; key <= toKey; key = ldgAddDays(key, 1)) keys.push(key);
  return keys;
}

// Ordered 'YYYY-MM' keys spanning from → to inclusive (ports monthRange).
function ldgMonthKeys(fromKey, toKey) {
  const keys = [];
  if (!ldgIsDateKey(fromKey) || !ldgIsDateKey(toKey) || fromKey > toKey) return keys;
  for (let key = ldgMonthStart(fromKey); key <= toKey; key = ldgMonthStart(key, 1)) keys.push(key.slice(0, 7));
  return keys;
}

// ISO weekday 1 (Mon) .. 7 (Sun).
function _ldgIsoWeekday(key) {
  const day = _ldgDate(key).getUTCDay();
  return day === 0 ? 7 : day;
}

// ── Periods ───────────────────────────────────────────────────────────────────
// Product decision (DUMB-UI-CONTRACT): periods are inclusive of today.
// - last_N (days)    : today and the N-1 days before.
// - this_week        : Monday .. today;   last_week    : full previous Mon..Sun.
// - this_month       : 1st .. today;      last_month   : full previous month.
// - last_3/6/12      : the N calendar months ending with the current month, to today.
// - this_quarter     : quarter start .. today; last_quarter : full previous quarter.
// - ytd              : 1 Jan .. today;    last_year    : full previous year.
// - all              : unbounded start (from null) .. today.
// - custom           : from/to 'YYYY-MM-DD'; blank from = unbounded, blank to = today.
// Compare ranges are calendar aligned: day windows use the previous span of
// equal length; week/month/quarter/year periods shift by one period and keep
// the same number of elapsed days for to-date periods; last_N months compare
// with the N full months before. 'all' has no compare range.
const LDG_PERIODS = ['this_week', 'last_week', 'last_7', 'last_30', 'last_60', 'last_90', 'this_month', 'last_month',
  'last_3', 'last_6', 'last_12', 'this_quarter', 'last_quarter', 'ytd', 'last_year', 'all', 'custom'];

const LDG_PERIOD_LABELS = {
  this_week: 'This week', last_week: 'Last week', last_7: 'Last 7 days', last_30: 'Last 30 days',
  last_60: 'Last 60 days', last_90: 'Last 90 days', this_month: 'This month', last_month: 'Last month',
  last_3: 'Last 3 months', last_6: 'Last 6 months', last_12: 'Last 12 months', this_quarter: 'This quarter',
  last_quarter: 'Last quarter', ytd: 'Year to date', last_year: 'Last year', all: 'All time', custom: 'Custom range',
};

function _ldgSameElapsed(compareFrom, days, compareEndLimit) {
  const to = ldgAddDays(compareFrom, days - 1);
  return to > compareEndLimit ? compareEndLimit : to;
}

// Returns { key, label, from, to, days, compare_from, compare_to } or null
// (unknown period, invalid today, invalid/inverted custom dates).
function ldgPeriodBounds(period, todayKey, customFrom, customTo) {
  if (!ldgIsDateKey(todayKey) || LDG_PERIODS.indexOf(period) === -1) return null;
  const today = todayKey;
  let from = null, to = today, compareFrom = null, compareTo = null;
  const dayWindow = { last_7: 7, last_30: 30, last_60: 60, last_90: 90 };
  const monthWindow = { last_3: 3, last_6: 6, last_12: 12 };
  if (dayWindow[period] !== undefined) {
    from = ldgAddDays(today, -(dayWindow[period] - 1));
  } else if (period === 'this_week' || period === 'last_week') {
    const monday = ldgAddDays(today, -(_ldgIsoWeekday(today) - 1));
    if (period === 'this_week') { from = monday; }
    else { from = ldgAddDays(monday, -7); to = ldgAddDays(monday, -1); }
    compareFrom = ldgAddDays(from, -7); compareTo = ldgAddDays(to, -7);
  } else if (period === 'this_month' || period === 'last_month') {
    if (period === 'this_month') { from = ldgMonthStart(today); }
    else { from = ldgMonthStart(today, -1); to = ldgMonthEnd(today, -1); }
    compareFrom = ldgMonthStart(from, -1);
    compareTo = period === 'this_month' ? _ldgSameElapsed(compareFrom, ldgDaysBetween(from, to), ldgMonthEnd(compareFrom)) : ldgMonthEnd(compareFrom);
  } else if (monthWindow[period] !== undefined) {
    from = ldgMonthStart(today, -(monthWindow[period] - 1));
    compareFrom = ldgMonthStart(from, -monthWindow[period]); compareTo = ldgAddDays(from, -1);
  } else if (period === 'this_quarter' || period === 'last_quarter') {
    const month = Number(today.slice(5, 7)) - 1;
    const quarterStart = ldgMonthStart(today, -(month % 3));
    if (period === 'this_quarter') { from = quarterStart; }
    else { from = ldgMonthStart(quarterStart, -3); to = ldgAddDays(quarterStart, -1); }
    compareFrom = ldgMonthStart(from, -3);
    compareTo = period === 'this_quarter' ? _ldgSameElapsed(compareFrom, ldgDaysBetween(from, to), ldgAddDays(from, -1)) : ldgAddDays(from, -1);
  } else if (period === 'ytd' || period === 'last_year') {
    const year = today.slice(0, 4);
    if (period === 'ytd') { from = year + '-01-01'; }
    else { from = String(Number(year) - 1).padStart(4, '0') + '-01-01'; to = String(Number(year) - 1).padStart(4, '0') + '-12-31'; }
    compareFrom = String(Number(from.slice(0, 4)) - 1).padStart(4, '0') + '-01-01';
    compareTo = period === 'ytd' ? _ldgSameElapsed(compareFrom, ldgDaysBetween(from, to), compareFrom.slice(0, 4) + '-12-31') : compareFrom.slice(0, 4) + '-12-31';
  } else if (period === 'all') {
    from = null;
  } else if (period === 'custom') {
    const rawFrom = _ldgText(customFrom), rawTo = _ldgText(customTo);
    if (rawFrom !== '' && !ldgIsDateKey(rawFrom)) return null;
    if (rawTo !== '' && !ldgIsDateKey(rawTo)) return null;
    from = rawFrom === '' ? null : rawFrom;
    to = rawTo === '' ? today : rawTo;
    if (from !== null && from > to) return null;
  }
  if (from !== null && compareFrom === null && period !== 'all') {
    const days = ldgDaysBetween(from, to);
    compareTo = ldgAddDays(from, -1);
    compareFrom = ldgAddDays(compareTo, -(days - 1));
  }
  return {
    key: period, label: LDG_PERIOD_LABELS[period], from: from, to: to,
    days: from === null ? null : ldgDaysBetween(from, to),
    compare_from: compareFrom, compare_to: compareTo,
  };
}

// True when a date key lies in [from, to]; null from = unbounded; null key = false.
function ldgInRange(dateKey, fromKey, toKey) {
  if (dateKey === null || dateKey === undefined || dateKey === '') return false;
  if (fromKey !== null && fromKey !== undefined && dateKey < fromKey) return false;
  if (toKey !== null && toKey !== undefined && dateKey > toKey) return false;
  return true;
}

// ── Transaction dates ─────────────────────────────────────────────────────────

// Strict wall key (seconds required), or null.
function ldgTxLocalKey(tx) {
  return localDateTimeKey(sheetLocalDateTimeText(tx.tx_date_local));
}

function ldgTxZone(tx) {
  const zone = _ldgText(tx.tx_timezone_local);
  return zone === '' ? LDG_DEFAULT_TIMEZONE : zone;
}

// Calendar date of a transaction for period filters and income/spend buckets:
// the RECORDED wall date (the date the row displays), as the old client
// (daterange.js txInRange, insight-utils groupBy*) and the legacy balance replay
// use. A row shown as D therefore always falls inside a filter containing D.
// Returns null for an invalid tx_date_local (such rows never fall in a period).
function ldgTxDateKey(tx) {
  const key = ldgTxLocalKey(tx);
  return key === null ? null : key.slice(0, 10);
}

// Alternative: the row's instant (its own zone, blank = Europe/London)
// re-expressed as a calendar date in the request tz. Falls back to the wall
// date when the zones match or the wall time cannot be resolved (DST gap/fold).
// Not used for filters; available for views that need viewer-day buckets.
function ldgTxZonedDateKey(tx, timezone) {
  const key = ldgTxLocalKey(tx);
  if (key === null) return null;
  const zone = ldgTxZone(tx);
  const tz = _ldgText(timezone) === '' ? LDG_DEFAULT_TIMEZONE : _ldgText(timezone);
  if (zone === tz) return key.slice(0, 10);
  const instant = _ldgWallInstant(key, zone);
  if (!Number.isFinite(instant)) return key.slice(0, 10);
  return ldgDateKeyInZone(instant, tz);
}

// ── Transfer pairing ──────────────────────────────────────────────────────────

// Ports transactions.js _buildSiblingMap (ids compared case-insensitively):
// a child maps to its parent; a parent maps to its child, and an old deleted
// child never hides a current leg. live_child_parents holds parents that have
// at least one non-deleted child.
function ldgPairLegs(txs) {
  const byId = Object.create(null);
  (txs || []).forEach(function(tx) { const id = _ldgText(tx.id).toLowerCase(); if (id !== '') byId[id] = tx; });
  const sibling = Object.create(null);
  const liveChildParents = Object.create(null);
  (txs || []).forEach(function(tx) {
    const parentId = _ldgText(tx.parent_tx_id).toLowerCase();
    if (parentId === '') return;
    if (_ldgText(tx.record_status) !== 'deleted') liveChildParents[parentId] = true;
    const parent = byId[parentId];
    if (parent === undefined) return;
    const childId = _ldgText(tx.id).toLowerCase();
    if (childId !== '') sibling[childId] = parent;
    if (sibling[parentId] === undefined || _ldgText(sibling[parentId].record_status) === 'deleted') sibling[parentId] = tx;
  });
  return { sibling_by_id: sibling, live_child_parents: liveChildParents };
}

function ldgSibling(tx, pairs) {
  const sibling = pairs.sibling_by_id[_ldgText(tx.id).toLowerCase()];
  return sibling === undefined ? null : sibling;
}

// Own-account transfer leg: a child (parent_tx_id set, whatever the parent's
// state) or a parent with a live child. A parent whose only child is deleted
// is an ordinary movement.
function ldgIsTransferLeg(tx, pairs) {
  if (_ldgText(tx.parent_tx_id) !== '') return true;
  return pairs.live_child_parents[_ldgText(tx.id).toLowerCase()] === true;
}

// Product decision: income / spending / cash-flow exclude deleted rows and
// transfers between own accounts.
function ldgIsFlowEligible(tx, pairs) {
  return _ldgText(tx.record_status) !== 'deleted' && !ldgIsTransferLeg(tx, pairs);
}

// 'income' | 'spend' | null for flow-eligible rows.
function ldgFlowKind(tx, pairs) {
  if (!ldgIsFlowEligible(tx, pairs)) return null;
  const type = _ldgText(tx.tx_type);
  if (type === 'money-in') return 'income';
  if (type === 'money-out') return 'spend';
  return null;
}

// ── Balance replay ────────────────────────────────────────────────────────────

// Mirrors _buildAccountNetMap's tracking-start handling.
// Returns { zone, key, cutoff, valid }: key = wall key, cutoff = comparable key
// (UTC key for zoned accounts, wall key for legacy), both null when blank.
function ldgAccountCutoff(account) {
  const zone = _ldgText(account.local_timezone);
  const text = sheetLocalDateTimeText(account.tracking_start_date_local);
  const key = accountLocalDateTimeKey(text);
  const cutoff = key === null || zone === '' ? key : localDateTimeUtcKey(key, zone);
  const blank = text === undefined || text === null || String(text).trim() === '';
  return { zone: zone, key: key, cutoff: cutoff, valid: blank || cutoff !== null };
}

function _ldgUtcKeyInstant(utcKey) {
  return Date.parse(utcKey.slice(0, 10) + 'T' + utcKey.slice(11, 23) + 'Z') + Number('0.' + utcKey.slice(23));
}

// Builds the replay once per request. opts.tz = request timezone for dated
// buckets (default Europe/London). Returns:
// { tz, accounts: {id: {id, currency, type, record_status, opening, valid, cutoff}},
//   order: [ids], current: {id: native net movement}, events: [{account_id, date_key, amount}],
//   invalid_account_ids: [ids] }
function ldgBuild(accounts, txs, opts) {
  const tz = opts !== undefined && opts !== null && _ldgText(opts.tz) !== '' ? _ldgText(opts.tz) : LDG_DEFAULT_TIMEZONE;
  const info = Object.create(null);
  const order = [];
  const net = Object.create(null);
  const events = [];
  const invalid = [];
  (accounts || []).forEach(function(account) {
    const id = account.id;
    const cutoff = ldgAccountCutoff(account);
    const openingRaw = account.opening_value_local;
    const opening = openingRaw === undefined || openingRaw === null || String(openingRaw).trim() === '' ? NaN : Number(openingRaw);
    info[id] = {
      id: id, currency: _ldgText(account.account_currency_local).toUpperCase(), type: _ldgText(account.type),
      record_status: _ldgText(account.record_status), opening: Number.isFinite(opening) ? opening : null,
      valid: cutoff.valid, cutoff: cutoff,
    };
    order.push(id);
    net[id] = 0;
    if (!cutoff.valid) { invalid.push(id); return; }
    if (!Number.isFinite(opening)) return;
    let openingDate = '';
    if (cutoff.key !== null) {
      openingDate = cutoff.zone === '' ? cutoff.key.slice(0, 10) : ldgDateKeyInZone(_ldgUtcKeyInstant(cutoff.cutoff), tz);
    }
    events.push({ account_id: id, date_key: openingDate, amount: opening });
  });

  (txs || []).forEach(function(tx) {
    if (String(tx.record_status) === 'deleted') return;
    const accId = String(tx.account_id === undefined || tx.account_id === null ? '' : tx.account_id).trim();
    if (accId === '' || info[accId] === undefined) return;
    const amount = Number(tx.tx_amount_local);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const account = info[accId];
    if (!account.valid) return;
    const localKey = ldgTxLocalKey(tx);
    if (localKey === null) return;
    const type = String(tx.tx_type === undefined || tx.tx_type === null ? '' : tx.tx_type).trim();
    const sign = type === 'money-in' ? 1 : type === 'money-out' ? -1 : 0;
    const cutoff = account.cutoff;
    let affects = true;
    let instant = NaN;
    if (cutoff.zone !== '') {
      instant = _ldgWallInstant(localKey, ldgTxZone(tx));
      if (cutoff.cutoff !== null) {
        const txKey = localDateTimeUtcKey(localKey, ldgTxZone(tx));
        if (txKey === null || txKey < cutoff.cutoff) affects = false;
      }
    } else if (cutoff.cutoff !== null && localKey < cutoff.cutoff) {
      affects = false;
    }
    if (!affects || sign === 0) return;
    // Current balance: every eligible movement, including future-dated rows.
    net[accId] += sign * amount;
    // Dated replay: zoned accounts need a resolvable instant (DST gaps/folds skipped).
    if (cutoff.zone !== '') {
      if (!Number.isFinite(instant)) return;
      events.push({ account_id: accId, date_key: ldgDateKeyInZone(instant, tz), amount: sign * amount });
    } else {
      events.push({ account_id: accId, date_key: localKey.slice(0, 10), amount: sign * amount });
    }
  });
  events.sort(function(a, b) { return a.date_key < b.date_key ? -1 : a.date_key > b.date_key ? 1 : 0; });
  return { tz: tz, accounts: info, order: order, current: net, events: events, invalid_account_ids: invalid };
}

// { id: current native balance } = opening + all eligible movements
// (null for a non-numeric opening). Equals listAccounts().current_value_local.
function ldgCurrentBalances(ledger) {
  const out = Object.create(null);
  ledger.order.forEach(function(id) {
    const account = ledger.accounts[id];
    out[id] = account.opening === null ? null : account.opening + ledger.current[id];
  });
  return out;
}

// Balances at the end of each date key (any order); returns an array aligned
// with dateKeys of { id: native balance }. Invalid tracking → balance 0.
function ldgSnapshots(ledger, dateKeys) {
  const indexed = dateKeys.map(function(key, index) { return { key: key, index: index }; });
  indexed.sort(function(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  const balances = Object.create(null);
  ledger.order.forEach(function(id) { balances[id] = 0; });
  const out = new Array(dateKeys.length);
  let eventIndex = 0;
  indexed.forEach(function(item) {
    while (eventIndex < ledger.events.length && ledger.events[eventIndex].date_key <= item.key) {
      const event = ledger.events[eventIndex++];
      balances[event.account_id] += event.amount;
    }
    out[item.index] = Object.assign({}, balances);
  });
  return out;
}

function ldgBalancesAt(ledger, dateKey) {
  return ldgSnapshots(ledger, [dateKey])[0];
}

// { 'YYYY-MM': { id: native balance at month end } } (ports accountBalanceByMonth).
function ldgBalanceByMonth(ledger, monthKeys) {
  const ordered = monthKeys.slice().sort();
  const ends = ordered.map(function(month) { return ldgMonthEnd(month + '-01'); });
  const snapshots = ldgSnapshots(ledger, ends);
  const out = {};
  ordered.forEach(function(month, index) { out[month] = snapshots[index]; });
  return out;
}

// Sums native balances in the quote currency. filter(accountInfo) selects
// accounts (default: all). Accounts whose currency has no rate are excluded
// and listed in missing_currencies (never converted 1:1).
function ldgSumQuote(ledger, balances, fx, filter) {
  let total = 0;
  const missing = Object.create(null);
  ledger.order.forEach(function(id) {
    const account = ledger.accounts[id];
    if (filter !== undefined && filter !== null && !filter(account)) return;
    const native = balances[id];
    if (native === null || native === undefined || !Number.isFinite(native)) return;
    const quote = fxToQuote(native, account.currency, fx.rate_map, fx.quote_currency);
    if (!Number.isFinite(quote)) { missing[account.currency === '' ? '(blank)' : account.currency] = true; return; }
    total += quote;
  });
  return { total: total, missing_currencies: Object.keys(missing).sort() };
}

// Daily total balance in quote currency from → to (ports computeDailyTotalAssets).
// Returns { dates: [...], totals: [...], missing_currencies: [...] }.
function ldgDailyTotals(ledger, fromKey, toKey, fx, filter) {
  const dates = ldgDateKeys(fromKey, toKey);
  const snapshots = ldgSnapshots(ledger, dates);
  let missing = [];
  const totals = snapshots.map(function(balances) {
    const sum = ldgSumQuote(ledger, balances, fx, filter);
    missing = sum.missing_currencies;
    return sum.total;
  });
  return { dates: dates, totals: totals, missing_currencies: missing };
}

// ── Net worth (product decision: one definition everywhere) ───────────────────

// All non-deleted accounts (active, inactive, locked). Assets = asset +
// investment; liabilities = liability (stored negative). total_liabilities is
// the owed magnitude (positive when owed); net_worth = assets - liabilities.
function ldgIsNetWorthAccount(account) {
  return account.record_status !== 'deleted' && (account.type === 'asset' || account.type === 'investment' || account.type === 'liability');
}

function ldgNetWorth(ledger, balances, fx) {
  const assets = ldgSumQuote(ledger, balances, fx, function(account) {
    return ldgIsNetWorthAccount(account) && account.type !== 'liability';
  });
  const liabilities = ldgSumQuote(ledger, balances, fx, function(account) {
    return ldgIsNetWorthAccount(account) && account.type === 'liability';
  });
  const missing = Object.create(null);
  assets.missing_currencies.concat(liabilities.missing_currencies).forEach(function(code) { missing[code] = true; });
  return {
    total_assets: assets.total,
    total_liabilities: -liabilities.total,
    net_worth: assets.total + liabilities.total,
    missing_currencies: Object.keys(missing).sort(),
  };
}
