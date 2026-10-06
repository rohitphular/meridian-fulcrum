// =============================================================================
// FULCRUM FORGE — Ledger core: date keys, periods, transfer pairs, tracking start
//
// What the Transactions list and input validation need.
// - Periods are inclusive of today (the list's range filter, see below).
// - Transaction dates: strict localDateTimeKey (seconds required); blank
//   tx_timezone_local means Europe/London. Filters use the recorded wall date.
// - Tracking start (ldgAccountCutoff) mirrors _buildAccountNetMap, which the
//   balance check in transaction-validation.gs uses.
// Globals in this file use the ldg / _ldg prefix.
// =============================================================================

function _ldgText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
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

// Calendar date of a transaction for period filters and income/spend buckets:
// the RECORDED wall date (the date the row displays), as the old client
// (daterange.js txInRange, insight-utils groupBy*) and the legacy balance replay
// use. A row shown as D therefore always falls inside a filter containing D.
// Returns null for an invalid tx_date_local (such rows never fall in a period).
function ldgTxDateKey(tx) {
  const key = ldgTxLocalKey(tx);
  return key === null ? null : key.slice(0, 10);
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

// ── Tracking start ────────────────────────────────────────────────────────────

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
