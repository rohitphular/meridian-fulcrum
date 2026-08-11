// =============================================================================
// FULCRUM FORGE — Account Validation
// All validation is driven by ACCOUNT_SCHEMA (account-schema.gs).
// =============================================================================

function validateAccountCreate(body) {
  const type = String(body.type || '').trim();
  if (VALID_ACCOUNT_TYPES.indexOf(type) === -1) {
    return { ok: false, error: 'invalid_account_type' };
  }
  if (!String(body.name     || '').trim()) return { ok: false, error: 'missing_name' };
  if (!String(body.currency || '').trim()) return { ok: false, error: 'missing_currency' };

  // sub_type is required for all account types
  const subType = String(body.sub_type || '').trim();
  if (!subType) return { ok: false, error: 'missing_sub_type' };

  // sub_type must be from the correct set for the given type
  const validSubTypes =
    type === 'asset'      ? ASSET_SUB_TYPES :
    type === 'investment' ? INVESTMENT_SUB_TYPES :
    type === 'liability'  ? LIABILITY_SUB_TYPES : [];

  if (validSubTypes.indexOf(subType) === -1) {
    return { ok: false, error: 'invalid_sub_type' };
  }

  // Cross-entity: currency must exist in the rates sheet.
  // listRates() auto-seeds defaults (GBP, INR, USD, EUR, AED) on an empty sheet.
  const normCurrency    = String(body.currency).trim().toUpperCase();
  const ratesData       = listRates();
  const knownCurrencies = {};
  ratesData.forEach(function(r) {
    if (r.currency) knownCurrencies[String(r.currency).trim().toUpperCase()] = true;
  });
  if (!knownCurrencies[normCurrency]) {
    return { ok: false, error: 'unknown_currency:' + normCurrency };
  }

  return { ok: true };
}

function validateAccountUpdate(body, currentType) {
  if (!body.row_num)                   return { ok: false, error: 'missing_row_num' };
  if (!String(body.name || '').trim()) return { ok: false, error: 'missing_name' };

  // Reject attempts to send immutable fields
  const fields = getFieldsForAccountType(currentType);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field.editable && field.key !== 'row_num' && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable:' + field.key };
    }
  }

  return { ok: true };
}
