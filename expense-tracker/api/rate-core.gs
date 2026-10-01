// =============================================================================
// FULCRUM FORGE — Rate core operations
// =============================================================================

// Illustrative initial rates, expressed as currency units per gram of XAU.
// These preserve the old seed's cross-currency ratios; update them before relying on valuations.
const DEFAULT_RATES = [
  { currency: 'GBP', rate: 1 / 0.013, symbol: '£' },
  { currency: 'XAU', rate: 1, symbol: '⊕' },
  { currency: 'INR', rate: 105 / 0.013, symbol: '₹' },
  { currency: 'USD', rate: 1.27 / 0.013, symbol: '$' },
  { currency: 'EUR', rate: 1.17 / 0.013, symbol: '€' },
];

// Older sheets store all rates against GBP, including grams of XAU per GBP.
// Dividing every rate by that XAU row preserves each conversion ratio. A sheet
// without an XAU row follows the documented XAU-relative convention (implicit 1).
// Reads expose a normalised view; only an explicit upsert persists normalisation.
function _normaliseRatesToXau(rateRows) {
  const currencies = new Set();
  rateRows.forEach(function(rateRow) {
    const currency = String(rateRow.currency).trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(currency) || currencies.has(currency)) {
      throw new Error('invalid_rate_table');
    }
    if (!Number.isFinite(Number(rateRow.rate)) || Number(rateRow.rate) <= 0) {
      throw new Error('invalid_rate_table');
    }
    currencies.add(currency);
  });
  const xauRow = rateRows.find(function(rateRow) { return String(rateRow.currency).trim().toUpperCase() === 'XAU'; });
  const xauRate = xauRow === undefined ? 1 : Number(xauRow.rate);
  const normalised = rateRows.map(function(rateRow) {
    const rate = Number(rateRow.rate) / xauRate;
    if (!Number.isFinite(rate) || rate <= 0) { throw new Error('invalid_rate_table'); }
    return Object.assign({}, rateRow, { currency: String(rateRow.currency).trim().toUpperCase(), rate: rate });
  });
  if (xauRow === undefined) {
    normalised.push({ currency: 'XAU', rate: 1, symbol: '⊕', updated_at: '' });
  }
  return normalised;
}

function listRates() {
  const columns = getRateSheetColumns();
  const sheet = getOrCreateSheet(RATES_SHEET, columns);
  const rateRows = sheetToObjects(sheet);
  if (rateRows.length === 0) {
    const now = new Date().toISOString();
    const seededRates = DEFAULT_RATES.map(function(rateRow) { return Object.assign({}, rateRow, { updated_at: now }); });
    sheet.getRange(2, 1, seededRates.length, columns.length).setValues(seededRates.map(function(rateRow) {
      return columns.map(function(column) { return rateRow[column]; });
    }));
    return seededRates;
  }
  return _normaliseRatesToXau(rateRows);
}

// body: { currency, rate, symbol?, mode? } — mode 'create' refuses an existing
// currency (rate_already_exists). Failures carry field + message.
function upsertRate(body) {
  return rateFormError(_rateUpsert(body));
}

function _rateUpsert(body) {
  const validation = validateRateUpsert(body);
  if (validation.ok === false) { return validation; }
  const currency = String(body.currency).trim().toUpperCase();
  const columns = getRateSheetColumns();
  const sheet = getOrCreateSheet(RATES_SHEET, columns);
  let rateRows;
  try {
    rateRows = _normaliseRatesToXau(sheetToObjects(sheet));
  } catch (error) {
    console.error('upsertRate: error=invalid_rate_table');
    return { ok: false, error: 'invalid_rate_table' };
  }
  const existing = rateRows.find(function(rateRow) { return rateRow.currency === currency; });
  if (existing !== undefined && String(body.mode === undefined || body.mode === null ? '' : body.mode).trim() === 'create') {
    return { ok: false, error: 'rate_already_exists' };
  }
  const symbol = body.symbol === undefined || body.symbol === null
    ? (existing === undefined ? '' : existing.symbol)
    : String(body.symbol);
  const replacement = { currency: currency, rate: Number(body.rate), symbol: symbol, updated_at: new Date().toISOString() };
  if (existing === undefined) { rateRows.push(replacement); }
  else { rateRows[rateRows.indexOf(existing)] = replacement; }
  // Rewrite together so a legacy table can never contain a mix of GBP- and XAU-relative rates.
  sheet.getRange(2, 1, rateRows.length, columns.length).setValues(rateRows.map(function(rateRow) {
    return columns.map(function(column) { return rateRow[column]; });
  }));
  return { ok: true };
}

function deleteRate(body) {
  if (body.currency === undefined || body.currency === null || String(body.currency).trim() === '') { return { ok: false, error: 'missing_currency' }; }
  const currency = String(body.currency).trim().toUpperCase();
  if (currency === 'XAU') { return { ok: false, error: 'base_currency_readonly' }; }

  // T-05 FK checks: refuse if any account or transaction is in this currency.
  // Missing rates prevent reliable conversion of account and transaction totals.
  const accCount = _countAccountsWithCurrency(currency);
  if (accCount > 0) {
    return {
      ok: false,
      error: 'currency_in_use_by_accounts',
      referenced_count: accCount,
    };
  }
  const txCount = _countTransactionsWithCurrency(currency);
  if (txCount > 0) {
    return {
      ok: false,
      error: 'currency_in_use_by_transactions',
      referenced_count: txCount,
    };
  }

  const sheet  = getOrCreateSheet(RATES_SHEET, getRateSheetColumns());
  const values = sheet.getDataRange().getValues();
  const ci     = rateColIndex('currency');

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][ci]).trim().toUpperCase() !== currency) continue;
    sheet.deleteRow(i + 1);
    return { ok: true };
  }
  return { ok: false, error: 'not_found' };
}

function _countAccountsWithCurrency(currency) {
  const sheet  = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const values = sheet.getDataRange().getValues();
  const ci     = acctColIndex('account_currency_local');
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][ci]).trim().toUpperCase() === currency) count++;
  }
  return count;
}

function _countTransactionsWithCurrency(_currency) {
  // Currency is no longer stored in transactions — it is derived from the account at runtime.
  // The account-level check (_countAccountsWithCurrency) is the authoritative guard.
  return 0;
}
