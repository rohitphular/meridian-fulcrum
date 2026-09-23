// =============================================================================
// FULCRUM FORGE — Rate validation
// =============================================================================

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
  if (!Number.isFinite(Number(body.rate)) || Number(body.rate) <= 0) {
    return { ok: false, error: 'rate_must_be_positive' };
  }

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
