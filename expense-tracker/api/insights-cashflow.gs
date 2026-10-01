// =============================================================================
// FULCRUM FORGE — Insights: cash flow (server compute for get_insight)
//
// Reference ports (P4-A): 29-daily-spend, 30-daily-spend-no-payments.
// Pattern for every port (see insights-registry.gs header for ictx, helpers
// and the payload schema):
//   function insightCompute_<id>(ictx) → payload object | insError(...)
// Spend / income always comes from insFlows (no deleted rows, no own-account
// transfers, quote currency, missing rates reported). Labels are built here;
// the client only formats numbers and maps tones to colours.
// Globals in this file use the _insCf prefix (compute hooks insightCompute_*).
// =============================================================================

// Daily money-out bars with a per-day drill (29 and 30 share it).
// filter(row) → bool narrows the spend rows (null = all spend).
function _insCfDailySpend(ictx, filter) {
  const period = ictx.period;
  const spend = insFlows(ictx, { kind: 'spend', filter: filter });
  let from = period.from;
  if (from === null) {
    // Custom range without a start: begin at the first spend inside the range.
    from = spend.reduce(function(first, row) { return first === null || row.date_key < first ? row.date_key : first; }, null);
    if (from === null) from = period.to;
  }
  const series = insDailySeries(spend, from, period.to);

  const drillDate = insDrillValue(ictx, 'date');
  if (ictx.drill !== null && (drillDate === null || series.rows_by_key[drillDate] === undefined)) return insError('invalid_drill', 'drill');

  const total = insTotal(spend);
  if (!series.values.some(function(value) { return value > 0; })) return insEmpty('No spending found for this period.');

  const spendDays = series.values.filter(function(value) { return value > 0; });
  const maxValue = spendDays.length === 0 ? 0 : Math.max.apply(null, spendDays);
  const maxIndex = maxValue > 0 ? series.values.indexOf(maxValue) : -1;

  const payload = {
    stat_cards: [
      insStat('total', 'Total spend', total, 'money'),
      insStat('avg_spend_day', 'Avg / spend day', spendDays.length === 0 ? 0 : total / spendDays.length, 'money'),
      insStat('highest_day', 'Highest day', maxValue, 'money', maxIndex >= 0 ? series.labels[maxIndex] : '—'),
      insStat('spend_days', 'Spend days', spendDays.length + ' / ' + series.values.length, 'text'),
    ],
    charts: [{
      id: 'daily', kind: 'bar', labels: series.labels,
      datasets: [{
        key: 'spend', label: 'Daily spend', data: series.values, style: 'primary',
        point_tones: series.values.map(function(value) { return value > 0 ? 'primary' : 'muted'; }),
      }],
      y_format: 'money', y_min: 0, ref_lines: [],
      drill: { param: 'date', values: series.keys, mode: 'panel', hint: 'Tap a bar to see that day\'s transactions' },
    }],
    drill: null,
  };
  if (drillDate !== null) {
    payload.drill = insDrill(ictx, insDayLabel(drillDate), series.rows_by_key[drillDate],
      insTxQuery(drillDate, drillDate, { types: 'money-out' }));
  }
  return payload;
}

function insightCompute_29_daily_spend(ictx) {
  return _insCfDailySpend(ictx, null);
}

// Excludes subscription-eligible categories (loan repayments, rent, recurring
// commitments). The old client keyed categories by fields category rows do not
// have, so it excluded nothing; this uses the resolved category's flag.
function insightCompute_30_daily_spend_no_payments(ictx) {
  return _insCfDailySpend(ictx, function(row) { return row.category.is_subscription_eligible !== true; });
}

// =============================================================================
// P4-B ports: 00-earn-burn-rate, 19-cashflow-waterfall, 20-savings-rate,
// 21-income-sources.
// =============================================================================

const _INS_CF_WINDOWS = [7, 14, 30, 90];
const _INS_CF_WATERFALL_TOP = 10;
const _INS_CF_SOURCE_TOP = 8;
const _INS_CF_OTHER = '__other__';
const _INS_CF_NONE = '(none)';

function _insCfText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _insCfMin(a, b) {
  return a < b ? a : b;
}

// Period start, or (custom without a start) the first flow of that kind, or
// the period end when there is none.
function _insCfStart(ictx, kind) {
  if (ictx.period.from !== null) return ictx.period.from;
  const first = insFirstFlowDate(ictx, kind);
  return first === null || first > ictx.period.to ? ictx.period.to : first;
}

// Top n groups plus one 'Other …' group holding the rest (key _INS_CF_OTHER).
function _insCfTopGroups(groups, n, otherLabel) {
  const top = groups.slice(0, n);
  const rest = groups.slice(n);
  if (rest.length > 0) {
    const rows = [];
    rest.forEach(function(group) { group.rows.forEach(function(row) { rows.push(row); }); });
    top.push({ key: _INS_CF_OTHER, label: otherLabel, total: insTotal(rows), count: rows.length, rows: rows, members: rest });
  }
  return top;
}

// ── 00 Income, expense & savings (trailing window per day) ───────────────────

// For each day of the period (to today): income, spend and income − spend
// over the trailing `window` days (default 30), divided by the window.
function insightCompute_00_earn_burn_rate(ictx) {
  const param = insIntParam(ictx, 'window', _INS_CF_WINDOWS, 30);
  if (param.ok !== true) return param;
  const windowDays = param.value;
  const controls = [{
    param: 'window', value: windowDays,
    options: _INS_CF_WINDOWS.map(function(days) { return { value: days, label: days + 'd' }; }),
  }];
  const end = _insCfMin(ictx.period.to, ictx.today);
  const start = _insCfStart(ictx, 'any');
  if (end < start) return { controls: controls, empty: { text: 'No income or spending in this period.' } };
  const reach = ldgAddDays(start, -(windowDays - 1));
  const flows = insFlows(ictx, { kind: 'any', from: reach, to: end });
  if (flows.length === 0) return { controls: controls, empty: { text: 'No income or spending in this period.' } };

  const keys = ldgDateKeys(reach, end);
  const position = Object.create(null);
  keys.forEach(function(key, i) { position[key] = i; });
  const earn = keys.map(function() { return 0; });
  const burn = keys.map(function() { return 0; });
  flows.forEach(function(row) {
    const i = position[row.date_key];
    if (i === undefined) return;
    if (row.kind === 'income') earn[i] += row.quote; else burn[i] += row.quote;
  });
  // Prefix sums: sum over keys[a..b] = prefix[b + 1] - prefix[a].
  const earnSum = [0], burnSum = [0];
  keys.forEach(function(_, i) { earnSum.push(earnSum[i] + earn[i]); burnSum.push(burnSum[i] + burn[i]); });

  const labels = [], incomeRates = [], expenseRates = [], savingsRates = [];
  for (let i = windowDays - 1; i < keys.length; i++) {
    const e = earnSum[i + 1] - earnSum[i + 1 - windowDays];
    const b = burnSum[i + 1] - burnSum[i + 1 - windowDays];
    labels.push(insDayLabel(keys[i]));
    incomeRates.push(e / windowDays);
    expenseRates.push(b / windowDays);
    savingsRates.push((e - b) / windowDays);
  }
  const last = labels.length - 1;
  const income = incomeRates[last], expense = expenseRates[last], savings = savingsRates[last];
  const sub = windowDays + 'd trailing avg';
  const savingsTone = savings >= 0 ? 'positive' : 'negative';
  return {
    controls: controls,
    stat_cards: [
      insStat('savings_day', 'Savings / day', savings, 'money2', sub, savingsTone),
      insStat('income_day', 'Income / day', income, 'money2', sub, 'positive'),
      insStat('expense_day', 'Expense / day', expense, 'money2', sub, 'negative'),
      insStat('savings_rate', 'Savings rate', income > 0 ? savings / income * 100 : null, 'percent', 'of income', income > 0 ? savingsTone : null),
    ],
    charts: [{
      id: 'rates', kind: 'line', labels: labels, y_format: 'money2', ref_lines: [],
      datasets: [
        { key: 'income', label: 'Income rate', data: incomeRates, style: 'income' },
        { key: 'expense', label: 'Expense rate', data: expenseRates, style: 'expense' },
        { key: 'savings', label: 'Savings rate', data: savingsRates, style: 'savings', fill: 'signed' },
      ],
    }],
  };
}

// ── 19 Cashflow waterfall ─────────────────────────────────────────────────────

// Opening = net worth (all non-deleted asset / investment / liability
// accounts) at the end of the day before the period; + income; − spend per
// major category (top 10 + Other expenses); closing = net worth at the end of
// the period. Income and spend exclude own-account transfers, so an 'Other
// movements' bar reconciles the rest (transfer legs that do not net to zero in
// the quote currency, e.g. currency exchanges, and opening balances of
// accounts whose tracking starts inside the period).
// Clicking an expense bar opens its transactions (drill { major }).
function insightCompute_19_cashflow_waterfall(ictx) {
  const from = _insCfStart(ictx, 'any');
  const to = ictx.period.to;
  const incomeRows = insFlows(ictx, { kind: 'income', from: from, to: to });
  const spendRows = insFlows(ictx, { kind: 'spend', from: from, to: to });
  const groups = _insCfTopGroups(insByMajor(spendRows), _INS_CF_WATERFALL_TOP, 'Other expenses');

  const drillKey = insDrillValue(ictx, 'major');
  let drillGroup = null;
  if (ictx.drill !== null) {
    drillGroup = drillKey === null ? null : groups.find(function(group) { return group.key === drillKey; });
    if (drillGroup === null || drillGroup === undefined) return insError('invalid_drill', 'drill');
  }
  if (incomeRows.length === 0 && spendRows.length === 0) return insEmpty('No income or spending in this period.');

  const ledger = insLedger(ictx);
  const opened = ldgSumQuote(ledger, ldgBalancesAt(ledger, ldgAddDays(from, -1)), ictx.fx, ldgIsNetWorthAccount);
  opened.missing_currencies.forEach(function(code) { ictx.missing[code] = true; });
  const opening = opened.total;
  const income = insTotal(incomeRows);
  const expenses = insTotal(spendRows);

  const labels = ['Opening', 'Income'];
  const bars = [[0, opening], [opening, opening + income]];
  const tones = ['primary', 'positive'];
  const drillValues = [null, null];
  let running = opening + income;
  groups.forEach(function(group) {
    labels.push(group.label);
    bars.push([running, running - group.total]);
    tones.push('negative');
    drillValues.push(group.key);
    running -= group.total;
  });
  const closed = ldgSumQuote(ledger, ldgBalancesAt(ledger, to), ictx.fx, ldgIsNetWorthAccount);
  closed.missing_currencies.forEach(function(code) { ictx.missing[code] = true; });
  const closing = closed.total;
  const other = closing - running;
  const notes = [];
  if (Math.abs(other) >= 0.005) {
    labels.push('Other movements');
    bars.push([running, closing]);
    tones.push('warn');
    drillValues.push(null);
    notes.push({ text: 'Other movements: own-account transfers that do not net to zero in ' + ictx.quote_currency
      + ' (e.g. currency exchanges) and opening balances of accounts that started tracking in this period.' });
    running = closing;
  }
  labels.push('Closing');
  bars.push([0, running]);
  tones.push(running >= 0 ? 'primary' : 'negative');
  drillValues.push(null);

  const payload = {
    stat_cards: [
      insStat('opening', 'Opening balance', opening, 'money', 'at ' + insDateLabel(ldgAddDays(from, -1))),
      insStat('income', 'Total income', income, 'money', null, 'positive'),
      insStat('expense', 'Total expenses', expenses, 'money', null, 'negative'),
      insStat('closing', 'Closing balance', running, 'money', null, running >= 0 ? 'positive' : 'negative'),
    ],
    charts: [{
      id: 'waterfall', kind: 'waterfall', height: 300, labels: labels, y_format: 'money', ref_lines: [],
      datasets: [{ key: 'amount', label: 'Amount', data: bars, style: 'primary', point_tones: tones }],
      drill: { param: 'major', values: drillValues, mode: 'panel', hint: 'Tap an expense bar to see transactions',
        null_text: 'Opening, closing, income and other movements have no transaction list — tap an expense bar.' },
    }],
    notes: notes,
    drill: null,
  };
  if (drillGroup !== null) {
    const majors = drillGroup.key === _INS_CF_OTHER
      ? drillGroup.members.map(function(member) { return member.key; }) : [drillGroup.key];
    const query = majors.indexOf(_INS_CF_NONE) === -1 ? insTxQuery(from, to, { types: 'money-out', major: majors.join(',') }) : null;
    payload.drill = insDrill(ictx, drillGroup.label, drillGroup.rows, query);
  }
  return payload;
}

// ── 20 Savings rate ───────────────────────────────────────────────────────────

// Per calendar month of the period: income, spend and (income − spend) /
// income (null when there is no income). Stat cards: average of the months
// with income, best / worst month, current run of positive months.
function insightCompute_20_savings_rate(ictx) {
  const from = _insCfStart(ictx, 'any');
  const to = ictx.period.to;
  const flows = insFlows(ictx, { kind: 'any', from: from, to: to });
  const months = ldgMonthKeys(from, to);
  if (months.length === 0 || flows.length === 0) return insEmpty('No data for selected period.');
  const income = insMonthlySeries(flows.filter(function(row) { return row.kind === 'income'; }), from, to).values;
  const expense = insMonthlySeries(flows.filter(function(row) { return row.kind === 'spend'; }), from, to).values;
  const rates = income.map(function(value, i) { return value > 0 ? (value - expense[i]) / value * 100 : null; });
  const partialLast = to < ldgMonthEnd(to);
  const labels = months.map(function(month, i) { return insMonthLabel(month) + (partialLast && i === months.length - 1 ? '*' : ''); });

  const valued = [];
  rates.forEach(function(rate, i) { if (rate !== null) valued.push({ rate: rate, i: i }); });
  let avg = null, best = null, worst = null;
  if (valued.length > 0) {
    avg = valued.reduce(function(sum, item) { return sum + item.rate; }, 0) / valued.length;
    best = valued[0]; worst = valued[0];
    valued.forEach(function(item) { if (item.rate > best.rate) best = item; if (item.rate < worst.rate) worst = item; });
  }
  let streak = 0;
  for (let i = rates.length - 1; i >= 0; i--) {
    if (rates[i] !== null && rates[i] > 0) streak++;
    else break;
  }
  return {
    stat_cards: [
      insStat('avg_rate', 'Avg savings rate', avg, 'percent', null, avg === null ? null : (avg >= 0 ? 'positive' : 'negative')),
      insStat('best_month', 'Best month', best === null ? null : best.rate, 'percent', best === null ? null : insMonthLabel(months[best.i]), 'positive'),
      insStat('worst_month', 'Worst month', worst === null ? null : worst.rate, 'percent', worst === null ? null : insMonthLabel(months[worst.i]), 'negative'),
      insStat('streak', 'Positive streak', streak > 0 ? streak + ' month' + (streak === 1 ? '' : 's') : null, 'text'),
    ],
    charts: [{
      id: 'savings_rate', kind: 'mixed', height: 280, labels: labels, y_format: 'money', y2_format: 'percent',
      datasets: [
        { key: 'income', label: 'Income', data: income, style: 'income', kind: 'bar' },
        { key: 'expense', label: 'Expenses', data: expense, style: 'expense', kind: 'bar' },
        { key: 'rate', label: 'Savings %', data: rates, style: 'compare', kind: 'line', axis: 'y2' },
      ],
      ref_lines: [{ value: 0, label: 'Break-even', tone: 'negative', axis: 'y2' }],
    }],
    notes: partialLast ? [{ text: '* partial month' }] : [],
  };
}

// ── 21 Income sources ─────────────────────────────────────────────────────────

function insightMeta_21_income_sources() {
  return { tabs: [{ key: 'source', label: 'By source' }, { key: 'category', label: 'By category' }, { key: 'trend', label: 'Trend' }] };
}

// Income by counterparty (blank = 'Unknown source') or by major category
// (top 8 + Other) as a donut with a share table, or the monthly income trend.
// Clicking a segment / row opens its transactions (drill { source } / { major }).
function insightCompute_21_income_sources(ictx) {
  const from = _insCfStart(ictx, 'income');
  const to = ictx.period.to;
  const income = insFlows(ictx, { kind: 'income', from: from, to: to });
  const tab = ictx.tab;
  if (tab === 'trend' && ictx.drill !== null) return insError('invalid_drill', 'drill');
  if (income.length === 0) return insEmpty('No income recorded for this period.');

  if (tab === 'trend') {
    const series = insMonthlySeries(income, from, to);
    const total = insTotal(income);
    let peak = 0;
    series.values.forEach(function(value, i) { if (value > series.values[peak]) peak = i; });
    return {
      stat_cards: [
        insStat('total', 'Total income', total, 'money', null, 'positive'),
        insStat('avg_month', 'Avg monthly', series.values.length === 0 ? 0 : total / series.values.length, 'money'),
        insStat('peak', 'Peak month', series.values[peak], 'money', series.labels[peak]),
      ],
      charts: [{
        id: 'trend', kind: 'line', height: 220, labels: series.labels, y_format: 'money', y_min: 0, ref_lines: [],
        datasets: [{ key: 'income', label: 'Income', data: series.values, style: 'income', fill: 'origin' }],
      }],
    };
  }

  const bySource = tab === 'source';
  const param = bySource ? 'source' : 'major';
  const all = bySource
    ? insGroupBy(income, function(row) { const name = _insCfText(row.tx.counterparty_name).toLowerCase(); return name === '' ? _INS_CF_NONE : name; },
      function(row) { const name = _insCfText(row.tx.counterparty_name); return name === '' ? 'Unknown source' : name; })
    : insByMajor(income);
  const groups = _insCfTopGroups(all, _INS_CF_SOURCE_TOP, 'Other');

  const drillKey = insDrillValue(ictx, param);
  let drillGroup = null;
  if (ictx.drill !== null) {
    drillGroup = drillKey === null ? null : all.find(function(group) { return group.key === drillKey; });
    if (drillGroup === null || drillGroup === undefined) return insError('invalid_drill', 'drill');
  }

  const total = insTotal(income);
  const notes = [];
  if (groups[0].total / total > 0.9) {
    notes.push({ text: 'Concentrated income — ' + groups[0].label + ' accounts for ' + Math.round(groups[0].total / total * 100) + '%', tone: 'warn' });
  }
  const drillValue = function(group) { return group.key === _INS_CF_OTHER ? null : group.key; };
  const payload = {
    charts: [{
      id: param, kind: 'donut', height: 200, labels: groups.map(function(group) { return group.label; }), y_format: 'money', ref_lines: [],
      datasets: [{ key: 'income', label: 'Income', data: groups.map(function(group) { return group.total; }), style: 'palette' }],
      drill: { param: param, values: groups.map(drillValue), mode: 'panel', hint: 'Tap a segment to see transactions' },
    }],
    tables: [{
      id: 'shares',
      columns: [
        { key: 'label', label: bySource ? 'Source' : 'Category', format: 'text', align: 'left' },
        { key: 'amount', label: 'Amount', format: 'money', align: 'right' },
        { key: 'share', label: 'Share', format: 'percent', align: 'right' },
      ],
      rows: groups.map(function(group) {
        const row = { key: group.key, cells: { label: group.label, amount: group.total, share: group.total / total * 100 } };
        if (group.key !== _INS_CF_OTHER) row.drill = { param: param, value: group.key, mode: 'panel' };
        return row;
      }),
      sortable: [], sort: null,
    }],
    notes: notes,
    drill: null,
  };
  if (drillGroup !== null) {
    let query = null;
    if (drillGroup.key !== _INS_CF_NONE) query = insTxQuery(from, to, bySource ? { types: 'money-in', counterparty: drillGroup.label } : { types: 'money-in', major: drillGroup.key });
    payload.drill = insDrill(ictx, drillGroup.label, drillGroup.rows, query);
  }
  return payload;
}
