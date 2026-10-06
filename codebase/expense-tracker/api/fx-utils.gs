// =============================================================================
// FULCRUM FORGE — FX utils: XAU-based conversion to a quote currency
//
// Rates are "currency units per gram of XAU" (XAU = 1), exactly as listRates()
// returns them; listRates() already normalises legacy GBP-relative tables
// (_normaliseRatesToXau in rate-core.gs), so these helpers never re-normalise.
// Semantics mirror _shared/utils.js toBase / toQuote / getSymbol: an invalid
// amount or a missing / non-positive rate yields NaN (never a 1:1 fallback).
// Globals in this file use the fx / _fx prefix.
// =============================================================================

function _fxAmount(amount) {
  if (amount === undefined || amount === null || String(amount).trim() === '') return NaN;
  const raw = Number(amount);
  return Number.isFinite(raw) ? raw : NaN;
}

function _fxPositiveRate(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

// { CCY: rate } for rows with a finite positive rate. Currency keys upper-cased.
function fxRateMap(rates) {
  const map = Object.create(null);
  (Array.isArray(rates) ? rates : []).forEach(function(row) {
    if (row === null || typeof row !== 'object') return;
    const currency = String(row.currency === undefined || row.currency === null ? '' : row.currency).trim().toUpperCase();
    const rate = Number(row.rate);
    if (currency !== '' && Number.isFinite(rate) && rate > 0) map[currency] = rate;
  });
  return map;
}

// { CCY: symbol } (blank symbols kept as '').
function fxSymbolMap(rates) {
  const map = Object.create(null);
  (Array.isArray(rates) ? rates : []).forEach(function(row) {
    if (row === null || typeof row !== 'object') return;
    const currency = String(row.currency === undefined || row.currency === null ? '' : row.currency).trim().toUpperCase();
    if (currency !== '') map[currency] = row.symbol === undefined || row.symbol === null ? '' : String(row.symbol);
  });
  return map;
}

// Mirrors getSymbol: the rate row's symbol, else "CCY " for an unknown currency.
function fxSymbol(currency, symbolMap) {
  const key = String(currency === undefined || currency === null ? '' : currency).trim().toUpperCase();
  if (key !== '' && symbolMap !== undefined && symbolMap !== null && Object.prototype.hasOwnProperty.call(symbolMap, key)) return symbolMap[key];
  return key === '' ? '' : key + ' ';
}

// Mirrors toQuote(amount, from, rateMap, quote): (amount / rate[from]) * rate[quote].
function fxToQuote(amount, fromCurrency, rateMap, quoteCurrency) {
  const amt = _fxAmount(amount);
  if (!Number.isFinite(amt)) return NaN;
  const from = rateMap[String(fromCurrency === undefined || fromCurrency === null ? '' : fromCurrency).trim().toUpperCase()];
  const to = rateMap[String(quoteCurrency === undefined || quoteCurrency === null ? '' : quoteCurrency).trim().toUpperCase()];
  if (!_fxPositiveRate(from) || !_fxPositiveRate(to)) return NaN;
  return (amt / from) * to;
}

// Mirrors toBase(amount, from, rowFxRate, rateMap, quote): a supplied row FX
// rate (units per XAU) replaces rate[from]; an invalid row rate yields NaN.
function fxConvert(amount, fromCurrency, rowFxRate, rateMap, quoteCurrency) {
  const amt = _fxAmount(amount);
  if (!Number.isFinite(amt)) return NaN;
  const to = rateMap[String(quoteCurrency === undefined || quoteCurrency === null ? '' : quoteCurrency).trim().toUpperCase()];
  if (!_fxPositiveRate(to)) return NaN;
  if (rowFxRate !== undefined && rowFxRate !== null && String(rowFxRate).trim() !== '') {
    const rowRate = Number(rowFxRate);
    if (!Number.isFinite(rowRate) || rowRate <= 0) return NaN;
    return (amt / rowRate) * to;
  }
  return fxToQuote(amt, fromCurrency, rateMap, quoteCurrency);
}

// Request FX context from listRates() rows and the requested quote currency.
function fxContext(rates, quoteCurrency) {
  const quote = String(quoteCurrency === undefined || quoteCurrency === null ? '' : quoteCurrency).trim().toUpperCase();
  const rateMap = fxRateMap(rates);
  const symbols = fxSymbolMap(rates);
  return {
    quote_currency: quote,
    quote_symbol: fxSymbol(quote, symbols),
    rate_available: _fxPositiveRate(rateMap[quote]),
    rate_map: rateMap,
    symbols: symbols,
    rates: Array.isArray(rates) ? rates : [],
  };
}

// Converts with a context; NaN → null so JSON never carries a fake number.
function fxQuoteValue(amount, currency, fx) {
  const value = fxToQuote(amount, currency, fx.rate_map, fx.quote_currency);
  return Number.isFinite(value) ? value : null;
}

// Money field for view payloads: { native, currency, currency_symbol, quote }.
// quote is null when the rate is missing (never 1:1).
function fxMoney(native, currency, fx) {
  const amount = _fxAmount(native);
  const code = String(currency === undefined || currency === null ? '' : currency).trim().toUpperCase();
  return {
    native: Number.isFinite(amount) ? amount : null,
    currency: code,
    currency_symbol: fxSymbol(code, fx.symbols),
    quote: Number.isFinite(amount) ? fxQuoteValue(amount, code, fx) : null,
  };
}

// Currencies (sorted, unique) that cannot be converted to the quote currency.
// Ports insight-utils.js findMissingRates, which checks account currencies only.
function fxMissingRates(currencies, fx) {
  const missing = Object.create(null);
  (Array.isArray(currencies) ? currencies : []).forEach(function(currency) {
    const code = String(currency === undefined || currency === null ? '' : currency).trim().toUpperCase();
    if (code === '') return;
    if (!_fxPositiveRate(fx.rate_map[code]) || !fx.rate_available) missing[code] = true;
  });
  if (!fx.rate_available && fx.quote_currency !== '') missing[fx.quote_currency] = true;
  return Object.keys(missing).sort();
}

// Warning entry for a view envelope, or null when nothing is missing.
function fxMissingRateWarning(currencies, fx) {
  const missing = fxMissingRates(currencies, fx);
  return missing.length === 0 ? null : { code: 'missing_rate', currencies: missing };
}
