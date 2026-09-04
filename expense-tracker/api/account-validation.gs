// =============================================================================
// FULCRUM FORGE — Account Validation
// All validation is driven by ACCOUNT_SCHEMA (account-schema.gs).
// =============================================================================

function validateAccountCreate(body) {
  const type = (body.type !== undefined && body.type !== null) ? String(body.type).trim() : '';
  if (VALID_ACCOUNT_TYPES.indexOf(type) === -1) {
    return { ok: false, error: 'invalid_account_type' };
  }
  if (body.account_name === undefined || body.account_name === null || String(body.account_name).trim() === '')         return { ok: false, error: 'missing_account_name' };
  if (body.local_currency === undefined || body.local_currency === null || String(body.local_currency).trim() === '') return { ok: false, error: 'missing_local_currency' };

  // sub_type is required for all account types
  const subType = (body.sub_type !== undefined && body.sub_type !== null) ? String(body.sub_type).trim() : '';
  if (subType === '') return { ok: false, error: 'missing_sub_type' };

  // sub_type must be from the correct set for the given type
  if (ACCOUNT_TYPE_SUB_TYPES[type] === undefined) {
    return { ok: false, error: 'invalid_account_type' };
  }
  const validSubTypes = ACCOUNT_TYPE_SUB_TYPES[type];

  if (validSubTypes.indexOf(subType) === -1) {
    return { ok: false, error: 'invalid_sub_type' };
  }

  // Cross-entity: local_currency must exist in the rates sheet.
  // listRates() auto-seeds defaults (GBP, INR, USD, EUR, AED) on an empty sheet.
  const normCurrency    = String(body.local_currency).trim().toUpperCase();
  const ratesData       = listRates();
  const knownCurrencies = {};
  ratesData.forEach(function(r) {
    if (r.currency !== undefined && r.currency !== null && String(r.currency).trim() !== '') knownCurrencies[String(r.currency).trim().toUpperCase()] = true;
  });
  if (knownCurrencies[normCurrency] !== true) {
    return { ok: false, error: 'unknown_currency' };
  }

  if (body.opening_value_local === undefined || body.opening_value_local === null) {
    return { ok: false, error: 'missing_opening_value_local' };
  }
  if (Number.isFinite(Number(body.opening_value_local)) === false) {
    return { ok: false, error: 'invalid_opening_value_local' };
  }

  if (body.opening_date_local === undefined || body.opening_date_local === null || String(body.opening_date_local).trim() === '') {
    return { ok: false, error: 'missing_opening_date_local' };
  }

  return { ok: true };
}

function validateAccountUpdate(body, currentType) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  if (body.account_name === undefined || body.account_name === null || String(body.account_name).trim() === '') return { ok: false, error: 'missing_account_name' };

  // Reject attempts to send immutable fields
  const fields = getFieldsForAccountType(currentType);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.editable === false && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable', field: field.key };
    }
  }

  // Validate sub_type when provided
  if (body.sub_type !== undefined && body.sub_type !== null) {
    const subType = String(body.sub_type).trim();
    if (ACCOUNT_TYPE_SUB_TYPES[currentType] === undefined) {
      return { ok: false, error: 'invalid_account_type' };
    }
    const validSubTypes = ACCOUNT_TYPE_SUB_TYPES[currentType];
    if (validSubTypes.indexOf(subType) === -1) {
      return { ok: false, error: 'invalid_sub_type' };
    }
  }

  if (body.record_status !== undefined && body.record_status !== null) {
    const VALID_RS = ['active', 'inactive', 'locked'];
    if (VALID_RS.indexOf(String(body.record_status).trim()) === -1) {
      return { ok: false, error: 'invalid_record_status' };
    }
  }

  return { ok: true };
}
