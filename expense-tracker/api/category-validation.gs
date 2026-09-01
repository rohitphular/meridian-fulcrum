// =============================================================================
// FULCRUM FORGE — Category Validation
// All validation is driven by CATEGORY_SCHEMA (category-schema.gs).
// Note: VALID_CATEGORY_TX_TYPES and VALID_CATEGORY_RECORD_STATUSES are derived
// from CATEGORY_SCHEMA — no separate sync required.
// =============================================================================

const VALID_CATEGORY_TX_TYPES = CATEGORY_SCHEMA.tx_type_key.enum_values;
// Derived from CATEGORY_SCHEMA to avoid a cross-file dependency on VALID_RECORD_STATUSES.
var VALID_CATEGORY_RECORD_STATUSES = CATEGORY_SCHEMA.record_status.enum_values;

function validateCategoryCreate(body) {
  const type = (body.tx_type_key !== undefined && body.tx_type_key !== null) ? String(body.tx_type_key).trim() : '';
  if (VALID_CATEGORY_TX_TYPES.indexOf(type) === -1)
    return { ok: false, error: 'invalid_transaction_type' };
  if (body.major_category_label === undefined || body.major_category_label === null)
    return { ok: false, error: 'missing_major_category' };
  if (String(body.major_category_label).trim() === '')
    return { ok: false, error: 'missing_major_category' };
  if (body.minor_category_label === undefined || body.minor_category_label === null)
    return { ok: false, error: 'missing_minor_category' };
  if (String(body.minor_category_label).trim() === '')
    return { ok: false, error: 'missing_minor_category' };
  if (body.record_status !== undefined && body.record_status !== null) {
    var validStatuses = ['active'];
    if (validStatuses.indexOf(String(body.record_status)) === -1) {
      return { ok: false, error: 'invalid_record_status' };
    }
  }
  // CAT-NEW-H-2: reject labels that slugify to an empty string (e.g. '&')
  const majKeyTest = slugify(String(body.major_category_label).trim());
  if (majKeyTest === '') return { ok: false, error: 'invalid_category_label' };
  const minKeyTest = slugify(String(body.minor_category_label).trim());
  if (minKeyTest === '') return { ok: false, error: 'invalid_category_label' };
  return { ok: true };
}

function validateCategoryUpdate(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const type = (body.tx_type_key !== undefined && body.tx_type_key !== null) ? String(body.tx_type_key).trim() : '';
  if (VALID_CATEGORY_TX_TYPES.indexOf(type) === -1)
    return { ok: false, error: 'invalid_transaction_type' };
  if (body.major_category_label === undefined || body.major_category_label === null)
    return { ok: false, error: 'missing_major_category' };
  if (String(body.major_category_label).trim() === '')
    return { ok: false, error: 'missing_major_category' };
  if (body.minor_category_label === undefined || body.minor_category_label === null)
    return { ok: false, error: 'missing_minor_category' };
  if (String(body.minor_category_label).trim() === '')
    return { ok: false, error: 'missing_minor_category' };
  if (body.record_status !== undefined && body.record_status !== null &&
      !VALID_CATEGORY_RECORD_STATUSES.includes(body.record_status))
    return { ok: false, error: 'invalid_record_status' };
  // CAT-NEW-H-2: reject labels that slugify to an empty string (e.g. '&')
  const majKeyTest = slugify(String(body.major_category_label).trim());
  if (majKeyTest === '') return { ok: false, error: 'invalid_category_label' };
  const minKeyTest = slugify(String(body.minor_category_label).trim());
  if (minKeyTest === '') return { ok: false, error: 'invalid_category_label' };
  return { ok: true };
}
