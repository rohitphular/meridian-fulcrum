// =============================================================================
// FULCRUM FORGE — Insights: counterparties, geography and FX (server compute
// for get_insight)
//
// Ports (P4-D): 22-top-counterparties, 23-recurring-payments,
// 24-spend-by-country, 25-spend-by-city, 28-forex-spend. See
// insights-registry.gs for ictx, helpers and the payload schema.
//
// - Spend (22, 24, 25, 28) comes from insFlows: no deleted rows, no own-account
//   transfers (loan / card repayments, currency exchange, ATM moves), quote
//   currency, missing rates reported. The old client counted every money-out.
// - Recurring payments (23) must see repayments, which are own-transfer legs:
//   it reads insIndex(ictx).txs + .pairs and keeps flow-eligible money-out plus
//   money-out transfer legs into a liability account (repayments). Other own
//   moves (currency exchange, savings, ATM) are not payments.
// - Dates are recorded wall-date keys (ldgTxDateKey / ldgTxLocalKey); wall
//   date-time strings are never parsed with the Date constructor.
// Globals in this file use the _insCg prefix (compute hooks insightCompute_*).
// =============================================================================

const _INS_CG_TOP_OPTIONS = [10, 15, 20];
const _INS_CG_DEFAULT_TOP = 15;
const _INS_CG_MAX_PLACES = 15;
const _INS_CG_SPARK_MONTHS = 6;
const _INS_CG_UNKNOWN = 'Unknown';
const _INS_CG_OTHER = 'Other';
const _INS_CG_UNKNOWN_MERCHANT = 'Unknown merchant';
const _INS_CG_RECURRING_SORTS = ['counterparty', 'category', 'frequency', 'amount', 'last_date'];
const _INS_CG_MONTHLY_EQUIV = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3 };
const _INS_CG_FREQUENCY_LABELS = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly' };
const _INS_CG_MAX_CV = 0.15;

// Ports insight-utils.js COUNTRY_NORM / _CURRENCY_COUNTRY.
const _INS_CG_COUNTRY_NORM = {
  uk: 'United Kingdom', gb: 'United Kingdom', england: 'United Kingdom',
  us: 'United States', usa: 'United States', america: 'United States',
  uae: 'UAE', 'in': 'India',
};
const _INS_CG_CURRENCY_COUNTRY = {
  GBP: 'United Kingdom', USD: 'United States', INR: 'India', AUD: 'Australia', CAD: 'Canada',
  CHF: 'Switzerland', SGD: 'Singapore', HKD: 'Hong Kong', JPY: 'Japan', NZD: 'New Zealand',
};

function _insCgText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// '£1,234' / '−£12.50' for subs and text cells.
function _insCgMoney(ictx, value, dp) {
  const places = dp === undefined ? 0 : dp;
  return (value < 0 ? '−' : '') + ictx.symbol + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: places, maximumFractionDigits: places });
}

function _insCgPct(value, total) {
  return total > 0 ? Math.round(value / total * 100) + '%' : '';
}

// Most frequent major-category label of a row set (first seen wins ties).
function _insCgTopCategory(rows) {
  const counts = Object.create(null);
  const order = [];
  rows.forEach(function(row) {
    const label = row.category.major_key === '' ? 'Uncategorised' : row.category.major_label;
    if (counts[label] === undefined) { counts[label] = 0; order.push(label); }
    counts[label] += 1;
  });
  let best = null;
  order.forEach(function(label) { if (best === null || counts[label] > counts[best]) best = label; });
  return best === null ? '—' : best;
}

// Single distinct raw field value of a row set (for a Transactions query), or null.
function _insCgSingleRaw(rows, field) {
  let value = null;
  for (let i = 0; i < rows.length; i++) {
    const raw = _insCgText(rows[i].tx[field]);
    if (raw === '') return null;
    if (value === null) value = raw;
    else if (value.toLowerCase() !== raw.toLowerCase()) return null;
  }
  return value;
}

// ── 22 Top counterparties ─────────────────────────────────────────────────────

function _insCgCounterpartyKey(row) {
  const name = _insCgText(row.tx.counterparty_name);
  return name === '' ? '(unknown)' : name.toLowerCase();
}

function insightCompute_22_top_counterparties(ictx) {
  const top = insIntParam(ictx, 'top_n', _INS_CG_TOP_OPTIONS, _INS_CG_DEFAULT_TOP);
  if (top.ok !== true) return top;
  const spend = insFlows(ictx, { kind: 'spend' });
  if (spend.length === 0) return insEmpty('No spend transactions for this period.');
  const groups = insGroupBy(spend, _insCgCounterpartyKey, function(row) {
    const name = _insCgText(row.tx.counterparty_name);
    return name === '' ? _INS_CG_UNKNOWN_MERCHANT : name;
  });
  const drillKey = insDrillValue(ictx, 'counterparty');
  let drilled = null;
  if (ictx.drill !== null) {
    drilled = drillKey === null ? undefined : groups.find(function(group) { return group.key === drillKey; });
    if (drilled === undefined) return insError('invalid_drill', 'drill');
  }
  const shown = groups.slice(0, top.value);
  const total = insTotal(spend);
  const payload = {
    controls: [{ param: 'top_n', value: top.value, options: _INS_CG_TOP_OPTIONS.map(function(n) { return { value: n, label: 'Top ' + n }; }) }],
    stat_cards: [
      insStat('total', 'Total spend', total, 'money', null, 'negative'),
      insStat('merchants', 'Merchants', groups.length, 'count'),
      insStat('transactions', 'Transactions', spend.length, 'count'),
      insStat('top_merchant', 'Top merchant', groups[0].label, 'text', _insCgMoney(ictx, groups[0].total)),
    ],
    charts: [{
      id: 'counterparties', kind: 'hbar', height: Math.max(300, shown.length * 44),
      labels: shown.map(function(group) { return group.label; }),
      datasets: [{
        key: 'spend', label: 'Spend', data: shown.map(function(group) { return group.total; }), style: 'primary',
        point_tones: shown.map(function(group) { return drilled !== null && group.key === drilled.key ? 'highlight' : 'primary'; }),
      }],
      y_format: 'money', ref_lines: [],
      drill: { param: 'counterparty', values: shown.map(function(group) { return group.key; }), mode: 'panel', hint: 'Tap a bar to see that merchant\'s monthly trend and transactions' },
    }],
    drill: null,
  };
  if (drilled !== null) payload.drill = _insCgCounterpartyDrill(ictx, drilled);
  return payload;
}

function _insCgCounterpartyDrill(ictx, group) {
  const matches = function(row) { return _insCgCounterpartyKey(row) === group.key; };
  const period = ictx.period;
  const query = group.key === '(unknown)' ? null : insTxQuery(period.from, period.to, { types: 'money-out', counterparty: group.label });
  const drill = insDrill(ictx, group.label, group.rows, query);
  const sparkFrom = ldgMonthStart(ictx.today, -(_INS_CG_SPARK_MONTHS - 1));
  const monthly = insMonthlySeries(insFlows(ictx, { kind: 'spend', from: sparkFrom, to: ictx.today, filter: matches }), sparkFrom, ictx.today);
  drill.charts = monthly.values.some(function(value) { return value > 0; }) ? [{
    id: 'monthly', kind: 'bar', title: 'Monthly spend (last ' + _INS_CG_SPARK_MONTHS + ' months)', height: 120,
    labels: monthly.labels, datasets: [{ key: 'spend', label: 'Spend', data: monthly.values, style: 'primary' }],
    y_format: 'money', y_min: 0, ref_lines: [],
  }] : [];
  const compare = ictx.compare;
  if (compare !== null) {
    const previous = insTotal(insFlows(ictx, { kind: 'spend', from: compare.from, to: compare.to, filter: matches }));
    const delta = group.total - previous;
    drill.table = {
      id: 'compare',
      columns: [
        { key: 'current', label: 'This period', format: 'money', align: 'right' },
        { key: 'previous', label: compare.label, format: 'money', align: 'right' },
        { key: 'change', label: 'Change', format: 'money_delta', align: 'right' },
      ],
      // Lower spend than before is good (positive tone).
      rows: [{ key: 'compare', cells: { current: group.total, previous: previous, change: delta }, tone: delta <= 0 ? 'positive' : 'negative' }],
      sortable: [], sort: null,
    };
  }
  return drill;
}

// ── 23 Recurring payments ─────────────────────────────────────────────────────

function _insCgMean(values) {
  return values.length === 0 ? 0 : values.reduce(function(sum, value) { return sum + value; }, 0) / values.length;
}

// Population standard deviation (ports _stdDev).
function _insCgStdDev(values) {
  if (values.length < 2) return 0;
  const mean = _insCgMean(values);
  return Math.sqrt(values.reduce(function(sum, value) { return sum + (value - mean) * (value - mean); }, 0) / values.length);
}

// Payments up to today: flow-eligible money-out, plus money-out transfer legs
// whose other leg is on a liability (loan / card repayments). Rows:
// { tx, quote, date_key, month_key, local_key, key, name, repayment }.
function _insCgPayments(ictx) {
  const index = insIndex(ictx);
  const out = [];
  index.txs.forEach(function(tx) {
    if (_insCgText(tx.record_status) === 'deleted' || _insCgText(tx.tx_type) !== 'money-out') return;
    const localKey = ldgTxLocalKey(tx);
    if (localKey === null || localKey.slice(0, 10) > ictx.today) return;
    const native = Number(tx.tx_amount_local);
    if (!Number.isFinite(native) || native <= 0) return;
    const account = _vwTxAccount(index, tx.account_id);
    if (account === null) return;
    let repayment = false;
    let target = null;
    if (ldgIsTransferLeg(tx, index.pairs)) {
      const sibling = ldgSibling(tx, index.pairs);
      target = sibling === null ? null : _vwTxAccount(index, sibling.account_id);
      if (target === null || _insCgText(target.type) !== 'liability') return;
      repayment = true;
    }
    let name = _insCgText(tx.counterparty_name);
    // A blank payee on a repayment is named after the liability it pays.
    if (name === '' && target !== null) name = _insCgText(target.account_name);
    if (name === '') return;
    const quote = insQuote(ictx, native, _insCgText(account.account_currency_local).toUpperCase());
    if (quote === null) return;
    const dateKey = localKey.slice(0, 10);
    out.push({ tx: tx, quote: quote, date_key: dateKey, month_key: dateKey.slice(0, 7), local_key: localKey,
      key: name.toLowerCase(), name: name, repayment: repayment });
  });
  return out;
}

// Ports _detectRecurring: per payee, amount CV ≤ 0.15 and a regular gap
// (weekly 5–9 d sd ≤ 2, monthly 28–35 d sd ≤ 5, quarterly 85–95 d sd ≤ 7).
function _insCgDetectRecurring(ictx, payments) {
  const groups = Object.create(null);
  const order = [];
  payments.forEach(function(row) {
    if (groups[row.key] === undefined) { groups[row.key] = []; order.push(row.key); }
    groups[row.key].push(row);
  });
  const index = insIndex(ictx);
  const out = [];
  order.forEach(function(key) {
    const rows = groups[key].slice().sort(function(a, b) { return a.local_key < b.local_key ? -1 : a.local_key > b.local_key ? 1 : 0; });
    if (rows.length < 2) return;
    const amounts = rows.map(function(row) { return row.quote; });
    const mean = _insCgMean(amounts);
    if (mean <= 0 || _insCgStdDev(amounts) / mean > _INS_CG_MAX_CV) return;
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(ldgDaysBetween(rows[i - 1].date_key, rows[i].date_key) - 1);
    const gMean = _insCgMean(gaps), gSd = _insCgStdDev(gaps);
    let frequency = null;
    if (gMean >= 5 && gMean <= 9 && gSd <= 2) frequency = 'weekly';
    if (gMean >= 28 && gMean <= 35 && gSd <= 5) frequency = 'monthly';
    if (gMean >= 85 && gMean <= 95 && gSd <= 7) frequency = 'quarterly';
    if (frequency === null) return;
    const last = rows[rows.length - 1];
    const category = _vwTxCategory(index, last.tx.tx_type, last.tx.major_category, last.tx.minor_category);
    out.push({
      key: key, counterparty: rows[0].name, amount: mean, frequency: frequency, count: rows.length,
      last_date: last.date_key, category: category.major_key === '' ? 'Other' : category.major_label, rows: rows,
      repayment: rows.some(function(row) { return row.repayment; }),
    });
  });
  return out.sort(function(a, b) { return b.amount - a.amount || a.counterparty.localeCompare(b.counterparty); });
}

function _insCgSortRecurring(list, col, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return list.slice().sort(function(a, b) {
    let diff = 0;
    if (col === 'amount') diff = a.amount - b.amount;
    else if (col === 'last_date') diff = a.last_date < b.last_date ? -1 : a.last_date > b.last_date ? 1 : 0;
    else diff = String(a[col]).localeCompare(String(b[col]));
    return sign * diff || a.counterparty.localeCompare(b.counterparty);
  });
}

// Detected over the full history (patterns need several months), then kept
// when at least one payment falls in the period.
function insightCompute_23_recurring_payments(ictx) {
  const sort = insChoiceParam(ictx, 'sort', _INS_CG_RECURRING_SORTS, 'amount');
  if (sort.ok !== true) return sort;
  const dir = insChoiceParam(ictx, 'sort_dir', ['asc', 'desc'], 'desc');
  if (dir.ok !== true) return dir;
  const period = ictx.period;
  const recurring = _insCgDetectRecurring(ictx, _insCgPayments(ictx)).filter(function(item) {
    return item.rows.some(function(row) { return ldgInRange(row.date_key, period.from, period.to); });
  });
  const drillKey = insDrillValue(ictx, 'counterparty');
  let drilled = null;
  if (ictx.drill !== null) {
    drilled = drillKey === null ? undefined : recurring.find(function(item) { return item.key === drillKey; });
    if (drilled === undefined) return insError('invalid_drill', 'drill');
  }
  if (recurring.length === 0) return insEmpty('No recurring payments detected in this period.');

  const totalMonthly = recurring.reduce(function(sum, item) { return sum + item.amount * _INS_CG_MONTHLY_EQUIV[item.frequency]; }, 0);
  const income = insFlows(ictx, { kind: 'income' });
  // Months of the period from the first flow month (as 27 / Home average income).
  const firstFlow = insFirstFlowDate(ictx, 'any');
  let incomeFrom = period.from;
  if (firstFlow !== null && (incomeFrom === null || ldgMonthStart(firstFlow) > incomeFrom)) incomeFrom = ldgMonthStart(firstFlow);
  const monthCount = Math.max(1, incomeFrom === null || incomeFrom > period.to ? 1 : ldgMonthKeys(incomeFrom, period.to).length);
  const monthlyIncome = insTotal(income) / monthCount;
  const pctOfIncome = monthlyIncome > 0 ? totalMonthly / monthlyIncome * 100 : null;
  const largest = recurring[0];
  const sorted = _insCgSortRecurring(recurring, sort.value, dir.value);

  const payload = {
    stat_cards: [
      insStat('monthly_total', 'Recurring / month', totalMonthly, 'money', null, 'negative'),
      insStat('pct_income', '% of income', pctOfIncome, 'percent', monthlyIncome > 0 ? 'of ' + _insCgMoney(ictx, monthlyIncome) + ' / month' : 'no income in period',
        pctOfIncome !== null && pctOfIncome > 50 ? 'negative' : null),
      insStat('count', 'Count', recurring.length, 'count'),
      insStat('largest', 'Largest', largest.counterparty, 'text', _insCgMoney(ictx, largest.amount, 2)),
    ],
    tables: [{
      id: 'recurring',
      columns: [
        { key: 'counterparty', label: 'Payee', format: 'text', align: 'left' },
        { key: 'category', label: 'Category', format: 'text', align: 'left' },
        { key: 'frequency', label: 'Frequency', format: 'text', align: 'center' },
        { key: 'amount', label: 'Amount', format: 'money2', align: 'right' },
        { key: 'last_date', label: 'Last paid', format: 'text', align: 'right' },
      ],
      rows: sorted.map(function(item) {
        return { key: item.key, drill: { param: 'counterparty', value: item.key, mode: 'panel' },
          cells: { counterparty: item.counterparty, category: item.category, frequency: _INS_CG_FREQUENCY_LABELS[item.frequency], amount: item.amount, last_date: insDateLabel(item.last_date) } };
      }),
      sortable: _INS_CG_RECURRING_SORTS.slice(), sort: { col: sort.value, dir: dir.value },
    }],
    charts: [{
      id: 'amounts', kind: 'hbar', height: Math.max(200, recurring.length * 44),
      labels: recurring.map(function(item) { return item.counterparty; }),
      datasets: [{ key: 'amount', label: 'Amount per payment', data: recurring.map(function(item) { return item.amount; }), style: 'primary' }],
      y_format: 'money', ref_lines: [],
      drill: { param: 'counterparty', values: recurring.map(function(item) { return item.key; }), mode: 'panel', hint: 'Tap a row or bar to see the payment history' },
    }],
    drill: null,
  };
  if (drilled !== null) payload.drill = _insCgRecurringDrill(ictx, drilled);
  return payload;
}

function _insCgRecurringDrill(ictx, item) {
  const query = item.repayment ? null : insTxQuery(null, ictx.today, { types: 'money-out', counterparty: item.counterparty });
  const drill = insDrill(ictx, item.counterparty, item.rows, query);
  drill.subtitle = item.count + ' payments · ' + _INS_CG_FREQUENCY_LABELS[item.frequency];
  const first = item.rows[0].date_key, last = item.rows[item.rows.length - 1].date_key;
  const monthly = insMonthlySeries(item.rows, first, last);
  drill.charts = [{
    id: 'history', kind: 'bar', title: 'Payment history', height: 110,
    labels: monthly.labels, datasets: [{ key: 'paid', label: 'Paid', data: monthly.values, style: 'primary' }],
    y_format: 'money', y_min: 0, ref_lines: [],
  }];
  return drill;
}

// ── 24 Spend by country ───────────────────────────────────────────────────────

// Ports normCountry: known aliases, else first letter upper-cased; '' when blank.
function _insCgNormCountry(raw) {
  const text = _insCgText(raw);
  if (text === '') return '';
  const alias = _INS_CG_COUNTRY_NORM[text.toLowerCase()];
  return alias !== undefined ? alias : text.charAt(0).toUpperCase() + text.slice(1);
}

function _insCgCountryOf(row) {
  const country = _insCgNormCountry(row.tx.user_location_country);
  return country === '' ? _INS_CG_UNKNOWN : country;
}

// Top places + an 'Other' bucket: [{ key, label, total, count, rows, other? }].
function _insCgTopPlaces(ordered) {
  const top = ordered.slice(0, _INS_CG_MAX_PLACES);
  const rest = ordered.slice(_INS_CG_MAX_PLACES);
  if (rest.length > 0) {
    const rows = [];
    rest.forEach(function(group) { group.rows.forEach(function(row) { rows.push(row); }); });
    top.push({ key: '', label: _INS_CG_OTHER, total: insTotal(rows), count: rows.length, rows: rows, other: true });
  }
  return top;
}

function _insCgPlaceTable(id, firstLabel, places) {
  return {
    id: id,
    columns: [
      { key: 'place', label: firstLabel, format: 'text', align: 'left' },
      { key: 'spend', label: 'Spend', format: 'money', align: 'right' },
      { key: 'count', label: 'Txns', format: 'count', align: 'right' },
      { key: 'avg', label: 'Avg/txn', format: 'money', align: 'right' },
      { key: 'top_category', label: 'Top category', format: 'text', align: 'left' },
    ],
    rows: places.map(function(place) {
      return { key: place.key === '' ? 'other' : place.key,
        cells: { place: place.label, spend: place.total, count: place.count, avg: place.count > 0 ? place.total / place.count : 0,
          top_category: place.other === true ? '—' : _insCgTopCategory(place.rows) } };
    }),
    sortable: [], sort: null,
  };
}

function insightCompute_24_spend_by_country(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  if (spend.length === 0) return insEmpty('No spend transactions for this period.');
  const groups = insGroupBy(spend, _insCgCountryOf, _insCgCountryOf);
  const known = groups.filter(function(group) { return group.key !== _INS_CG_UNKNOWN; });
  const unknown = groups.filter(function(group) { return group.key === _INS_CG_UNKNOWN; });
  const places = _insCgTopPlaces(known.concat(unknown));

  const drillKey = insDrillValue(ictx, 'country');
  let drilled = null;
  if (ictx.drill !== null) {
    drilled = drillKey === null ? undefined : groups.find(function(group) { return group.key === drillKey; });
    if (drilled === undefined) return insError('invalid_drill', 'drill');
  }

  const total = insTotal(spend);
  const first = places[0];
  const notes = [];
  if (known.length === 0) notes.push({ text: 'Country data missing — add it when entering transactions.' });
  const payload = {
    stat_cards: [
      insStat('total', 'Total spend', total, 'money', null, 'negative'),
      insStat('countries', 'Countries', known.length, 'count'),
      insStat('top_country', 'Top country', first.label, 'text', _insCgMoney(ictx, first.total)),
      insStat('top_country_pct', 'Top country %', total > 0 ? first.total / total * 100 : null, 'percent'),
    ],
    charts: [{
      id: 'countries', kind: 'hbar', height: Math.max(240, places.length * 44),
      labels: places.map(function(place) { return place.label; }),
      datasets: [{
        key: 'spend', label: 'Spend', data: places.map(function(place) { return place.total; }), style: 'primary',
        point_tones: places.map(function(place) { return place.other === true || place.key === _INS_CG_UNKNOWN ? 'muted' : 'primary'; }),
      }],
      y_format: 'money', ref_lines: [],
      drill: { param: 'country', values: places.map(function(place) { return place.key; }), mode: 'panel', hint: 'Tap a bar to see spend by city in that country' },
    }],
    tables: [_insCgPlaceTable('countries', 'Country', places)],
    notes: notes,
    drill: null,
  };
  if (drilled !== null) payload.drill = _insCgCountryDrill(ictx, drilled);
  return payload;
}

function _insCgCountryDrill(ictx, group) {
  const cities = insGroupBy(group.rows, function(row) {
    const city = _insCgText(row.tx.user_location_city);
    return city === '' ? '(city unknown)' : city.toLowerCase();
  }, function(row) {
    const city = _insCgText(row.tx.user_location_city);
    return city === '' ? '(city unknown)' : city;
  });
  const raw = _insCgSingleRaw(group.rows, 'user_location_country');
  const period = ictx.period;
  return {
    title: 'Cities in ' + group.label,
    subtitle: group.count + ' transaction' + (group.count === 1 ? '' : 's'),
    rows: [], total_count: group.count, shown_count: 0, total_quote: group.total,
    table: {
      id: 'cities',
      columns: [
        { key: 'city', label: 'City', format: 'text', align: 'left' },
        { key: 'spend', label: 'Spend', format: 'money', align: 'right' },
        { key: 'count', label: 'Txns', format: 'count', align: 'right' },
      ],
      rows: cities.map(function(city) { return { key: city.key, tone: 'negative', cells: { city: city.label, spend: city.total, count: city.count } }; }),
      sortable: [], sort: null, empty_text: 'No city data',
    },
    query: raw === null ? null : insTxQuery(period.from, period.to, { types: 'money-out', user_location_country: raw }),
  };
}

// ── 25 Spend by city ──────────────────────────────────────────────────────────

// 'City, Country' | 'City' | 'Country (city unknown)' | 'Unknown' (ports _cityKey).
function _insCgCityLabel(row) {
  const city = _insCgText(row.tx.user_location_city);
  const country = _insCgNormCountry(row.tx.user_location_country);
  if (city !== '' && country !== '') return city + ', ' + country;
  if (city !== '') return city;
  if (country !== '') return country + ' (city unknown)';
  return _INS_CG_UNKNOWN;
}

function insightCompute_25_spend_by_city(ictx) {
  const spend = insFlows(ictx, { kind: 'spend' });
  if (spend.length === 0) return insEmpty('No spend transactions for this period.');
  const home = _INS_CG_CURRENCY_COUNTRY[ictx.quote_currency] === undefined ? null : _INS_CG_CURRENCY_COUNTRY[ictx.quote_currency];
  const groups = insGroupBy(spend, function(row) { return _insCgCityLabel(row).toLowerCase(); }, _insCgCityLabel);
  groups.forEach(function(group) {
    group.unknown = group.label === _INS_CG_UNKNOWN || / \(city unknown\)$/.test(group.label);
    group.domestic = home !== null && _insCgNormCountry(group.rows[0].tx.user_location_country) === home;
  });
  const domestic = groups.filter(function(group) { return group.domestic && !group.unknown; });
  const foreign = groups.filter(function(group) { return !group.domestic && !group.unknown; });
  const unknown = groups.filter(function(group) { return group.unknown; });
  const places = _insCgTopPlaces(domestic.concat(foreign, unknown));
  places.forEach(function(place) { if (place.other === true) { place.unknown = true; place.domestic = false; } });

  const drillKey = insDrillValue(ictx, 'city');
  let drilled = null;
  if (ictx.drill !== null) {
    drilled = drillKey === null ? undefined : groups.find(function(group) { return group.key === drillKey; });
    if (drilled === undefined) return insError('invalid_drill', 'drill');
  }

  const total = insTotal(spend);
  const domesticTotal = insTotal([].concat.apply([], domestic.map(function(group) { return group.rows; })));
  const foreignTotal = insTotal([].concat.apply([], foreign.map(function(group) { return group.rows; })));
  const series = function(test) { return places.map(function(place) { return test(place) ? place.total : null; }); };
  const datasets = [
    { key: 'domestic', label: home === null ? 'Domestic' : 'Domestic (' + home + ')', data: series(function(p) { return p.domestic && !p.unknown; }), style: 'primary' },
    { key: 'international', label: 'International', data: series(function(p) { return !p.domestic && !p.unknown; }), style: 'compare' },
  ];
  if (places.some(function(place) { return place.unknown; })) datasets.push({ key: 'unknown', label: 'Unknown / other', data: series(function(p) { return p.unknown; }), style: 'muted' });
  const notes = [];
  if (domestic.length === 0 && foreign.length === 0) notes.push({ text: 'Add city to transactions for a richer view.' });
  const payload = {
    stat_cards: [
      insStat('total', 'Total spend', total, 'money', null, 'negative'),
      insStat('cities', 'Cities', domestic.length + foreign.length, 'count'),
      insStat('domestic', 'Domestic', domesticTotal, 'money', _insCgPct(domesticTotal, total)),
      insStat('international', 'International', foreignTotal, 'money', _insCgPct(foreignTotal, total)),
    ],
    charts: [{
      id: 'cities', kind: 'stacked_hbar', height: Math.max(240, places.length * 44),
      labels: places.map(function(place) { return place.label; }), datasets: datasets,
      y_format: 'money', ref_lines: [],
      drill: { param: 'city', values: places.map(function(place) { return place.key; }), mode: 'panel', hint: 'Tap a bar to see the transactions' },
    }],
    tables: [_insCgPlaceTable('cities', 'City', places)],
    notes: notes,
    drill: null,
  };
  if (drilled !== null) {
    const city = _insCgSingleRaw(drilled.rows, 'user_location_city');
    const period = ictx.period;
    payload.drill = insDrill(ictx, drilled.label, drilled.rows,
      city === null ? null : insTxQuery(period.from, period.to, { types: 'money-out', user_location_city: city }));
  }
  return payload;
}

// ── 28 Foreign currency spend ─────────────────────────────────────────────────

// '1 INR = £0.009524' from the rates sheet (replaces the old CCY_SYMBOL map and
// the raw XAU-based rate the old table showed).
function _insCgRateText(ictx, currency) {
  const rate = fxQuoteValue(1, currency, ictx.fx);
  if (rate === null) return 'Rate unavailable';
  const text = rate >= 1 ? rate.toFixed(4) : rate.toPrecision(4);
  return '1 ' + currency + ' = ' + ictx.symbol + text;
}

function insightCompute_28_forex_spend(ictx) {
  const unconverted = [];
  // insFlows calls the filter before dropping rows without a rate: collect
  // them so their native totals still show (flagged, never converted 1:1).
  const spend = insFlows(ictx, { kind: 'spend', filter: function(row) { if (row.quote === null) unconverted.push(row); return true; } });
  if (spend.length === 0 && unconverted.length === 0) return insEmpty('No spend transactions for this period.');
  const quoteCcy = ictx.quote_currency;
  const byCurrency = Object.create(null);
  const order = [];
  spend.concat(unconverted).forEach(function(row) {
    const code = row.currency === '' ? '(blank)' : row.currency;
    if (byCurrency[code] === undefined) { byCurrency[code] = { code: code, native: 0, quote: 0, count: 0, missing: false }; order.push(code); }
    const entry = byCurrency[code];
    entry.native += row.native;
    entry.count += 1;
    if (row.quote === null) entry.missing = true; else entry.quote += row.quote;
  });
  const rows = order.map(function(code) { return byCurrency[code]; }).sort(function(a, b) {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    return b.quote - a.quote || a.code.localeCompare(b.code);
  });
  const converted = rows.filter(function(row) { return !row.missing; });
  const total = converted.reduce(function(sum, row) { return sum + row.quote; }, 0);
  const domestic = byCurrency[quoteCcy] === undefined || byCurrency[quoteCcy].missing ? 0 : byCurrency[quoteCcy].quote;
  const foreignTotal = total - domestic;
  const topForeign = converted.find(function(row) { return row.code !== quoteCcy; });

  return {
    stat_cards: [
      insStat('currencies', 'Currencies used', rows.length, 'count'),
      insStat('domestic', 'Domestic (' + quoteCcy + ')', domestic, 'money', _insCgPct(domestic, total)),
      insStat('foreign', 'Foreign spend', foreignTotal, 'money', _insCgPct(foreignTotal, total), foreignTotal > 0 ? 'negative' : null),
      insStat('largest_foreign', 'Largest foreign', topForeign === undefined ? null : topForeign.code, 'text', topForeign === undefined ? '' : _insCgMoney(ictx, topForeign.quote)),
    ],
    charts: [{
      id: 'currencies', kind: 'donut', height: 220,
      labels: converted.map(function(row) { return row.code; }),
      datasets: [{ key: 'spend', label: quoteCcy + ' equivalent', data: converted.map(function(row) { return row.quote; }), style: 'palette' }],
      y_format: 'money', ref_lines: [],
    }],
    tables: [{
      id: 'currencies',
      columns: [
        { key: 'currency', label: 'Currency', format: 'text', align: 'left' },
        { key: 'native', label: 'Native total', format: 'text', align: 'right' },
        { key: 'quote', label: quoteCcy + ' equiv', format: 'money', align: 'right' },
        { key: 'share', label: 'Share', format: 'percent', align: 'right' },
        { key: 'count', label: 'Txns', format: 'count', align: 'right' },
        { key: 'rate', label: 'Rate', format: 'text', align: 'right' },
      ],
      rows: rows.map(function(row) {
        const out = { key: row.code, cells: {
          currency: row.code,
          native: (row.native < 0 ? '−' : '') + fxSymbol(row.code, ictx.fx.symbols) + Math.abs(row.native).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          quote: row.missing ? null : row.quote, share: row.missing || total <= 0 ? null : row.quote / total * 100,
          count: row.count, rate: row.code === quoteCcy ? '—' : _insCgRateText(ictx, row.code),
        } };
        if (row.missing) out.tone = 'warn';
        return out;
      }),
      sortable: [], sort: null,
    }],
  };
}
