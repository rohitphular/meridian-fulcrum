// =============================================================================
// FULCRUM FORGE — Category Validation
// All validation is driven by CATEGORY_SCHEMA (category-schema.gs).
// Note: VALID_CATEGORY_TX_TYPES and VALID_CATEGORY_RECORD_STATUSES are derived
// from CATEGORY_SCHEMA — no separate sync required.
// =============================================================================

const VALID_CATEGORY_TX_TYPES = CATEGORY_SCHEMA.tx_type_key.enum_values;
// Derived from CATEGORY_SCHEMA to avoid a cross-file dependency on VALID_RECORD_STATUSES.
var VALID_CATEGORY_RECORD_STATUSES = CATEGORY_SCHEMA.record_status.enum_values;

// CSV upserts preserve lifecycle state; interactive create intentionally starts active.
// Sheet-free checks shared by import, create and the CSV import dry run.
function validateCategoryFormat(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, error: 'invalid_category_row', field: 'row' };
  const id = strField(body.id);
  if (id !== '' && (typeof body.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))
    return { ok: false, error: 'invalid_id', field: 'id', invalid_values: [id] };
  if (!VALID_CATEGORY_TX_TYPES.includes(strField(body.tx_type_key)))
    return { ok: false, error: 'invalid_transaction_type', field: 'tx_type_key', invalid_values: [strField(body.tx_type_key)] };
  for (const field of ['major_category_label', 'minor_category_label']) {
    if (typeof body[field] !== 'string' || strField(body[field]) === '')
      return { ok: false, error: 'missing_' + field.replace('_label', ''), field: field };
    if (slugify(body[field]) === '')
      return { ok: false, error: 'invalid_category_label', field: field, invalid_values: [body[field]] };
  }
  const status = strField(body.record_status);
  if (status !== '' && !VALID_CATEGORY_RECORD_STATUSES.includes(status))
    return { ok: false, error: 'invalid_record_status', field: 'record_status', invalid_values: [status] };
  for (const field of ['source_account_mandatory', 'target_account_mandatory', 'is_subscription_eligible']) {
    const value = body[field];
    if (value !== undefined && value !== null && strField(value) !== '' && typeof value !== 'boolean' &&
        (typeof value !== 'string' || !['true', 'false'].includes(value.trim().toLowerCase())))
      return { ok: false, error: 'invalid_boolean', field: field, invalid_values: [strField(value)] };
  }
  return { ok: true };
}

function validateCategoryImport(body, context) {
  const format = validateCategoryFormat(body);
  if (format.ok === false) return format;
  return validateCategoryAccountTypeHints(body, context);
}

function validateCategoryCreate(body) {
  // Interactive creation must meet the same UUID, label, boolean and hint
  // contract as import; otherwise one bad identity blocks the whole next sync.
  const validation = validateCategoryImport(body);
  if (validation.ok === false) return validation;
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
  return validateCategoryAccountTypeHints(body);
}

function validateCategoryUpdate(body) {
  const validation = validateCategoryImport(body);
  if (validation.ok === false) return validation;
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
  return validateCategoryAccountTypeHints(body);
}
