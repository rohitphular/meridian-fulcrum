// =============================================================================
// FULCRUM FORGE — Insights: net worth, liabilities and loans (server compute
// for get_insight)
//
// Ports (P4-D): 14-networth-trend, 15-account-balances, 16-asset-vs-liability,
// 17-liability-paydown, 26-loan-progress, 27-debt-to-income. See
// insights-registry.gs for ictx, helpers and the payload schema.
//
// Rules (product decisions, DUMB-UI-CONTRACT):
// - Accounts: ALL non-deleted accounts (active, inactive, locked). Assets =
//   asset + investment, liabilities = liability (stored negative). The old
//   client modules used active accounts only.
// - Headline figures ("now") come from insNetWorthNow / ldgCurrentBalances, so
//   they equal the list_accounts_view summary and get_home_view hero (current
//   balances include future-dated rows). Trend points are dated ledger
//   snapshots at each month end, clipped to the period end.
// - Months that end before the first tracked balance (earliest tracking start
//   of the accounts involved) are null, not a fake 0.
// - Loan repayments are own-account transfer legs (insFlows drops them), so
//   paydown / loan progress / DTI debt use ledger balances, and the repayment
//   history reads insIndex(ictx).txs directly.
// - 27 uses Home's DTI definition: owed debt now ÷ annualised average monthly
//   income over complete months (current month excluded) from the first flow
//   month; status from vwHomeDtiStatus (view-home.gs).
// Globals in this file use the _insNw prefix (compute hooks insightCompute_*,
// metadata hooks insightMeta_*).
// =============================================================================

const _INS_NW_MAX_VISIBLE_LINES = 6;
const _INS_NW_PROJECTION_POINTS = 3;
const _INS_NW_DTI_THRESHOLD = 36;
// Duplicates view-home.gs _VWHOME_DTI_LABELS (private there).
const _INS_NW_DTI_LABELS = { excellent: 'Excellent', good: 'Good', caution: 'Caution', high_risk: 'High risk', debt_free: 'Debt-free', na: 'N/A' };
const _INS_NW_DTI_TONES = { excellent: 'positive', good: 'primary', caution: 'warn', high_risk: 'negative', debt_free: 'positive', na: 'muted' };

function _insNwText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _insNwMarkMissing(ictx, codes) {
  (codes || []).forEach(function(code) { ictx.missing[code === '' ? '(blank)' : code] = true; });
}

// '£1,234' / '−£1,234.50' for text cells and subs (stat values stay numbers).
function _insNwMoney(ictx, value, dp) {
  const places = dp === undefined ? 0 : dp;
  return (value < 0 ? '−' : '') + ictx.symbol + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: places, maximumFractionDigits: places });
}

// Native amount in its own currency symbol, 2 dp: '₹10,500.00'.
function _insNwNative(ictx, value, currency) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return (value < 0 ? '−' : '') + fxSymbol(currency, ictx.fx.symbols) + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Net-worth accounts (non-deleted asset / investment / liability) in sheet
// order: [{ id, name, type, sub_type, currency, info (ledger account) }].
function _insNwAccounts(ictx, filter) {
  const ledger = insLedger(ictx);
  const byId = Object.create(null);
  vmLoad('accounts_raw').forEach(function(account) { if (byId[account.id] === undefined) byId[account.id] = account; });
  const out = [];
  ledger.order.forEach(function(id) {
    const info = ledger.accounts[id];
    if (!ldgIsNetWorthAccount(info)) return;
    if (typeof filter === 'function' && !filter(info)) return;
    const raw = byId[id] === undefined ? {} : byId[id];
    out.push({ id: id, name: _insNwText(raw.account_name) === '' ? '(unnamed)' : _insNwText(raw.account_name), type: info.type,
      sub_type: _insNwText(raw.sub_type), currency: info.currency, info: info, raw: raw });
  });
  return out;
}

function _insNwIsLiability(info) {
  return info.record_status !== 'deleted' && info.type === 'liability';
}

// Earliest dated ledger event (opening or movement) of the selected accounts:
// null when one of them has no tracking start (its opening always applies),
// today when none has any event.
function _insNwTrackedFrom(ictx, accountIds) {
  const ledger = insLedger(ictx);
  const wanted = Object.create(null);
  accountIds.forEach(function(id) { wanted[id] = true; });
  let first;
  for (let i = 0; i < ledger.events.length; i++) {
    const event = ledger.events[i];
    if (wanted[event.account_id] !== true) continue;
    if (event.date_key === '') return null;
    first = event.date_key;
    break; // events are sorted by date key
  }
  return first === undefined ? ictx.today : first;
}

// Month-end sample points of the period: { month_keys, keys (sample date keys,
// month end clipped to the period end), labels }. A period without a start
// begins at the tracked-from month.
function _insNwMonthPoints(ictx, trackedFrom) {
  const period = ictx.period;
  const to = period === null ? ictx.today : period.to;
  let from = period === null ? null : period.from;
  if (from === null) from = trackedFrom === null ? ldgMonthStart(to) : (trackedFrom < to ? trackedFrom : to);
  const monthKeys = ldgMonthKeys(from, to);
  const keys = monthKeys.map(function(month) { const end = ldgMonthEnd(month + '-01'); return end > to ? to : end; });
  return { month_keys: monthKeys, keys: keys, labels: monthKeys.map(insMonthLabel) };
}

// Net worth split at dated snapshots: [{ total_assets, total_liabilities, net_worth } | null].
function _insNwWorthSeries(ictx, keys, trackedFrom) {
  const ledger = insLedger(ictx);
  const snapshots = ldgSnapshots(ledger, keys);
  return keys.map(function(key, index) {
    if (trackedFrom !== null && key < trackedFrom) return null;
    const worth = ldgNetWorth(ledger, snapshots[index], ictx.fx);
    _insNwMarkMissing(ictx, worth.missing_currencies);
    return worth;
  });
}

function _insNwWorthAt(ictx, dateKey, trackedFrom) {
  return _insNwWorthSeries(ictx, [dateKey], trackedFrom)[0];
}

// Quote value of a native balance (null for a missing native or rate; missing
// rates go into the warning).
function _insNwQuote(ictx, native, currency) {
  if (native === null || native === undefined || !Number.isFinite(native)) return null;
  return insQuote(ictx, native, currency);
}

function _insNwTone(value) {
  return value === null ? 'neutral' : value < 0 ? 'negative' : 'positive';
}

function _insNwLastValue(values) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i];
  return null;
}

function _insNwFirstValue(values) {
  for (let i = 0; i < values.length; i++) if (values[i] !== null) return values[i];
  return null;
}

function _insNwTrackedNote(trackedFrom, values) {
  if (trackedFrom === null || !values.some(function(value) { return value === null; })) return null;
  return { text: 'Balances are tracked from ' + insDateLabel(trackedFrom) + '; earlier months are left blank.' };
}

function _insNwAccountTypeLabel(ictx, type) {
  const labels = insIndex(ictx).account_type_labels;
  return labels[type] !== undefined ? labels[type] : type;
}

function _insNwSubtypeLabels() {
  const labels = Object.create(null);
  vmLoad('account_types').forEach(function(row) {
    const key = _insNwText(row.account_subtype_key);
    if (key !== '' && labels[key] === undefined) labels[key] = _insNwText(row.account_subtype_label) === '' ? key : _insNwText(row.account_subtype_label);
  });
  return labels;
}

// ── 14 Net worth trend ────────────────────────────────────────────────────────

// Month-end net worth (all non-deleted accounts) with a balances-at-date drill.
// Headline = net worth now (Accounts / Home figure); deltas use the same value.
function insightCompute_14_networth_trend(ictx) {
  const accounts = _insNwAccounts(ictx);
  if (accounts.length === 0) return insEmpty('No accounts found.');
  const trackedFrom = _insNwTrackedFrom(ictx, accounts.map(function(account) { return account.id; }));
  const points = _insNwMonthPoints(ictx, trackedFrom);
  const series = _insNwWorthSeries(ictx, points.keys, trackedFrom);
  const values = series.map(function(worth) { return worth === null ? null : worth.net_worth; });

  const drillDate = insDrillValue(ictx, 'date');
  if (ictx.drill !== null) {
    const at = drillDate === null ? -1 : points.keys.indexOf(drillDate);
    if (at === -1 || values[at] === null) return insError('invalid_drill', 'drill');
  }

  const now = insNetWorthNow(ictx).net_worth;
  const prevEnd = ldgMonthEnd(ictx.today, -1);
  const yearEnd = ldgMonthEnd(ictx.today, -12);
  const prevWorth = _insNwWorthAt(ictx, prevEnd, trackedFrom);
  const yearWorth = _insNwWorthAt(ictx, yearEnd, trackedFrom);
  const monthDelta = prevWorth === null ? null : now - prevWorth.net_worth;
  const yearDelta = yearWorth === null ? null : now - yearWorth.net_worth;
  let yearSub = 'vs ' + insDateLabel(yearEnd);
  if (yearWorth === null) yearSub = 'Not tracked on ' + insDateLabel(yearEnd);
  else if (yearWorth.net_worth !== 0) yearSub = (yearDelta < 0 ? '−' : '+') + Math.abs(yearDelta / Math.abs(yearWorth.net_worth) * 100).toFixed(1) + '% vs ' + insDateLabel(yearEnd);

  const notes = [];
  const tracked = _insNwTrackedNote(trackedFrom, values);
  if (tracked !== null) notes.push(tracked);
  const lastPoint = _insNwLastValue(values);
  if (ictx.period !== null && ictx.period.to === ictx.today && lastPoint !== null && Math.abs(lastPoint - now) > 0.005) {
    notes.push({ text: 'Net worth now includes future-dated transactions; the chart shows balances as of each date.' });
  }

  const payload = {
    stat_cards: [
      insStat('net_worth', 'Net worth', now, 'money', 'All accounts, now', _insNwTone(now)),
      insStat('month_change', 'Change this month', monthDelta, 'money_delta', 'since ' + insDateLabel(prevEnd), _insNwTone(monthDelta)),
      insStat('year_change', 'vs 12 months ago', yearDelta, 'money_delta', yearSub, _insNwTone(yearDelta)),
    ],
    charts: [{
      id: 'net_worth', kind: 'line', labels: points.labels,
      datasets: [{ key: 'net_worth', label: 'Net worth', data: values, style: 'primary', fill: 'signed' }],
      y_format: 'money', ref_lines: [],
      drill: { param: 'date', values: points.keys.map(function(key, index) { return values[index] === null ? '' : key; }), mode: 'panel', hint: 'Tap a data point to see account balances at that date' },
    }],
    notes: notes,
    drill: null,
  };
  if (drillDate !== null) payload.drill = _insNwBalancesDrill(ictx, accounts, drillDate);
  return payload;
}

// Drill panel table: every net-worth account's balance at the end of dateKey.
function _insNwBalancesDrill(ictx, accounts, dateKey) {
  const balances = insBalancesAt(ictx, dateKey);
  const rows = accounts.map(function(account) {
    const native = balances[account.id] === undefined ? 0 : balances[account.id];
    return { account: account, native: native, quote: _insNwQuote(ictx, native, account.currency) };
  }).sort(function(a, b) {
    if (a.quote === null || b.quote === null) return a.quote === null ? (b.quote === null ? 0 : 1) : -1;
    return Math.abs(b.quote) - Math.abs(a.quote) || a.account.name.localeCompare(b.account.name);
  });
  const worth = _insNwWorthAt(ictx, dateKey, null);
  return {
    title: 'Account balances — ' + insDateLabel(dateKey),
    subtitle: rows.length + ' account' + (rows.length === 1 ? '' : 's'),
    rows: [], total_count: rows.length, shown_count: rows.length, total_quote: worth.net_worth,
    table: {
      id: 'balances',
      columns: [
        { key: 'account', label: 'Account', format: 'text', align: 'left' },
        { key: 'type', label: 'Type', format: 'text', align: 'left' },
        { key: 'native', label: 'Native', format: 'text', align: 'right' },
        { key: 'balance', label: 'Balance', format: 'money', align: 'right' },
      ],
      rows: rows.map(function(row) {
        return { key: row.account.id, tone: row.quote === null ? 'warn' : _insNwTone(row.quote),
          cells: { account: row.account.name, type: _insNwAccountTypeLabel(ictx, row.account.type), native: _insNwNative(ictx, row.native, row.account.currency), balance: row.quote } };
      }),
      total_row: { cells: { account: 'Net worth', type: '', native: '', balance: worth.net_worth } },
      sortable: [], sort: null,
    },
    query: null,
  };
}

// ── 15 Account balances ───────────────────────────────────────────────────────

// Current balances (no period): 15 always shows balances now.
function insightMeta_15_account_balances() {
  return { periods: [], default_period: null };
}

function insightCompute_15_account_balances(ictx) {
  const accounts = _insNwAccounts(ictx);
  if (accounts.length === 0) return insEmpty('No accounts found.');
  const current = ldgCurrentBalances(insLedger(ictx));
  const rows = accounts.map(function(account) {
    return { account: account, quote: _insNwQuote(ictx, current[account.id], account.currency) };
  }).filter(function(row) { return row.quote !== null; });
  const byName = function(a, b) { return a.account.name.localeCompare(b.account.name); };
  const assets = rows.filter(function(row) { return row.account.type === 'asset'; }).sort(function(a, b) { return b.quote - a.quote || byName(a, b); });
  const investments = rows.filter(function(row) { return row.account.type === 'investment'; }).sort(function(a, b) { return b.quote - a.quote || byName(a, b); });
  const liabilities = rows.filter(function(row) { return row.account.type === 'liability'; }).sort(function(a, b) { return a.quote - b.quote || byName(a, b); });
  const sum = function(list) { return list.reduce(function(total, row) { return total + row.quote; }, 0); };
  const worth = insNetWorthNow(ictx);

  const section = function(id, title, list, style, label, valueFn, emptyText) {
    return {
      id: id, kind: 'hbar', title: title, height: Math.max(80, list.length * 40 + 40),
      labels: list.map(function(row) { return row.account.name; }),
      datasets: [{ key: 'balance', label: label, data: list.map(valueFn), style: style }],
      y_format: 'money', ref_lines: [], empty_text: emptyText,
    };
  };
  const charts = [
    section('assets', 'Assets', assets, 'asset', 'Balance', function(row) { return row.quote; }, 'No asset accounts.'),
    section('liabilities', 'Liabilities (owed)', liabilities, 'liability', 'Owed', function(row) { return -row.quote; }, 'No liability accounts.'),
  ];
  if (investments.length > 0) charts.push(section('investments', 'Investments', investments, 'compare', 'Value', function(row) { return row.quote; }, ''));

  return {
    stat_cards: [
      insStat('assets', 'Assets', sum(assets), 'money', assets.length + ' account' + (assets.length === 1 ? '' : 's'), 'positive'),
      insStat('liabilities', 'Liabilities', worth.total_liabilities, 'money', liabilities.length + ' account' + (liabilities.length === 1 ? '' : 's'), 'negative'),
      insStat('investments', 'Investments', sum(investments), 'money', investments.length + ' account' + (investments.length === 1 ? '' : 's')),
      insStat('net_worth', 'Net worth', worth.net_worth, 'money', 'Assets + investments − liabilities', _insNwTone(worth.net_worth)),
    ],
    charts: charts,
  };
}

// ── 16 Assets vs liabilities ──────────────────────────────────────────────────

function insightCompute_16_asset_vs_liability(ictx) {
  const accounts = _insNwAccounts(ictx);
  if (accounts.length === 0) return insEmpty('No accounts found.');
  const trackedFrom = _insNwTrackedFrom(ictx, accounts.map(function(account) { return account.id; }));
  const points = _insNwMonthPoints(ictx, trackedFrom);
  const series = _insNwWorthSeries(ictx, points.keys, trackedFrom);
  const assets = series.map(function(worth) { return worth === null ? null : worth.total_assets; });
  const liabilities = series.map(function(worth) { return worth === null ? null : worth.total_liabilities; });
  const nets = series.map(function(worth) { return worth === null ? null : worth.net_worth; });

  const now = insNetWorthNow(ictx);
  const periodEndsToday = ictx.period === null || ictx.period.to >= ictx.today;
  const endNet = periodEndsToday ? now.net_worth : _insNwLastValue(nets);
  const startNet = _insNwFirstValue(nets);
  const change = endNet === null || startNet === null ? null : endNet - startNet;
  const firstIndex = nets.findIndex(function(value) { return value !== null; });

  const notes = [];
  const tracked = _insNwTrackedNote(trackedFrom, nets);
  if (tracked !== null) notes.push(tracked);

  return {
    stat_cards: [
      insStat('total_assets', 'Total assets', now.total_assets, 'money', 'Now', 'positive'),
      insStat('total_liabilities', 'Total liabilities', now.total_liabilities, 'money', 'Now', 'negative'),
      insStat('net_worth', 'Net worth', now.net_worth, 'money', 'Now', _insNwTone(now.net_worth)),
      insStat('period_change', 'Period Δ net', change, 'money_delta',
        firstIndex === -1 ? '' : 'since ' + insDateLabel(points.keys[firstIndex]), _insNwTone(change)),
    ],
    charts: [{
      id: 'assets_liabilities', kind: 'area', labels: points.labels,
      datasets: [
        { key: 'assets', label: 'Total assets', data: assets, style: 'asset', fill: 'origin' },
        { key: 'liabilities', label: 'Total liabilities', data: liabilities, style: 'liability', fill: 'origin', dashed: true },
      ],
      y_format: 'money', ref_lines: [],
    }],
    notes: notes,
  };
}

// ── 17 Liability paydown ──────────────────────────────────────────────────────

// Mean of the positive month-over-month reductions over the last 3 points
// (ports _projectPayoff). Returns months to clear or null.
function _insNwProjectPayoff(values) {
  const known = values.filter(function(value) { return value !== null; });
  const n = known.length;
  if (n < 2) return null;
  let total = 0, count = 0;
  for (let i = Math.max(0, n - _INS_NW_PROJECTION_POINTS); i < n - 1; i++) {
    const reduction = known[i] - known[i + 1];
    if (reduction > 0) { total += reduction; count++; }
  }
  if (count === 0) return null;
  const current = known[n - 1];
  if (current <= 0) return 0;
  return Math.ceil(current / (total / count));
}

function _insNwPayoffLabel(ictx, months) {
  return insMonthLabel(ldgMonthStart(ictx.today, months).slice(0, 7));
}

// Per liability: owed (quote, positive when owed) now, at the opening value and
// at each sample point (null before that account's tracking start).
function _insNwLiabilityRows(ictx, points) {
  const ledger = insLedger(ictx);
  const current = ldgCurrentBalances(ledger);
  const liabilities = _insNwAccounts(ictx, _insNwIsLiability);
  const snapshots = points === null ? [] : ldgSnapshots(ledger, points.keys);
  return liabilities.map(function(account) {
    const trackedFrom = _insNwTrackedFrom(ictx, [account.id]);
    const nowQuote = _insNwQuote(ictx, current[account.id], account.currency);
    const openingQuote = _insNwQuote(ictx, account.info.opening, account.currency);
    const owedSeries = points === null ? [] : points.keys.map(function(key, index) {
      if (trackedFrom !== null && key < trackedFrom) return null;
      const quote = _insNwQuote(ictx, snapshots[index][account.id], account.currency);
      return quote === null ? null : -quote;
    });
    return { account: account, tracked_from: trackedFrom, owed: nowQuote === null ? null : -nowQuote,
      original: openingQuote === null ? null : -openingQuote, series: owedSeries };
  });
}

function insightCompute_17_liability_paydown(ictx) {
  const liabilityIds = _insNwAccounts(ictx, _insNwIsLiability).map(function(account) { return account.id; });
  if (liabilityIds.length === 0) return insEmpty('No liability accounts found.');
  const points = _insNwMonthPoints(ictx, _insNwTrackedFrom(ictx, liabilityIds));
  const rows = _insNwLiabilityRows(ictx, points);
  const known = rows.filter(function(row) { return row.owed !== null; });

  const outstanding = Math.max(0, known.reduce(function(sum, row) { return sum + row.owed; }, 0));
  const startedWith = known.reduce(function(sum, row) { return sum + (row.original === null ? 0 : row.original); }, 0);
  const overallPaid = startedWith > 0 ? Math.max(0, Math.min(100, (1 - outstanding / startedWith) * 100)) : null;

  const tableRows = known.map(function(row) {
    const paid = row.original !== null && row.original > 0 ? Math.max(0, Math.min(100, (1 - row.owed / row.original) * 100)) : null;
    let projection = '—', tone = null;
    if (row.owed <= 0) { projection = 'Fully paid off'; tone = 'positive'; }
    else {
      const months = _insNwProjectPayoff(row.series);
      if (months !== null && months > 0) projection = '~' + months + ' month' + (months === 1 ? '' : 's') + ' (' + _insNwPayoffLabel(ictx, months) + ')';
    }
    const cells = { account: row.account.name, outstanding: row.owed, paid: paid, projection: projection };
    const out = { key: row.account.id, cells: cells };
    if (tone !== null) out.tone = tone;
    return out;
  });

  return {
    stat_cards: [
      insStat('outstanding', 'Outstanding', outstanding, 'money', null, 'negative'),
      insStat('started_with', 'Started with', startedWith > 0 ? startedWith : null, 'money', 'Owed at tracking start'),
      insStat('overall_paid', 'Overall paid', overallPaid, 'percent', null, overallPaid === null ? null : 'positive'),
      insStat('accounts', 'Accounts', rows.length, 'count'),
    ],
    charts: [{
      id: 'paydown', kind: 'line', height: 260, labels: points.labels,
      datasets: rows.map(function(row, index) {
        return { key: row.account.id, label: row.account.name, data: row.series, style: 'palette:' + index, hidden: index >= _INS_NW_MAX_VISIBLE_LINES };
      }),
      y_format: 'money', ref_lines: [],
    }],
    tables: [{
      id: 'progress', title: 'Paydown progress',
      columns: [
        { key: 'account', label: 'Account', format: 'text', align: 'left' },
        { key: 'outstanding', label: 'Outstanding', format: 'money', align: 'right' },
        { key: 'paid', label: 'Paid', format: 'progress' },
        { key: 'projection', label: 'Projected clear', format: 'text', align: 'right' },
      ],
      rows: tableRows, sortable: [], sort: null, empty_text: 'No liability balances to show.',
    }],
  };
}

// ── 26 Loan progress ──────────────────────────────────────────────────────────

// Current state only (no period).
function insightMeta_26_loan_progress() {
  return { periods: [], default_period: null };
}

// Repayments / credits into a liability: non-deleted money-in rows on the
// account dated on or after its tracking start (own-account transfer legs
// included — insFlows would drop them). Chronological pseudo flow rows
// { tx, quote, date_key, month_key }; rows without a rate are left out and
// reported.
function _insNwRepayments(ictx, account) {
  const index = insIndex(ictx);
  const id = account.id.toLowerCase();
  const startKey = account.info.cutoff.key === null ? null : account.info.cutoff.key.slice(0, 10);
  const out = [];
  index.txs.forEach(function(tx) {
    if (_insNwText(tx.record_status) === 'deleted' || _insNwText(tx.tx_type) !== 'money-in') return;
    if (_insNwText(tx.account_id).toLowerCase() !== id) return;
    const dateKey = ldgTxDateKey(tx);
    if (dateKey === null || dateKey > ictx.today || (startKey !== null && dateKey < startKey)) return;
    const native = Number(tx.tx_amount_local);
    if (!Number.isFinite(native) || native <= 0) return;
    const quote = insQuote(ictx, native, account.currency);
    if (quote === null) return;
    out.push({ tx: tx, quote: quote, date_key: dateKey, month_key: dateKey.slice(0, 7), local_key: ldgTxLocalKey(tx) });
  });
  return out.sort(function(a, b) { return a.local_key < b.local_key ? -1 : a.local_key > b.local_key ? 1 : 0; });
}

// Calendar months from startKey's month to today's month (at least 1).
function _insNwMonthsSince(ictx, startKey) {
  if (startKey === null) return 1;
  const months = (Number(ictx.today.slice(0, 4)) - Number(startKey.slice(0, 4))) * 12 + (Number(ictx.today.slice(5, 7)) - Number(startKey.slice(5, 7)));
  return Math.max(1, months);
}

function _insNwLoanStats(ictx, row, subtypeLabels) {
  const account = row.account;
  const repayments = _insNwRepayments(ictx, account);
  const current = row.owed === null ? 0 : row.owed;
  const original = row.original === null ? 0 : row.original;
  const hasOpening = original > 0;
  const totalRepaid = Math.max(0, original - current);
  // Average since the opening value was measured (tracking start), else the
  // account opening date, else the first repayment.
  let startKey = account.info.cutoff.key === null ? null : account.info.cutoff.key.slice(0, 10);
  if (startKey === null) {
    const opened = accountLocalDateTimeKey(sheetLocalDateTimeText(account.raw.account_opening_date_local));
    startKey = opened !== null ? opened.slice(0, 10) : (repayments.length > 0 ? repayments[0].date_key : null);
  }
  const months = _insNwMonthsSince(ictx, startKey);
  const paidOff = current <= 0;
  const avgMonthly = totalRepaid > 0 && !paidOff ? totalRepaid / months : 0;
  const monthsToPayoff = avgMonthly > 0 && current > 0 ? Math.ceil(current / avgMonthly) : null;
  return {
    account: account, subtype: subtypeLabels[account.sub_type] !== undefined ? subtypeLabels[account.sub_type] : (account.sub_type === '' ? 'Liability' : account.sub_type),
    current: current, original: original, has_opening: hasOpening, total_repaid: totalRepaid, months: months, start_key: startKey,
    avg_monthly: avgMonthly, months_to_payoff: monthsToPayoff, paid_off: paidOff, increased: hasOpening && current > original,
    pct_paid: hasOpening ? Math.min(100, totalRepaid / original * 100) : null, repayments: repayments,
  };
}

function insightCompute_26_loan_progress(ictx) {
  const rows = _insNwLiabilityRows(ictx, null).filter(function(row) { return row.owed !== null; });
  if (rows.length === 0) return insEmpty('No liability accounts found.');
  const subtypeLabels = _insNwSubtypeLabels();
  const loans = rows.map(function(row) { return _insNwLoanStats(ictx, row, subtypeLabels); });

  const drillAccount = insDrillValue(ictx, 'account');
  let drilled = null;
  if (ictx.drill !== null) {
    drilled = drillAccount === null ? null : loans.find(function(loan) { return loan.account.id === drillAccount; });
    if (drilled === undefined || drilled === null) return insError('invalid_drill', 'drill');
  }

  const totalDebt = Math.max(0, loans.reduce(function(sum, loan) { return sum + loan.current; }, 0));
  const totalRepaid = loans.reduce(function(sum, loan) { return sum + loan.total_repaid; }, 0);
  const burden = loans.reduce(function(sum, loan) { return sum + loan.avg_monthly; }, 0);
  const withPayoff = loans.filter(function(loan) { return loan.months_to_payoff !== null && !loan.paid_off; });
  const earliest = withPayoff.reduce(function(best, loan) { return best === null || loan.months_to_payoff < best.months_to_payoff ? loan : best; }, null);

  const payload = {
    stat_cards: [
      insStat('total_debt', 'Total debt', totalDebt, 'money', null, 'negative'),
      insStat('total_repaid', 'Total repaid', totalRepaid, 'money', 'Since tracking start', 'positive'),
      insStat('monthly_burden', 'Monthly paydown', burden, 'money', 'Average across loans'),
      insStat('earliest_payoff', 'Earliest payoff', earliest === null ? null : earliest.account.name, 'text',
        earliest === null ? '' : _insNwPayoffLabel(ictx, earliest.months_to_payoff)),
    ],
    tables: [{
      id: 'loans', title: 'Loans',
      columns: [
        { key: 'loan', label: 'Loan', format: 'text', align: 'left' },
        { key: 'type', label: 'Type', format: 'text', align: 'left' },
        { key: 'remaining', label: 'Remaining', format: 'money', align: 'right' },
        { key: 'original', label: 'Original', format: 'money', align: 'right' },
        { key: 'paid', label: 'Paid', format: 'progress' },
        { key: 'avg_monthly', label: 'Avg / month', format: 'money2', align: 'right' },
        { key: 'payoff', label: 'Projected payoff', format: 'text', align: 'right' },
      ],
      rows: loans.map(function(loan) {
        let payoff = '—', tone = null;
        if (loan.paid_off) { payoff = 'Paid off'; tone = 'positive'; }
        else if (loan.increased) { payoff = 'Balance increased'; tone = 'warn'; }
        else if (loan.months_to_payoff !== null) payoff = _insNwPayoffLabel(ictx, loan.months_to_payoff) + ' (~' + loan.months_to_payoff + ' mo)';
        else if (loan.avg_monthly === 0) payoff = 'No paydown yet';
        const out = {
          key: loan.account.id,
          cells: { loan: loan.account.name, type: loan.subtype + ' · ' + loan.account.currency, remaining: loan.current,
            original: loan.has_opening ? loan.original : null, paid: loan.paid_off ? 100 : loan.pct_paid, avg_monthly: loan.avg_monthly, payoff: payoff },
          drill: { param: 'account', value: loan.account.id, mode: 'panel' },
        };
        if (tone !== null) out.tone = tone;
        return out;
      }),
      sortable: [], sort: null,
    }],
    notes: [{ text: 'Paydown = owed at tracking start − owed now, averaged per month since tracking start. Tap a loan for its repayments.' }],
    drill: null,
  };
  if (drilled !== null) payload.drill = _insNwLoanDrill(ictx, drilled);
  return payload;
}

function _insNwLoanDrill(ictx, loan) {
  const drill = insDrill(ictx, loan.account.name, loan.repayments,
    insTxQuery(loan.start_key, ictx.today, { account_ids: loan.account.id, types: 'money-in' }));
  drill.subtitle = loan.repayments.length + ' repayment' + (loan.repayments.length === 1 ? '' : 's');
  let running = 0;
  const cumulative = loan.repayments.map(function(row) { running += row.quote; return running; });
  drill.charts = loan.repayments.length === 0 ? [] : [{
    id: 'cumulative', kind: 'line', title: 'Cumulative repaid', height: 200,
    labels: loan.repayments.map(function(row) { return insDateLabel(row.date_key); }),
    datasets: [{ key: 'repaid', label: 'Cumulative repaid', data: cumulative, style: 'income', fill: 'origin' }],
    y_format: 'money', y_min: 0, ref_lines: loan.has_opening ? [{ value: loan.original, label: 'Original balance', tone: 'muted' }] : [],
  }];
  return drill;
}

// ── 27 Debt-to-income ─────────────────────────────────────────────────────────

// Home's DTI over the period's months (from the first flow month when the
// period starts earlier): { month_keys, labels, income:[…], total, avg, annualised,
// complete_months, debt, ratio, status }.
function _insNwDti(ictx) {
  const period = ictx.period;
  const to = period.to > ictx.today ? ictx.today : period.to;
  const firstFlow = insFirstFlowDate(ictx, 'any');
  const firstMonth = firstFlow === null ? null : ldgMonthStart(firstFlow);
  let from = period.from;
  if (from === null) from = firstMonth === null ? ictx.today.slice(0, 4) + '-01-01' : firstMonth;
  else if (firstMonth !== null && firstMonth > from) from = firstMonth;
  if (from > to) from = ldgMonthStart(to);
  const income = insFlows(ictx, { kind: 'income', from: from, to: to });
  const series = insMonthlySeries(income, from, to);
  const currentMonth = ictx.today.slice(0, 7);
  const complete = [];
  series.keys.forEach(function(month, index) { if (month !== currentMonth) complete.push(index); });
  const avgIdx = complete.length > 0 ? complete : series.keys.map(function(_, index) { return index; });
  const avg = avgIdx.length === 0 ? 0 : avgIdx.reduce(function(sum, index) { return sum + series.values[index]; }, 0) / avgIdx.length;
  const annualised = avg * 12;
  const debt = Math.max(0, insNetWorthNow(ictx).total_liabilities);
  const ratio = annualised > 0 ? (debt / annualised) * 100 : null;
  return {
    from: from, to: to, month_keys: series.keys, labels: series.labels, income: series.values,
    total: series.values.reduce(function(sum, value) { return sum + value; }, 0), avg: avg, annualised: annualised,
    complete_months: complete.length, debt: debt, ratio: ratio, status: vwHomeDtiStatus(ratio, debt),
  };
}

function insightCompute_27_debt_to_income(ictx) {
  const dti = _insNwDti(ictx);
  if (ictx.tab === 'transactions') {
    let peak = -1;
    dti.income.forEach(function(value, index) { if (peak === -1 || value > dti.income[peak]) peak = index; });
    return {
      stat_cards: [
        insStat('total_income', 'Total income', dti.total, 'money', insRangeLabel(dti.from, dti.to), 'positive'),
        insStat('avg_monthly', 'Avg monthly', dti.avg, 'money', dti.complete_months > 0 ? dti.complete_months + ' complete month' + (dti.complete_months === 1 ? '' : 's') : 'current month only'),
        insStat('annualised', 'Annualised', dti.annualised, 'money'),
        insStat('peak_month', 'Peak month', peak === -1 ? null : dti.labels[peak], 'text', peak === -1 ? '' : _insNwMoney(ictx, dti.income[peak])),
      ],
      charts: [{
        id: 'income', kind: 'bar', height: 240, labels: dti.labels,
        datasets: [{ key: 'income', label: 'Income', data: dti.income, style: 'income' }],
        y_format: 'money', y_min: 0, ref_lines: [],
      }],
    };
  }

  // DTI ratio tab: gauge + month-end debt ÷ the same annualised income.
  const liabilityIds = _insNwAccounts(ictx, _insNwIsLiability).map(function(account) { return account.id; });
  const trackedFrom = liabilityIds.length === 0 ? null : _insNwTrackedFrom(ictx, liabilityIds);
  const ledger = insLedger(ictx);
  const sampleKeys = dti.month_keys.map(function(month) { const end = ldgMonthEnd(month + '-01'); return end > dti.to ? dti.to : end; });
  const snapshots = ldgSnapshots(ledger, sampleKeys);
  const trend = sampleKeys.map(function(key, index) {
    if (dti.annualised <= 0) return null;
    if (liabilityIds.length === 0) return 0;
    if (trackedFrom !== null && key < trackedFrom) return null;
    const owed = ldgSumQuote(ledger, snapshots[index], ictx.fx, _insNwIsLiability);
    _insNwMarkMissing(ictx, owed.missing_currencies);
    return Math.max(0, -owed.total) / dti.annualised * 100;
  });
  const tone = _INS_NW_DTI_TONES[dti.status];
  const notes = [];
  if (dti.ratio === null) notes.push({ text: 'No income data in period — DTI unavailable.', tone: 'warn' });
  const tracked = dti.annualised > 0 ? _insNwTrackedNote(trackedFrom, trend) : null;
  if (tracked !== null) notes.push(tracked);
  return {
    stat_cards: [
      insStat('total_debt', 'Total debt', dti.debt, 'money', 'Owed now', 'negative'),
      insStat('monthly_income', 'Monthly income (avg)', dti.avg > 0 ? dti.avg : null, 'money', insRangeLabel(dti.from, dti.to)),
      insStat('annualised_income', 'Annualised income', dti.annualised > 0 ? dti.annualised : null, 'money'),
      insStat('dti_ratio', 'DTI ratio', dti.ratio, 'percent', _INS_NW_DTI_LABELS[dti.status], tone),
    ],
    charts: [
      {
        id: 'gauge', kind: 'gauge', height: 200, labels: [], datasets: [], ref_lines: [],
        gauge: { value: dti.ratio === null ? 0 : Math.min(dti.ratio, 100), max: 100, status: dti.status,
          label: dti.ratio === null ? 'N/A' : dti.ratio.toFixed(1) + '%', sub: _INS_NW_DTI_LABELS[dti.status], tone: tone },
      },
      {
        id: 'trend', kind: 'line', height: 220, labels: dti.labels,
        datasets: [{ key: 'dti', label: 'DTI %', data: trend, style: 'compare', fill: 'origin' }],
        y_format: 'percent', y_min: 0,
        ref_lines: [{ value: _INS_NW_DTI_THRESHOLD, label: _INS_NW_DTI_THRESHOLD + '% healthy threshold', tone: 'warn' }],
      },
    ],
    notes: notes,
  };
}
