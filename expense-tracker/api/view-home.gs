// =============================================================================
// FULCRUM FORGE — Home view: get_home_view (hero stats, income trend, DTI)
//
// GET action (registered through viewHomeRegister, a get-registry.gs hook):
//   get_home_view   params: quote_currency, tz, today (view-context.gs)
//
// Ports app/sections/home.js _compute with the product decisions:
// - Net worth / assets / liabilities: ldgNetWorth over current balances of ALL
//   non-deleted accounts (the list_accounts_view summary numbers). The old
//   client read nonexistent current_value / currency fields, so its total
//   assets were always 0 and net worth was −debt; it also used active only.
// - Total debt = owed liabilities (a liability in credit counts as 0 debt).
// - Income / spend: ldgFlowKind (no deleted rows, no own-account transfers),
//   recorded wall date, months from the first flow month to the current month
//   (to date). Future-dated rows are outside the period; current balances
//   still include them (as on the Accounts screen).
// - Avg monthly income = income over complete months (current month excluded)
//   ÷ their count; with no complete month, all months.
// - DTI = total debt ÷ annualised income × 100 → status key; the client maps
//   status → colour (thresholds live here only).
// - Debt-free projection: (debt at the start of the first month − debt now) ÷
//   months; months = ceil(debt ÷ monthly reduction) when the reduction > 0.
// Globals in this file use the vwHome / _vwHome prefix.
// =============================================================================

const _VWHOME_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _VWHOME_DTI_LABELS = { excellent: 'Excellent', good: 'Good', caution: 'Caution', high_risk: 'High risk', debt_free: 'Debt-free', na: 'N/A' };

function viewHomeRegister(actions) {
  actions.get_home_view = { handler: function(ctx) { return vwHomeView(ctx); }, cache: true, ttl: 600 };
}

function _vwHomeText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _vwHomeMonthLabel(monthKey) {
  return _VWHOME_MONTHS[Number(monthKey.slice(5, 7)) - 1] + ' ' + monthKey.slice(2, 4);
}

// DTI status key from a ratio in percent (null = no income).
function vwHomeDtiStatus(ratio, totalDebt) {
  if (ratio === null) return 'na';
  if (totalDebt === 0) return 'debt_free';
  if (ratio < 20) return 'excellent';
  if (ratio < 36) return 'good';
  if (ratio < 50) return 'caution';
  return 'high_risk';
}

function _vwHomeIsLiability(account) {
  return account.record_status !== 'deleted' && account.type === 'liability';
}

// Monthly income / spend in the quote currency from flow-eligible rows dated
// on or before today. Returns { first_date, income:{month:quote}, spend:{…}, missing:{CCY:true} }.
function _vwHomeFlows(ctx, fx) {
  const txs = vmLoad('transactions');
  const pairs = ldgPairLegs(txs);
  const currencyById = Object.create(null);
  vmLoad('accounts_raw').forEach(function(account) {
    const id = _vwHomeText(account.id).toLowerCase();
    if (id !== '' && currencyById[id] === undefined) currencyById[id] = _vwHomeText(account.account_currency_local).toUpperCase();
  });
  const out = { first_date: null, income: Object.create(null), spend: Object.create(null), missing: Object.create(null) };
  txs.forEach(function(tx) {
    const kind = ldgFlowKind(tx, pairs);
    if (kind === null) return;
    const dateKey = ldgTxDateKey(tx);
    if (dateKey === null || dateKey > ctx.today) return;
    const native = Number(tx.tx_amount_local);
    if (!Number.isFinite(native) || native <= 0) return;
    if (out.first_date === null || dateKey < out.first_date) out.first_date = dateKey;
    const currency = currencyById[_vwHomeText(tx.account_id).toLowerCase()];
    const code = currency === undefined ? '' : currency;
    const quote = fxQuoteValue(native, code, fx);
    if (quote === null) { out.missing[code === '' ? '(blank)' : code] = true; return; }
    const bucket = kind === 'income' ? out.income : out.spend;
    const month = dateKey.slice(0, 7);
    bucket[month] = (bucket[month] === undefined ? 0 : bucket[month]) + quote;
  });
  return out;
}

// GET get_home_view → vmEnvelope with data:
// { has_data,
//   period: { key:'all', label, from, to, months, complete_months },
//   hero: { net_worth, total_assets, total_liabilities, total_debt, monthly_income, annualised_income },
//   income: { total, monthly_avg, annualised, peak:{ month_key, label, value }|null,
//             chart: { month_keys, labels, income:[…], expense:[…], peak_index } },
//   dti: { ratio|null, gauge_value (0–100), status, status_label, has_income },
//   debt_free: { months|null, monthly_reduction, is_debt_free },
//   missing_currencies }
function vwHomeView(ctx) {
  const fx = vmFx(ctx);
  const accounts = vmLoad('accounts_raw');
  const txs = vmLoad('transactions');
  const hasData = txs.some(function(tx) { return _vwHomeText(tx.record_status) !== 'deleted'; })
    || accounts.some(function(account) { return _vwHomeText(account.record_status) !== 'deleted'; });

  const flows = _vwHomeFlows(ctx, fx);
  const from = flows.first_date === null ? ctx.today.slice(0, 4) + '-01-01' : ldgMonthStart(flows.first_date);
  const monthKeys = ldgMonthKeys(from, ctx.today);
  const currentMonth = ctx.today.slice(0, 7);
  const monthlyIncome = monthKeys.map(function(month) { return flows.income[month] === undefined ? 0 : flows.income[month]; });
  const monthlySpend = monthKeys.map(function(month) { return flows.spend[month] === undefined ? 0 : flows.spend[month]; });
  const completeIdx = [];
  monthKeys.forEach(function(month, index) { if (month !== currentMonth) completeIdx.push(index); });
  const avgIdx = completeIdx.length > 0 ? completeIdx : monthKeys.map(function(_, index) { return index; });
  const avgIncome = avgIdx.length === 0 ? 0 : avgIdx.reduce(function(sum, index) { return sum + monthlyIncome[index]; }, 0) / avgIdx.length;
  const annualised = avgIncome * 12;
  const totalIncome = monthlyIncome.reduce(function(sum, value) { return sum + value; }, 0);
  let peakIndex = 0;
  monthlyIncome.forEach(function(value, index) { if (value > monthlyIncome[peakIndex]) peakIndex = index; });

  // Net worth: same definition and numbers as list_accounts_view.
  const ledger = vmLedger(ctx.tz);
  const worth = ldgNetWorth(ledger, ldgCurrentBalances(ledger), fx);
  const totalDebt = Math.max(0, worth.total_liabilities);

  const hasIncome = annualised > 0;
  const ratio = hasIncome ? (totalDebt / annualised) * 100 : null;
  const status = vwHomeDtiStatus(ratio, totalDebt);

  let months = null;
  let reduction = 0;
  const hasLiabilities = ledger.order.some(function(id) { return _vwHomeIsLiability(ledger.accounts[id]); });
  if (totalDebt === 0) {
    months = 0;
  } else if (hasLiabilities && monthKeys.length >= 2) {
    const start = ldgSumQuote(ledger, ldgBalancesAt(ledger, monthKeys[0] + '-01'), fx, _vwHomeIsLiability);
    const debtAtStart = Math.max(0, -start.total);
    reduction = (debtAtStart - totalDebt) / monthKeys.length;
    if (reduction > 0) months = Math.ceil(totalDebt / reduction);
  }

  const missing = Object.create(null);
  Object.keys(flows.missing).forEach(function(code) { missing[code] = true; });
  worth.missing_currencies.forEach(function(code) { missing[code] = true; });
  const missingList = Object.keys(missing).sort();

  const data = {
    has_data: hasData,
    period: { key: 'all', label: 'All time', from: from, to: ctx.today, months: monthKeys.length, complete_months: completeIdx.length },
    hero: {
      net_worth: worth.net_worth, total_assets: worth.total_assets, total_liabilities: worth.total_liabilities,
      total_debt: totalDebt, monthly_income: avgIncome, annualised_income: annualised,
    },
    income: {
      total: totalIncome, monthly_avg: avgIncome, annualised: annualised,
      peak: monthKeys.length === 0 ? null : { month_key: monthKeys[peakIndex], label: _vwHomeMonthLabel(monthKeys[peakIndex]), value: monthlyIncome[peakIndex] },
      chart: { month_keys: monthKeys, labels: monthKeys.map(_vwHomeMonthLabel), income: monthlyIncome, expense: monthlySpend, peak_index: monthKeys.length === 0 ? null : peakIndex },
    },
    dti: {
      ratio: ratio, gauge_value: ratio === null ? 0 : Math.min(ratio, 100),
      status: status, status_label: _VWHOME_DTI_LABELS[status], has_income: hasIncome,
    },
    debt_free: { months: months, monthly_reduction: reduction, is_debt_free: totalDebt === 0 },
    missing_currencies: missingList,
  };
  console.log('vwHomeView: months=' + monthKeys.length + ' status=' + status + ' missing=' + missingList.length);
  return vmEnvelope(ctx, data, [missingList.length === 0 ? null : { code: 'missing_rate', currencies: missingList }]);
}
