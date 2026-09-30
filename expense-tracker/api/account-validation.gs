// =============================================================================
// FULCRUM FORGE — Account Validation
// All validation is driven by ACCOUNT_SCHEMA (account-schema.gs).
// =============================================================================

// Sheet-free checks shared by create and the CSV import dry run.
function validateAccountFormat(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_row' };
  if (body.id !== undefined && body.id !== null && String(body.id).trim() !== '' && isAccountUuid(body.id) === false) {
    return { ok: false, error: 'invalid_id' };
  }
  const type = (body.type !== undefined && body.type !== null) ? String(body.type).trim() : '';
  if (type === '') return { ok: false, error: 'invalid_account_type' };
  if (body.account_name === undefined || body.account_name === null || String(body.account_name).trim() === '')         return { ok: false, error: 'missing_account_name' };
  if (body.account_currency_local === undefined || body.account_currency_local === null || String(body.account_currency_local).trim() === '') return { ok: false, error: 'missing_local_currency' };

  // sub_type is required for all account types
  const subType = (body.sub_type !== undefined && body.sub_type !== null) ? String(body.sub_type).trim() : '';
  if (subType === '') return { ok: false, error: 'missing_sub_type' };

  if (body.opening_value_local === undefined || body.opening_value_local === null || String(body.opening_value_local).trim() === '') {
    return { ok: false, error: 'missing_opening_value_local' };
  }
  if (isAccountDecimal(body.opening_value_local) === false) {
    return { ok: false, error: 'invalid_opening_value_local' };
  }

  if (body.account_opening_date_local === undefined || body.account_opening_date_local === null || String(body.account_opening_date_local).trim() === '') {
    return { ok: false, error: 'missing_opening_date_local' };
  }
  const openingDate = accountLocalDateTimeKey(body.account_opening_date_local);
  if (openingDate === null) return { ok: false, error: 'invalid_account_opening_date_local' };
  if (body.account_closing_date_local !== undefined && body.account_closing_date_local !== null && String(body.account_closing_date_local).trim() !== '') {
    const closingDate = accountLocalDateTimeKey(body.account_closing_date_local);
    if (closingDate === null || closingDate < openingDate) return { ok: false, error: 'invalid_account_closing_date_local' };
  }

  if (body.tracking_start_date_local !== undefined && body.tracking_start_date_local !== null
      && String(body.tracking_start_date_local).trim() !== ''
      && accountLocalDateTimeKey(body.tracking_start_date_local) === null)
    return { ok: false, error: 'invalid_tracking_start_date_local' };
  const timeValidation = validateAccountWallTimes(body);
  if (timeValidation.ok === false) return timeValidation;

  // record_status is optional on create (defaults to 'active'); when supplied (e.g. seed
  // import preserving a closed/inactive account) it must be a valid status — never coerced.
  const recordStatus = (body.record_status !== undefined && body.record_status !== null) ? String(body.record_status).trim() : '';
  if (recordStatus !== '' && getAccountSchemaField('record_status').enum_values.indexOf(recordStatus) === -1) {
    return { ok: false, error: 'invalid_record_status' };
  }
  if (/^[A-Z]{3}$/.test(String(body.account_currency_local).trim().toUpperCase()) === false) return { ok: false, error: 'invalid_local_currency' };
  return { ok: true };
}

function validateAccountCreate(body) {
  const format = validateAccountFormat(body);
  if (format.ok === false) return format;
  const type = String(body.type).trim();
  const subType = String(body.sub_type).trim();

  // Reference lookup is last, after pure validation has rejected malformed rows.
  const availableTypes = getAvailableAccountTypes();
  if (availableTypes.some(function(row) { return row.account_type_key === type; }) === false) return { ok: false, error: 'invalid_account_type' };
  if (availableTypes.some(function(row) { return row.account_type_key === type && row.account_subtype_key === subType; }) === false)
    return { ok: false, error: 'invalid_sub_type' };
  const normCurrency = String(body.account_currency_local).trim().toUpperCase();
  const knownCurrencies = Object.create(null);
  listRates().forEach(function(rate) {
    if (rate.currency !== undefined && rate.currency !== null) knownCurrencies[String(rate.currency).trim().toUpperCase()] = true;
  });
  if (knownCurrencies[normCurrency] !== true) return { ok: false, error: 'unknown_currency' };

  return { ok: true };
}

function validateAccountUpdate(body, currentType, currentOpeningDate, currentTimezone) {
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
    if (getAvailableAccountTypes().some(function(row) { return row.account_type_key === currentType && row.account_subtype_key === subType; }) === false) {
      return { ok: false, error: 'invalid_sub_type' };
    }
  }

  if (body.record_status !== undefined && body.record_status !== null) {
    const VALID_RS = ['active', 'inactive', 'locked'];
    if (VALID_RS.indexOf(String(body.record_status).trim()) === -1) {
      return { ok: false, error: 'invalid_record_status' };
    }
  }
  if (body.account_closing_date_local !== undefined && body.account_closing_date_local !== null && String(body.account_closing_date_local).trim() !== '') {
    const closingDate = accountLocalDateTimeKey(body.account_closing_date_local);
    const openingDate = accountLocalDateTimeKey(currentOpeningDate);
    if (closingDate === null || (openingDate !== null && closingDate < openingDate)) return { ok: false, error: 'invalid_account_closing_date_local' };
    const timeValidation = validateAccountWallTimes({ account_closing_date_local: body.account_closing_date_local, local_timezone: currentTimezone });
    if (timeValidation.ok === false) return timeValidation;
  }

  return { ok: true };
}

function validateAccountWallTimes(body) {
  const rawZone = body.local_timezone;
  if (rawZone !== undefined && rawZone !== null && typeof rawZone !== 'string') return { ok: false, error: 'invalid_local_timezone' };
  const zone = rawZone === undefined || rawZone === null ? '' : rawZone.trim();
  if (zone === '') return { ok: true }; // account ETL retains unzoned local dates
  try { ianaDateFormatter(zone).format(new Date()); }
  catch (_) { return { ok: false, error: 'invalid_local_timezone' }; }
  for (const field of ['account_opening_date_local', 'account_closing_date_local', 'tracking_start_date_local']) {
    if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') continue;
    const key = accountLocalDateTimeKey(body[field]);
    if (key === null) return { ok: false, error: 'invalid_' + field };
    const error = localWallTimeError(key, zone);
    if (error !== null) return { ok: false, error: error, field: field };
  }
  return { ok: true };
}

// Account currency/opening semantics are immutable in PostgreSQL as well as
// the interactive form. CSV replacement must not bypass that source contract.
function preserveAccountImmutableFields(incoming, candidate, existing) {
  const fields = ['legal_entity_name', 'type', 'local_timezone', 'account_opening_date_local',
    'tracking_start_date_local', 'opening_value_local', 'account_currency_local'];
  function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
  function comparable(field, value) {
    if (field === 'opening_value_local') return decimalValueKey(value);
    if (field === 'account_opening_date_local' || field === 'tracking_start_date_local')
      return text(value) === '' ? '' : accountLocalDateTimeKey(sheetLocalDateTimeText(value));
    if (field === 'local_timezone') return accountTimezone(value);
    if (field === 'account_currency_local') return text(value).toUpperCase();
    return text(value);
  }
  for (const field of fields) {
    const index = acctColIndex(field);
    if (incoming[field] === undefined) { candidate[index] = existing[index]; continue; }
    // The ledger permits initializing its previously absent tracking snapshot once.
    if (field === 'tracking_start_date_local' && text(existing[index]) === '') continue;
    try {
      if (comparable(field, candidate[index]) !== comparable(field, existing[index]))
        return { ok: false, error: 'field_not_editable', field: field };
    } catch (_) { return { ok: false, error: 'invalid_existing_account_field', field: field }; }
    // Equality is semantic; preserve exact stored values so ETL immutable checks
    // never see an alias/casing rewrite or artificial change in decimal precision.
    candidate[index] = existing[index];
  }
  const wallTimes = { local_timezone: candidate[acctColIndex('local_timezone')] };
  ['account_opening_date_local', 'account_closing_date_local', 'tracking_start_date_local'].forEach(function(field) {
    wallTimes[field] = sheetLocalDateTimeText(candidate[acctColIndex(field)]);
  });
  return validateAccountWallTimes(wallTimes);
}
