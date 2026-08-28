// =============================================================================
// FULCRUM FORGE — Category Validation
// All validation is driven by CATEGORY_SCHEMA (category-schema.gs).
// Note: uses VALID_CATEGORY_TX_TYPES — keep in sync with VALID_TRANSACTION_TYPES.
// =============================================================================

const VALID_CATEGORY_TX_TYPES = ['money-in', 'money-out'];

function validateCategoryCreate(body) {
  const type = String(body.tx_type_key || '').trim();
  if (VALID_CATEGORY_TX_TYPES.indexOf(type) === -1)
    return { ok: false, error: 'invalid_transaction_type' };
  if (!String(body.major_category_label || '').trim()) return { ok: false, error: 'missing_major_category' };
  if (!String(body.minor_category_label || '').trim()) return { ok: false, error: 'missing_minor_category' };
  return { ok: true };
}

function validateCategoryUpdate(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const type = String(body.tx_type_key || '').trim();
  if (VALID_CATEGORY_TX_TYPES.indexOf(type) === -1)
    return { ok: false, error: 'invalid_transaction_type' };
  if (!String(body.major_category_label || '').trim()) return { ok: false, error: 'missing_major_category' };
  if (!String(body.minor_category_label || '').trim()) return { ok: false, error: 'missing_minor_category' };
  return { ok: true };
}
