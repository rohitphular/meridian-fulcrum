// =============================================================================
// FULCRUM FORGE — Rate core operations
// =============================================================================

const DEFAULT_RATES = [
  { currency: 'GBP', rate: 1,    symbol: '£' },
  { currency: 'INR', rate: 105,  symbol: '₹' },
  { currency: 'USD', rate: 1.27, symbol: '$' },
  { currency: 'EUR', rate: 1.17, symbol: '€' },
];

function listRates() {
  const cols   = getRateSheetColumns();
  const sheet  = getOrCreateSheet(RATES_SHEET, cols);
  const values = sheet.getDataRange().getValues();
  const now    = new Date().toISOString();

  if (values.length <= 1) {
    DEFAULT_RATES.forEach(r => {
      const row = new Array(cols.length).fill('');
      row[rateColIndex('currency')]   = r.currency;
      row[rateColIndex('rate')]       = r.rate;
      row[rateColIndex('symbol')]     = r.symbol || '';
      row[rateColIndex('updated_at')] = now;
      sheet.appendRow(row);
    });
    return DEFAULT_RATES.map(r => ({ currency: r.currency, rate: r.rate, symbol: r.symbol, updated_at: now }));
  }
  return sheetToObjects(sheet);
}

function upsertRate(body) {
  const v = validateRateUpsert(body);
  if (!v.ok) return v;

  const cols   = getRateSheetColumns();
  const sheet  = getOrCreateSheet(RATES_SHEET, cols);
  const values = sheet.getDataRange().getValues();
  const now    = new Date().toISOString();
  const ci     = rateColIndex('currency');

  for (let i = 1; i < values.length; i++) {
    if (values[i][ci] !== body.currency) continue;
    sheet.getRange(i + 1, rateColIndex('rate')       + 1).setValue(Number(body.rate));
    sheet.getRange(i + 1, rateColIndex('symbol')     + 1).setValue(
      body.symbol !== undefined ? body.symbol : values[i][rateColIndex('symbol')]
    );
    sheet.getRange(i + 1, rateColIndex('updated_at') + 1).setValue(now);
    return { ok: true };
  }

  const row = new Array(cols.length).fill('');
  row[rateColIndex('currency')]   = body.currency;
  row[rateColIndex('rate')]       = Number(body.rate);
  row[rateColIndex('symbol')]     = body.symbol || '';
  row[rateColIndex('updated_at')] = now;
  sheet.appendRow(row);
  return { ok: true };
}

function deleteRate(body) {
  if (!body.currency)          return { ok: false, error: 'missing_currency' };
  if (body.currency === 'GBP') return { ok: false, error: 'base_currency_readonly' };

  // T-05 FK checks: refuse if any account or transaction is in this currency.
  // Without the guards, deletion silently breaks net-worth math (toBase falls
  // back to 1:1 on a missing rate) and per-account totals — the user keeps
  // trusting wrong numbers.
  const accCount = _countAccountsWithCurrency(body.currency);
  if (accCount > 0) {
    return {
      ok: false,
      error: 'currency_in_use_by_accounts',
      referenced_count: accCount,
    };
  }
  const txCount = _countTransactionsWithCurrency(body.currency);
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
    if (values[i][ci] !== body.currency) continue;
    sheet.deleteRow(i + 1);
    return { ok: true };
  }
  return { ok: false, error: 'not_found' };
}

function _countAccountsWithCurrency(currency) {
  const sheet  = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const values = sheet.getDataRange().getValues();
  const ci     = acctColIndex('currency');
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][ci] || '') === String(currency)) count++;
  }
  return count;
}

function _countTransactionsWithCurrency(currency) {
  const sheet  = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values = sheet.getDataRange().getValues();
  const ci     = txColIndex('currency');
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][ci] || '') === String(currency)) count++;
  }
  return count;
}
