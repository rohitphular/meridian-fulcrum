// =============================================================================
// FULCRUM FORGE — Rate core: read the rates tab
//
// forex-database-load (mode publish-sheet) owns this tab and rewrites it from
// PostgreSQL; the app only reads it. A missing or empty tab reads as XAU only,
// so every other currency reports missing_rate until rates are published.
// Reading never creates or writes the tab.
// =============================================================================

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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RATES_SHEET);
  return _normaliseRatesToXau(sheet === null ? [] : sheetToObjects(sheet));
}
