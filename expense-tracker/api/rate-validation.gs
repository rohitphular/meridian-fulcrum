// =============================================================================
// FULCRUM FORGE — Rate validation
// =============================================================================

function validateRateUpsert(body) {
  if (!body.currency)                               return { ok: false, error: 'missing_currency' };
  if (body.currency === 'GBP')                      return { ok: false, error: 'base_currency_readonly' };
  if (body.rate === undefined || body.rate === null) return { ok: false, error: 'missing_rate' };
  if (Number(body.rate) <= 0)                       return { ok: false, error: 'rate_must_be_positive' };

  // Currency code must be alpha+digits only — feeds into innerHTML at many
  // points in the frontend (toBase warnings, transactions list, etc.).
  if (!/^[A-Za-z0-9]{1,8}$/.test(String(body.currency))) {
    return { ok: false, error: 'invalid_currency_code' };
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
