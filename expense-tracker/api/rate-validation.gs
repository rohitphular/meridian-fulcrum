// =============================================================================
// FULCRUM FORGE — Rate validation
// =============================================================================

const RATE_UPSERT_MODES = ['', 'upsert', 'create'];

const _RATE_ERROR_FIELDS = {
  missing_currency: 'currency', invalid_currency_code: 'currency', base_currency_readonly: 'currency',
  rate_already_exists: 'currency', missing_rate: 'rate', rate_must_be_positive: 'rate',
  symbol_too_long: 'symbol', invalid_symbol_characters: 'symbol', invalid_rate_mode: 'mode',
};

// Failures carry field + message (_VM_MESSAGES) so the rate forms render them as-is.
function rateFormError(result) {
  if (result === undefined || result === null || result.ok !== false) return result;
  const field = result.field === undefined || result.field === null || result.field === '' ? _RATE_ERROR_FIELDS[result.error] : result.field;
  return Object.assign({}, result, vmError(result.error, field, result.message, result.details));
}

function validateRateUpsert(body) {
  if (body.currency === undefined || body.currency === null || String(body.currency).trim() === '') {
    return { ok: false, error: 'missing_currency' };
  }
  const currency = String(body.currency).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(currency)) { return { ok: false, error: 'invalid_currency_code' }; }
  if (currency === 'XAU') { return { ok: false, error: 'base_currency_readonly' }; }
  if (body.rate === undefined || body.rate === null || String(body.rate).trim() === '') {
    return { ok: false, error: 'missing_rate' };
  }
  // Strict decimal text (or a number): rejects hex ('0x10'), '1e', 'Infinity'.
  if (isFiniteDecimal(body.rate) === false || Number(body.rate) <= 0) {
    return { ok: false, error: 'rate_must_be_positive' };
  }
  // mode 'create' (add form) refuses an existing currency; blank/'upsert' overwrites.
  const mode = body.mode === undefined || body.mode === null ? '' : String(body.mode).trim();
  if (RATE_UPSERT_MODES.indexOf(mode) === -1) return { ok: false, error: 'invalid_rate_mode' };

  // F-5 fix: symbol is rendered into HTML via innerHTML across the frontend
  // (balance cells, insight cards, transaction amounts). Reject any
  // HTML-meaningful character or backslash at the ingestion gate so a
  // self-XSS payload can never land in the rates sheet.
  if (body.symbol !== undefined && body.symbol !== null) {
    const s = String(body.symbol);
    if (s.length > 8) return { ok: false, error: 'symbol_too_long' };
    if (/[<>&"'`\\]/.test(s)) return { ok: false, error: 'invalid_symbol_characters' };
  }
  return { ok: true };
}
