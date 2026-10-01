// =============================================================================
// FULCRUM FORGE — Insights: spending comparisons (server compute for get_insight)
//
// Ports (P4-B): 01-mom-cumulative, 02-yoy-monthly, 03-wow-daily,
// 04-qtd-comparison, 05-ytd-comparison, 06-last-12-months, 07-last-8-weeks.
// See insights-registry.gs for ictx, helpers and the payload schema.
//
// Shared rules:
// - Spend / income come from insFlows (no deleted rows, no own-account
//   transfers, quote currency, missing rates reported).
// - Periods end today at the latest (inclusive); lines stop after today.
// - A to-date period (this month / week / quarter / year so far) is compared
//   with the same number of elapsed days of the comparison period in the stat
//   cards; the comparison line still shows the whole comparison period.
// - Accounts tabs sum asset + investment accounts that are not deleted
//   (insIsAssetAccount, the net-worth definition), from the ledger replay.
// Globals in this file use the _insCmp prefix (compute hooks insightCompute_*).
// =============================================================================

const _INS_CMP_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _INS_CMP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _INS_CMP_MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// ── Small helpers ─────────────────────────────────────────────────────────────

function _insCmpText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _insCmpMin(a, b) {
  return a < b ? a : b;
}

function _insCmpMax(a, b) {
  return a > b ? a : b;
}

function _insCmpPad2(n) {
  return String(n).padStart(2, '0');
}

// Same calendar day `years` away (29 Feb → 28 Feb).
function _insCmpShiftYear(dateKey, years) {
  const year = String(Number(dateKey.slice(0, 4)) + years).padStart(4, '0');
  const monthEnd = ldgMonthEnd(year + '-' + dateKey.slice(5, 7) + '-01');
  const day = _insCmpMin(dateKey.slice(8, 10), monthEnd.slice(8, 10));
  return year + '-' + dateKey.slice(5, 7) + '-' + day;
}

// Same day of the month `months` away, clamped to that month's end.
function _insCmpShiftMonths(dateKey, months) {
  const start = ldgMonthStart(dateKey, months);
  const end = ldgMonthEnd(start);
  return start.slice(0, 8) + _insCmpMin(dateKey.slice(8, 10), end.slice(8, 10));
}

// '2026-09' → 'September 2026'
function _insCmpMonthLong(monthKey) {
  return _INS_CMP_MONTHS_LONG[Number(monthKey.slice(5, 7)) - 1] + ' ' + monthKey.slice(0, 4);
}

// '2026-09' → 'Sep 2026'
function _insCmpMonthShort(monthKey) {
  return _INS_CMP_MONTHS[Number(monthKey.slice(5, 7)) - 1] + ' ' + monthKey.slice(0, 4);
}

function _insCmpWeekday(dateKey) {
  return _INS_CMP_WEEKDAYS[ldgDaysBetween(insWeekStart(dateKey), dateKey) - 1];
}

// ISO week of a date key: { year, week } (the Thursday decides the year).
function _insCmpIsoWeek(dateKey) {
  const thursday = ldgAddDays(insWeekStart(dateKey), 3);
  const year = thursday.slice(0, 4);
  return { year: year, week: Math.floor((ldgDaysBetween(year + '-01-01', thursday) - 1) / 7) + 1 };
}

// 'W40 2026'
function _insCmpIsoWeekLabel(dateKey) {
  const iso = _insCmpIsoWeek(dateKey);
  return 'W' + _insCmpPad2(iso.week) + ' ' + iso.year;
}

// Running sums of a value list.
function _insCmpCumulative(values) {
  let running = 0;
  return values.map(function(value) { running += value; return running; });
}

// Pads a list with `fill` up to length.
function _insCmpPad(values, length, fill) {
  const out = values.slice();
  while (out.length < length) out.push(fill);
  return out;
}

function _insCmpLast(values) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return values[i];
  return 0;
}

function _insCmpSumTo(rows, toKey) {
  return insTotal(rows.filter(function(row) { return row.date_key <= toKey; }));
}

// Change card: value = a - b (money_delta), sub = rounded percent vs b.
// upIsGood: true for balances (more is better), false for spending.
function _insCmpChangeCard(key, label, a, b, upIsGood) {
  const delta = a - b;
  const good = upIsGood ? delta >= 0 : delta <= 0;
  let sub = null;
  if (delta === 0) sub = 'no change';
  else if (b !== 0) sub = Math.round(Math.abs(delta) / Math.abs(b) * 100) + '% ' + (delta > 0 ? 'higher' : 'lower');
  return insStat(key, label, delta, 'money_delta', sub, good ? 'positive' : 'negative');
}

// Current + comparison line chart (comparison dashed, amber).
function _insCmpLineChart(id, labels, current, previous, opts) {
  const o = opts || {};
  const datasets = [{ key: 'current', label: current.label, data: current.data, style: o.style === undefined ? 'primary' : o.style }];
  if (o.fill !== undefined) datasets[0].fill = o.fill;
  if (previous !== null) datasets.push({ key: 'previous', label: previous.label, data: previous.data, style: 'compare', dashed: true });
  const chart = { id: id, kind: o.kind === undefined ? 'line' : o.kind, labels: labels, datasets: datasets, y_format: 'money', ref_lines: [] };
  if (o.y_min !== undefined) chart.y_min = o.y_min;
  return chart;
}

// ── Asset balances (ledger replay; asset + investment, not deleted) ──────────

function _insCmpAssetDaily(ictx, fromKey, toKey) {
  return insBalanceSeries(ictx, fromKey, toKey, insIsAssetAccount).totals;
}

// Asset total at the end of each date key (any order), aligned with dateKeys.
function _insCmpAssetsAt(ictx, dateKeys) {
  const ledger = insLedger(ictx);
  return ldgSnapshots(ledger, dateKeys).map(function(balances) {
    const sum = ldgSumQuote(ledger, balances, ictx.fx, insIsAssetAccount);
    sum.missing_currencies.forEach(function(code) { ictx.missing[code] = true; });
    return sum.total;
  });
}

function _insCmpAssetCount(ictx) {
  const ledger = insLedger(ictx);
  return ledger.order.filter(function(id) { return insIsAssetAccount(ledger.accounts[id]); }).length;
}

function _insCmpNoAssets() {
  return insEmpty('No asset accounts found.');
}

// ── 01 Month-on-month daily cumulative ───────────────────────────────────────

// Month A = the month of the period start (custom without a start: the month
// of its end), up to the period end / today; month B = the calendar month before.
function _insCmpMonthWindow(ictx) {
  const period = ictx.period;
  const anchor = period.from !== null ? period.from : period.to;
  const aFrom = ldgMonthStart(anchor);
  const aMonthEnd = ldgMonthEnd(anchor);
  const aEnd = _insCmpMin(_insCmpMin(aMonthEnd, period.to), ictx.today);
  const bFrom = ldgMonthStart(anchor, -1);
  const bTo = ldgMonthEnd(anchor, -1);
  const elapsed = aEnd < aFrom ? 0 : ldgDaysBetween(aFrom, aEnd);
  return {
    a_from: aFrom, a_flow_from: period.from !== null ? _insCmpMax(period.from, aFrom) : aFrom, a_end: aEnd, a_month_end: aMonthEnd,
    b_from: bFrom, b_to: bTo, b_same_end: _insCmpMin(ldgAddDays(bFrom, _insCmpMax(elapsed, 1) - 1), bTo),
    elapsed: elapsed, days_a: ldgDaysBetween(aFrom, aMonthEnd), days_b: ldgDaysBetween(bFrom, bTo),
    partial: aEnd < aMonthEnd,
  };
}

// Daily cumulative over a month (null after endKey), padded to length.
function _insCmpMonthCumulative(rows, monthFrom, endKey, monthEnd, length) {
  const values = endKey < monthFrom ? [] : _insCmpCumulative(insDailySeries(rows, monthFrom, endKey).values);
  return _insCmpPad(_insCmpPad(values, ldgDaysBetween(monthFrom, monthEnd), null), length, null);
}

function _insCmpDayNumbers(count) {
  const labels = [];
  for (let day = 1; day <= count; day++) labels.push(String(day));
  return labels;
}

function insightCompute_01_mom_cumulative(ictx) {
  const w = _insCmpMonthWindow(ictx);
  const maxDays = _insCmpMax(w.days_a, w.days_b);
  const labels = _insCmpDayNumbers(maxDays);
  const labelA = _insCmpMonthLong(w.a_from.slice(0, 7));
  const labelB = _insCmpMonthLong(w.b_from.slice(0, 7));
  const daysCard = insStat('days', 'Days in', w.elapsed, 'count', 'of ' + w.days_a + ' days');

  if (ictx.tab === 'accounts') {
    if (_insCmpAssetCount(ictx) === 0) return _insCmpNoAssets();
    const dailyA = w.a_end < w.a_from ? [] : _insCmpAssetDaily(ictx, w.a_from, w.a_end);
    const dailyB = _insCmpAssetDaily(ictx, w.b_from, w.b_to);
    const latestA = _insCmpLast(dailyA), latestB = _insCmpLast(dailyB);
    return {
      stat_cards: [
        insStat('current', 'Assets ' + insDateLabel(w.a_end), latestA, 'money'),
        insStat('previous', 'Assets ' + insDateLabel(w.b_to), latestB, 'money', 'last month end'),
        _insCmpChangeCard('change', 'Change', latestA, latestB, true),
        insStat('accounts', 'Asset accounts', _insCmpAssetCount(ictx), 'count'),
      ],
      charts: [_insCmpLineChart('assets', labels,
        { label: 'Assets ' + _insCmpMonthShort(w.a_from.slice(0, 7)), data: _insCmpPad(dailyA, maxDays, null) },
        { label: 'Assets ' + _insCmpMonthShort(w.b_from.slice(0, 7)), data: _insCmpPad(dailyB, maxDays, null) }, { style: 'asset' })],
    };
  }

  const spendA = w.a_end < w.a_flow_from ? [] : insFlows(ictx, { kind: 'spend', from: w.a_flow_from, to: w.a_end });
  const spendB = insFlows(ictx, { kind: 'spend', from: w.b_from, to: w.b_to });
  if (spendA.length === 0 && spendB.length === 0) return insEmpty('No spend data for this period.');
  const totalA = insTotal(spendA);
  const totalB = w.partial ? _insCmpSumTo(spendB, w.b_same_end) : insTotal(spendB);
  return {
    stat_cards: [
      insStat('current', labelA + (w.partial ? ' (to date)' : ''), totalA, 'money'),
      insStat('previous', labelB, totalB, 'money', w.partial ? 'first ' + w.elapsed + ' days' : null),
      _insCmpChangeCard('change', 'Change', totalA, totalB, false),
      daysCard,
    ],
    charts: [_insCmpLineChart('cumulative', labels,
      { label: labelA, data: _insCmpMonthCumulative(spendA, w.a_from, w.a_end, w.a_month_end, maxDays) },
      { label: labelB, data: _insCmpMonthCumulative(spendB, w.b_from, w.b_to, w.b_to, maxDays) }, { y_min: 0 })],
  };
}

// ── 02 Year-on-year ───────────────────────────────────────────────────────────

// A single-month period is drawn as daily cumulative spend against the same
// month last year; a longer period as monthly spend against the same months
// last year (the old client always drew the month of the period start, so its
// default Year-to-date view showed January only).
function insightCompute_02_yoy_monthly(ictx) {
  const period = ictx.period;
  const aFrom = period.from !== null ? period.from : ldgMonthStart(period.to);
  const aEnd = _insCmpMin(period.to, ictx.today);
  if (aEnd < aFrom) return insEmpty('No spend data for either period.');
  const months = ldgMonthKeys(aFrom, aEnd);
  const bFrom = _insCmpShiftYear(aFrom, -1);
  const bEnd = _insCmpShiftYear(aEnd, -1);
  const single = months.length === 1;
  const accounts = ictx.tab === 'accounts';
  if (accounts && _insCmpAssetCount(ictx) === 0) return _insCmpNoAssets();

  if (single) {
    const monthA = ldgMonthStart(aFrom), monthEndA = ldgMonthEnd(aFrom);
    const monthB = ldgMonthStart(bFrom), monthEndB = ldgMonthEnd(bFrom);
    const maxDays = _insCmpMax(ldgDaysBetween(monthA, monthEndA), ldgDaysBetween(monthB, monthEndB));
    const labels = _insCmpDayNumbers(maxDays);
    const labelA = _insCmpMonthShort(monthA.slice(0, 7)), labelB = _insCmpMonthShort(monthB.slice(0, 7));
    const monthCard = insStat('month', 'Month', _INS_CMP_MONTHS_LONG[Number(monthA.slice(5, 7)) - 1], 'text');
    const partial = aEnd < monthEndA;
    if (accounts) {
      const dailyA = _insCmpAssetDaily(ictx, monthA, aEnd);
      const dailyB = _insCmpAssetDaily(ictx, monthB, monthEndB);
      const latestA = _insCmpLast(dailyA), latestB = partial ? _insCmpAssetsAt(ictx, [bEnd])[0] : _insCmpLast(dailyB);
      return {
        stat_cards: [
          insStat('current', 'Assets ' + insDateLabel(aEnd), latestA, 'money'),
          insStat('previous', 'Assets ' + insDateLabel(partial ? bEnd : monthEndB), latestB, 'money'),
          _insCmpChangeCard('change', 'YoY change', latestA, latestB, true), monthCard,
        ],
        charts: [_insCmpLineChart('assets', labels, { label: 'Assets ' + labelA, data: _insCmpPad(dailyA, maxDays, null) },
          { label: 'Assets ' + labelB, data: _insCmpPad(dailyB, maxDays, null) }, { style: 'asset', fill: 'origin' })],
      };
    }
    const spendA = insFlows(ictx, { kind: 'spend', from: aFrom, to: aEnd });
    const spendB = insFlows(ictx, { kind: 'spend', from: monthB, to: monthEndB });
    if (spendA.length === 0 && spendB.length === 0) return insEmpty('No spend data for either period.');
    const totalA = insTotal(spendA), totalB = partial ? _insCmpSumTo(spendB, bEnd) : insTotal(spendB);
    return {
      stat_cards: [
        insStat('current', labelA + (partial ? ' (to date)' : ''), totalA, 'money'),
        insStat('previous', labelB, totalB, 'money', partial ? 'to ' + insDayLabel(bEnd) : null),
        _insCmpChangeCard('change', 'YoY change', totalA, totalB, false), monthCard,
      ],
      charts: [_insCmpLineChart('cumulative', labels,
        { label: labelA, data: _insCmpMonthCumulative(spendA, monthA, aEnd, monthEndA, maxDays) },
        { label: labelB, data: _insCmpMonthCumulative(spendB, monthB, monthEndB, monthEndB, maxDays) }, { y_min: 0 })],
    };
  }

  const labels = months.map(insMonthLabel);
  const labelA = insRangeLabel(aFrom, aEnd), labelB = insRangeLabel(bFrom, bEnd);
  const monthsCard = insStat('months', 'Months', months.length, 'count');
  if (accounts) {
    // Month-end balances (the last month is sampled at the period end).
    const endsA = months.map(function(month) { return _insCmpMin(ldgMonthEnd(month + '-01'), aEnd); });
    const endsB = endsA.map(function(key) { return _insCmpShiftYear(key, -1); });
    const valuesA = _insCmpAssetsAt(ictx, endsA), valuesB = _insCmpAssetsAt(ictx, endsB);
    const latestA = _insCmpLast(valuesA), latestB = _insCmpLast(valuesB);
    return {
      stat_cards: [
        insStat('current', 'Assets ' + insDateLabel(aEnd), latestA, 'money'),
        insStat('previous', 'Assets ' + insDateLabel(endsB[endsB.length - 1]), latestB, 'money'),
        _insCmpChangeCard('change', 'YoY change', latestA, latestB, true), monthsCard,
      ],
      charts: [_insCmpLineChart('assets', labels, { label: 'Assets ' + labelA, data: valuesA }, { label: 'Assets ' + labelB, data: valuesB }, { style: 'asset', fill: 'origin' })],
    };
  }
  const spendA = insFlows(ictx, { kind: 'spend', from: aFrom, to: aEnd });
  const spendB = insFlows(ictx, { kind: 'spend', from: bFrom, to: bEnd });
  if (spendA.length === 0 && spendB.length === 0) return insEmpty('No spend data for either period.');
  // Last year's rows bucketed onto this year's months (same calendar month).
  const shifted = spendB.map(function(row) { return Object.assign({}, row, { month_key: _insCmpShiftYear(row.date_key, 1).slice(0, 7) }); });
  const seriesA = insMonthlySeries(spendA, aFrom, aEnd), seriesB = insMonthlySeries(shifted, aFrom, aEnd);
  return {
    stat_cards: [
      insStat('current', labelA, insTotal(spendA), 'money'),
      insStat('previous', labelB, insTotal(spendB), 'money'),
      _insCmpChangeCard('change', 'YoY change', insTotal(spendA), insTotal(spendB), false), monthsCard,
    ],
    charts: [_insCmpLineChart('monthly', labels, { label: labelA, data: seriesA.values }, { label: labelB, data: seriesB.values }, { kind: 'bar', y_min: 0 })],
  };
}

// ── 03 Week-on-week daily ─────────────────────────────────────────────────────

// Week A = 7 days from the period start (custom without a start: the 7 days
// ending at its end); week B = the 7 days before. Labels are the real weekdays.
function insightCompute_03_wow_daily(ictx) {
  const period = ictx.period;
  const aFrom = period.from !== null ? period.from : ldgAddDays(period.to, -6);
  const aTo = ldgAddDays(aFrom, 6);
  const aEnd = _insCmpMin(_insCmpMin(aTo, period.to), ictx.today);
  const bFrom = ldgAddDays(aFrom, -7), bTo = ldgAddDays(aFrom, -1);
  const elapsed = aEnd < aFrom ? 0 : ldgDaysBetween(aFrom, aEnd);
  const partial = aEnd < aTo;
  const bSameEnd = ldgAddDays(bFrom, _insCmpMax(elapsed, 1) - 1);
  const labels = ldgDateKeys(aFrom, aTo).map(_insCmpWeekday);
  const monday = insWeekStart(aFrom) === aFrom;
  const weekLabel = monday ? _insCmpIsoWeekLabel(aFrom) : insRangeLabel(aFrom, aTo);
  const labelA = weekLabel + (partial ? ' (current)' : '');
  const labelB = (monday ? _insCmpIsoWeekLabel(bFrom) : insRangeLabel(bFrom, bTo)) + ' (prev)';
  const weekCard = insStat('week', 'Week', weekLabel, 'text');

  if (ictx.tab === 'accounts') {
    if (_insCmpAssetCount(ictx) === 0) return _insCmpNoAssets();
    const dailyA = elapsed === 0 ? [] : _insCmpAssetDaily(ictx, aFrom, aEnd);
    const dailyB = _insCmpAssetDaily(ictx, bFrom, bTo);
    const latestA = _insCmpLast(dailyA), latestB = _insCmpLast(dailyB);
    return {
      stat_cards: [
        insStat('current', 'Assets ' + insDateLabel(elapsed === 0 ? aFrom : aEnd), latestA, 'money'),
        insStat('previous', 'Assets ' + insDateLabel(bTo), latestB, 'money', 'prev week end'),
        _insCmpChangeCard('change', 'WoW change', latestA, latestB, true), weekCard,
      ],
      charts: [_insCmpLineChart('assets', labels, { label: 'Assets ' + labelA, data: _insCmpPad(dailyA, 7, null) },
        { label: 'Assets ' + labelB, data: dailyB }, { style: 'asset', fill: 'origin' })],
    };
  }

  const spendA = elapsed === 0 ? [] : insFlows(ictx, { kind: 'spend', from: aFrom, to: aEnd });
  const spendB = insFlows(ictx, { kind: 'spend', from: bFrom, to: bTo });
  if (spendA.length === 0 && spendB.length === 0) return insEmpty('No spend data for either week.');
  const totalA = insTotal(spendA), totalB = partial ? _insCmpSumTo(spendB, bSameEnd) : insTotal(spendB);
  return {
    stat_cards: [
      insStat('current', labelA, totalA, 'money'),
      insStat('previous', labelB, totalB, 'money', partial ? 'first ' + elapsed + ' days' : null),
      _insCmpChangeCard('change', 'WoW change', totalA, totalB, false), weekCard,
    ],
    charts: [_insCmpLineChart('daily', labels,
      { label: labelA, data: _insCmpPad(elapsed === 0 ? [] : insDailySeries(spendA, aFrom, aEnd).values, 7, null) },
      { label: labelB, data: insDailySeries(spendB, bFrom, bTo).values }, { fill: 'origin', y_min: 0 })],
  };
}

// ── 04 Quarter-to-date ────────────────────────────────────────────────────────

function _insCmpQuarterLabel(dateKey) {
  return 'Q' + (Math.floor((Number(dateKey.slice(5, 7)) - 1) / 3) + 1) + ' ' + dateKey.slice(0, 4);
}

// A = period start → period end / today; B = the same number of days from
// the start of the previous quarter (never past the day before A starts).
function insightCompute_04_qtd_comparison(ictx) {
  const period = ictx.period;
  const custom = period.key === 'custom';
  const aFrom = period.from !== null ? period.from : ldgMonthStart(period.to, -((Number(period.to.slice(5, 7)) - 1) % 3));
  const fullEnd = custom ? period.to : ldgMonthEnd(aFrom, 2);
  const aEnd = _insCmpMin(period.to, ictx.today);
  if (aEnd < aFrom) return insEmpty('No spend data for this quarter.');
  const days = ldgDaysBetween(aFrom, aEnd);
  const daysInQuarter = ldgDaysBetween(aFrom, fullEnd);
  const bFrom = custom || period.compare_from === null ? _insCmpShiftMonths(aFrom, -3) : period.compare_from;
  const bTo = _insCmpMin(ldgAddDays(bFrom, days - 1), ldgAddDays(aFrom, -1));
  const partial = aEnd < fullEnd;
  const labelA = _insCmpQuarterLabel(aFrom) + (partial ? ' (to date)' : '');
  const labelB = _insCmpQuarterLabel(bFrom) + ' (same days)';
  const count = _insCmpMax(days, 2);
  const labels = [];
  for (let day = 1; day <= count; day++) labels.push('Day ' + day);
  const padLast = function(values) { return _insCmpPad(values, count, values.length > 0 ? values[values.length - 1] : 0); };
  const daysCard = insStat('days', 'Days in', days, 'count', 'of ' + daysInQuarter + ' days');

  if (ictx.tab === 'accounts') {
    if (_insCmpAssetCount(ictx) === 0) return _insCmpNoAssets();
    const dailyA = _insCmpAssetDaily(ictx, aFrom, aEnd), dailyB = _insCmpAssetDaily(ictx, bFrom, bTo);
    const latestA = _insCmpLast(dailyA), latestB = _insCmpLast(dailyB);
    return {
      stat_cards: [
        insStat('current', 'Assets ' + insDateLabel(aEnd), latestA, 'money'),
        insStat('previous', labelB, latestB, 'money', 'at ' + insDateLabel(bTo)),
        _insCmpChangeCard('change', 'QTD change', latestA, latestB, true), daysCard,
      ],
      charts: [_insCmpLineChart('assets', labels, { label: 'Assets ' + labelA, data: padLast(dailyA) },
        { label: 'Assets ' + labelB, data: padLast(dailyB) }, { style: 'asset', fill: 'origin' })],
    };
  }

  const spendA = insFlows(ictx, { kind: 'spend', from: aFrom, to: aEnd });
  const spendB = insFlows(ictx, { kind: 'spend', from: bFrom, to: bTo });
  if (spendA.length === 0 && spendB.length === 0) return insEmpty('No spend data for this quarter.');
  const hasPrevious = spendB.length > 0;
  const payload = {
    stat_cards: [
      insStat('current', labelA, insTotal(spendA), 'money'),
      insStat('previous', labelB, insTotal(spendB), 'money'),
      _insCmpChangeCard('change', 'QTD change', insTotal(spendA), insTotal(spendB), false), daysCard,
    ],
    charts: [_insCmpLineChart('cumulative', labels,
      { label: labelA, data: padLast(_insCmpCumulative(insDailySeries(spendA, aFrom, aEnd).values)) },
      hasPrevious ? { label: labelB, data: padLast(_insCmpCumulative(insDailySeries(spendB, bFrom, bTo).values)) } : null, { y_min: 0 })],
    notes: [],
  };
  if (!hasPrevious) payload.notes.push({ text: 'No data for ' + labelB + ' — comparison series hidden.' });
  return payload;
}

// ── 05 Year-to-date ───────────────────────────────────────────────────────────

// A = 1 Jan of the period's year → period end / today (same year); B = the
// same span last year. Monthly cumulative spend (Jan … the last month).
function insightCompute_05_ytd_comparison(ictx) {
  const period = ictx.period;
  const year = (period.from !== null ? period.from : period.to).slice(0, 4);
  const yearB = String(Number(year) - 1).padStart(4, '0');
  const yearStart = year + '-01-01', bStart = yearB + '-01-01';
  const aEnd = _insCmpMin(_insCmpMin(period.to, ictx.today), year + '-12-31');
  if (aEnd < yearStart) return insEmpty('No spend data for this year.');
  const bEnd = _insCmpShiftYear(aEnd, -1);
  const numMonths = Number(aEnd.slice(5, 7));
  const labels = _INS_CMP_MONTHS.slice(0, numMonths);
  const partial = aEnd < year + '-12-31';
  const labelA = partial ? year + (aEnd === ictx.today ? ' YTD' : ' to ' + insDayLabel(aEnd)) : year;
  const labelB = partial ? yearB + ' (same period)' : yearB;
  const monthsCard = insStat('months', 'Months', numMonths, 'count', 'of 12');

  if (ictx.tab === 'accounts') {
    if (_insCmpAssetCount(ictx) === 0) return _insCmpNoAssets();
    const endsA = labels.map(function(_, index) { return index === numMonths - 1 ? aEnd : ldgMonthEnd(year + '-' + _insCmpPad2(index + 1) + '-01'); });
    const endsB = labels.map(function(_, index) { return index === numMonths - 1 ? bEnd : ldgMonthEnd(yearB + '-' + _insCmpPad2(index + 1) + '-01'); });
    const valuesA = _insCmpAssetsAt(ictx, endsA), valuesB = _insCmpAssetsAt(ictx, endsB);
    const latestA = _insCmpLast(valuesA), latestB = _insCmpLast(valuesB);
    return {
      stat_cards: [
        insStat('current', 'Assets ' + labelA, latestA, 'money'),
        insStat('previous', 'Assets ' + labelB, latestB, 'money'),
        _insCmpChangeCard('change', 'YoY change', latestA, latestB, true), monthsCard,
      ],
      charts: [_insCmpLineChart('assets', labels, { label: 'Assets ' + labelA, data: valuesA }, { label: 'Assets ' + labelB, data: valuesB }, { style: 'asset', fill: 'origin' })],
    };
  }

  const spendA = insFlows(ictx, { kind: 'spend', from: yearStart, to: aEnd });
  const spendB = insFlows(ictx, { kind: 'spend', from: bStart, to: bEnd });
  if (spendA.length === 0 && spendB.length === 0) return insEmpty('No spend data for this year.');
  const hasPrevious = spendB.length > 0;
  const payload = {
    stat_cards: [
      insStat('current', labelA, insTotal(spendA), 'money'),
      insStat('previous', labelB, insTotal(spendB), 'money'),
      _insCmpChangeCard('change', 'YoY change', insTotal(spendA), insTotal(spendB), false), monthsCard,
    ],
    charts: [_insCmpLineChart('cumulative', labels,
      { label: labelA, data: _insCmpCumulative(insMonthlySeries(spendA, yearStart, aEnd).values) },
      hasPrevious ? { label: labelB, data: _insCmpCumulative(insMonthlySeries(spendB, bStart, bEnd).values) } : null, { y_min: 0 })],
    notes: [],
  };
  if (!hasPrevious) payload.notes.push({ text: 'No data for ' + yearB + ' — comparison series hidden.' });
  return payload;
}

// ── 06 Last 12 months ─────────────────────────────────────────────────────────

// Fixed window (registry default_period last_12): the 12 calendar months
// ending with the current month, to today.
function insightCompute_06_last_12_months(ictx) {
  const period = ictx.period;
  const months = ldgMonthKeys(period.from, period.to);
  const partialLast = period.to < ldgMonthEnd(period.to);
  const labels = months.map(function(month, index) { return insMonthLabel(month) + (partialLast && index === months.length - 1 ? '*' : ''); });
  const notes = partialLast ? [{ text: '* current month is partial' }] : [];

  if (ictx.tab === 'accounts') {
    const index = insIndex(ictx);
    const subtypeLabels = Object.create(null);
    vmLoad('account_types').forEach(function(row) {
      const key = _insCmpText(row.account_subtype_key);
      if (key !== '' && subtypeLabels[key] === undefined && _insCmpText(row.account_subtype_label) !== '') subtypeLabels[key] = _insCmpText(row.account_subtype_label);
    });
    const groups = [];
    const byKey = Object.create(null);
    index.accounts_raw.forEach(function(account) {
      if (!insIsAssetAccount({ type: _insCmpText(account.type), record_status: _insCmpText(account.record_status) })) return;
      const key = _insCmpText(account.sub_type) !== '' ? _insCmpText(account.sub_type) : (_insCmpText(account.type) !== '' ? _insCmpText(account.type) : 'other');
      if (byKey[key] === undefined) {
        const fallback = key.charAt(0).toUpperCase() + key.slice(1).replace(/[_-]/g, ' ');
        byKey[key] = { key: key, label: subtypeLabels[key] !== undefined ? subtypeLabels[key] : fallback, ids: Object.create(null) };
        groups.push(byKey[key]);
      }
      byKey[key].ids[account.id] = true;
    });
    if (groups.length === 0) return _insCmpNoAssets();
    const ledger = insLedger(ictx);
    const ends = months.map(function(month, i) { return i === months.length - 1 ? period.to : ldgMonthEnd(month + '-01'); });
    const snapshots = ldgSnapshots(ledger, ends);
    const datasets = groups.map(function(group, i) {
      return {
        key: group.key, label: group.label, style: 'palette:' + i,
        data: snapshots.map(function(balances) {
          const sum = ldgSumQuote(ledger, balances, ictx.fx, function(account) { return group.ids[account.id] === true && insIsAssetAccount(account); });
          sum.missing_currencies.forEach(function(code) { ictx.missing[code] = true; });
          return sum.total;
        }),
      };
    });
    const total = datasets.reduce(function(sum, dataset) { return sum + dataset.data[dataset.data.length - 1]; }, 0);
    return {
      stat_cards: [
        insStat('total_assets', 'Total assets', total, 'money'),
        insStat('groups', 'Account groups', groups.length, 'count', groups.map(function(group) { return group.label; }).join(', ')),
      ],
      charts: [{ id: 'assets', kind: 'stacked', labels: labels, datasets: datasets, y_format: 'money', ref_lines: [] }],
      notes: notes,
    };
  }

  const flows = insFlows(ictx, { kind: 'any', from: period.from, to: period.to });
  if (flows.length === 0) return insEmpty('No income or spending in the last 12 months.');
  const income = insMonthlySeries(flows.filter(function(row) { return row.kind === 'income'; }), period.from, period.to).values;
  const expense = insMonthlySeries(flows.filter(function(row) { return row.kind === 'spend'; }), period.from, period.to).values;
  const net = income.map(function(value, i) { return value - expense[i]; });
  const totalIncome = income.reduce(function(sum, value) { return sum + value; }, 0);
  const totalExpense = expense.reduce(function(sum, value) { return sum + value; }, 0);
  return {
    stat_cards: [
      insStat('income', 'Income (12 mo)', totalIncome, 'money', null, 'positive'),
      insStat('expense', 'Expenses (12 mo)', totalExpense, 'money', null, 'negative'),
      insStat('net', 'Net', totalIncome - totalExpense, 'money', null, totalIncome - totalExpense >= 0 ? 'positive' : 'negative'),
      insStat('avg_spend', 'Avg spend/mo', totalExpense / months.length, 'money'),
    ],
    charts: [{
      id: 'monthly', kind: 'mixed', labels: labels, y_format: 'money', ref_lines: [],
      datasets: [
        { key: 'income', label: 'Income', data: income, style: 'income', kind: 'bar' },
        { key: 'expense', label: 'Expenses', data: expense, style: 'expense', kind: 'bar' },
        { key: 'net', label: 'Net', data: net, style: 'compare', kind: 'line' },
      ],
    }],
    notes: notes,
  };
}

// ── 07 Last 8 weeks ───────────────────────────────────────────────────────────

// ISO weeks (Monday start): the current week (to today) and the 7 before.
function insightCompute_07_last_8_weeks(ictx) {
  const monday = insWeekStart(ictx.today);
  const from = ldgAddDays(monday, -49);
  const flows = insFlows(ictx, { kind: 'any', from: from, to: ictx.today });
  const income = insWeeklySeries(flows.filter(function(row) { return row.kind === 'income'; }), from, ictx.today);
  const expense = insWeeklySeries(flows.filter(function(row) { return row.kind === 'spend'; }), from, ictx.today);
  const labels = income.keys.map(function(key, i) {
    return 'W' + _insCmpPad2(_insCmpIsoWeek(key).week) + (i === income.keys.length - 1 ? ' (now)' : '');
  });
  const totalIncome = insTotal(flows.filter(function(row) { return row.kind === 'income'; }));
  const totalExpense = insTotal(flows.filter(function(row) { return row.kind === 'spend'; }));
  const net = totalIncome - totalExpense;
  return {
    stat_cards: [
      insStat('income', 'Income (8 wks)', totalIncome, 'money', null, 'positive'),
      insStat('expense', 'Expenses (8 wks)', totalExpense, 'money', null, 'negative'),
      insStat('net', 'Net', net, 'money', null, net >= 0 ? 'positive' : 'negative'),
      insStat('avg_spend', 'Avg spend/wk', totalExpense / 8, 'money'),
    ],
    charts: [{
      id: 'weekly', kind: 'bar', labels: labels, y_format: 'money', y_min: 0, ref_lines: [],
      datasets: [
        { key: 'income', label: 'Income', data: income.values, style: 'income' },
        { key: 'expense', label: 'Expenses', data: expense.values, style: 'expense' },
      ],
    }],
  };
}
