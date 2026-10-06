// =============================================================================
// FULCRUM FORGE — Subscription Validation: validate before every source write
// =============================================================================

// Form error envelope: every failure carries the input `field` and a human
// `message` (_VM_MESSAGES) so the subscription form renders it verbatim.
const _SUBV_ERROR_FIELDS = {
  missing_name: 'subscription_name',
  missing_subscription_amount_local: 'subscription_amount_local', invalid_subscription_amount_local: 'subscription_amount_local',
  missing_source_account: 'source_account', invalid_source_account: 'source_account',
  unknown_source_account: 'source_account', source_account_not_active: 'source_account',
  invalid_id: 'id', missing_frequency: 'frequency', invalid_frequency: 'frequency',
  missing_day_of_week: 'day_of_week', invalid_day_of_week: 'day_of_week',
  missing_day_of_month: 'day_of_month', invalid_day_of_month: 'day_of_month',
  invalid_subscription_timezone_local: 'subscription_timezone_local', missing_subscription_timezone_local: 'subscription_timezone_local',
  invalid_subscription_start_date_local: 'subscription_start_date_local', missing_subscription_start_date_local: 'subscription_start_date_local',
  invalid_subscription_end_date_local: 'subscription_end_date_local', end_before_start: 'subscription_end_date_local',
  invalid_tx_type: 'tx_type', invalid_record_status: 'record_status',
  unknown_category: 'major_category', category_not_active: 'major_category', category_not_subscription_eligible: 'major_category',
};

function _subvFormError(result) {
  if (result === undefined || result === null || result.ok !== false) return result;
  const field = result.field === undefined || result.field === null || result.field === '' ? _SUBV_ERROR_FIELDS[result.error] : result.field;
  return Object.assign({}, result, vmError(result.error, field, result.message, result.details));
}

function validateSubscriptionCreate(body) {
  return _subvFormError(_subvCreate(body));
}

function _subvCreate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_row' };
  if (body.subscription_name === undefined || body.subscription_name === null || String(body.subscription_name).trim() === '') {
    return { ok: false, error: 'missing_name' };
  }
  const amount = body.subscription_amount_local;
  if (amount === undefined || amount === null || amount === '') return { ok: false, error: 'missing_subscription_amount_local' };
  if ((typeof amount !== 'number' && typeof amount !== 'string')
      || (typeof amount === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(amount.trim()) === false)
      || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return { ok: false, error: 'invalid_subscription_amount_local' };
  }
  if (subscriptionText(body.source_account) === '') return { ok: false, error: 'missing_source_account' };
  if (subscriptionUuid(body.source_account) === null) return { ok: false, error: 'invalid_source_account' };
  if (subscriptionText(body.id) !== '' && subscriptionUuid(body.id) === null) return { ok: false, error: 'invalid_id' };
  const schedule = _validateSchedule(body);
  if (schedule.ok === false) return schedule;
  const txType = subscriptionText(body.tx_type);
  if (txType !== '' && SUBSCRIPTION_SCHEMA.tx_type.enum_values.indexOf(txType) === -1) return { ok: false, error: 'invalid_tx_type' };
  const status = subscriptionText(body.record_status);
  if (status !== '' && SUBSCRIPTION_SCHEMA.record_status.enum_values.indexOf(status) === -1) return { ok: false, error: 'invalid_record_status' };
  return { ok: true };
}

function validateSubscriptionUpdate(body) {
  return _subvFormError(_subvUpdate(body));
}

function _subvUpdate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_row' };
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  if (!Number.isInteger(Number(body.row_num)) || Number(body.row_num) < 2) return { ok: false, error: 'invalid_row' };
  const fields = getFieldsForSubscriptionType(null);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.editable === false && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable', field: field.key };
    }
  }
  return { ok: true };
}

function _validateSchedule(body) {
  const frequency = subscriptionText(body.frequency);
  if (frequency === '') return { ok: false, error: 'missing_frequency' };
  if (VALID_FREQUENCIES.indexOf(frequency) === -1) return { ok: false, error: 'invalid_frequency' };
  for (const field of ['day_of_week', 'day_of_month']) {
    const text = subscriptionText(body[field]);
    const required = field === (frequency === 'weekly' ? 'day_of_week' : 'day_of_month');
    if (text === '' && required) return { ok: false, error: 'missing_' + field };
    if (text !== '' && ((typeof body[field] !== 'string' && typeof body[field] !== 'number')
        || /^\d+$/.test(text) === false || !Number.isInteger(Number(text))
        || Number(text) < 1 || Number(text) > (field === 'day_of_week' ? 7 : 31))) {
      return { ok: false, error: 'invalid_' + field };
    }
  }
  const timezone = subscriptionText(body.subscription_timezone_local);
  if (body.subscription_timezone_local !== undefined && body.subscription_timezone_local !== null && typeof body.subscription_timezone_local !== 'string') {
    return { ok: false, error: 'invalid_subscription_timezone_local' };
  }
  if (timezone !== '') {
    try { _subscriptionDateFormatter(timezone).format(new Date()); }
    catch (error) { return { ok: false, error: 'invalid_subscription_timezone_local' }; }
  }
  const dates = {};
  for (const field of ['subscription_start_date_local', 'subscription_end_date_local']) {
    const value = subscriptionText(body[field]);
    if (value === '') { dates[field] = null; continue; }
    if (timezone === '') return { ok: false, error: 'missing_subscription_timezone_local' };
    const key = subscriptionLocalDateTimeKey(body[field]);
    if (key === null) return { ok: false, error: 'invalid_' + field };
    const wallError = subscriptionWallTimeError(key, timezone);
    if (wallError !== null) return { ok: false, error: wallError, field: field };
    dates[field] = key;
  }
  const start = dates.subscription_start_date_local, end = dates.subscription_end_date_local;
  if ((frequency === 'quarterly' || frequency === 'annual') && start === null) {
    return { ok: false, error: 'missing_subscription_start_date_local' };
  }
  if (start !== null && end !== null && end < start) return { ok: false, error: 'end_before_start' };
  return { ok: true };
}

function _validateSubscriptionReferences(body, references, historical) {
  return _subvFormError(_subvReferences(body, references, historical));
}

function _subvReferences(body, references, historical) {
  const account = references.accounts[subscriptionUuid(body.source_account)];
  if (account === undefined) return { ok: false, error: 'unknown_source_account' };
  if (historical !== true && subscriptionText(account.record_status) !== 'active') return { ok: false, error: 'source_account_not_active' };
  const keys = ['tx_type', 'major_category', 'minor_category'].map(function(field) { return subscriptionText(body[field]); });
  if (keys.every(function(key) { return key !== ''; })) {
    const category = references.categories[keys.join('|')];
    if (category === undefined) return { ok: false, error: 'unknown_category' };
    const status = subscriptionText(body.record_status);
    if (status === '' || status === 'active') {
      if (subscriptionText(category.record_status) !== 'active') return { ok: false, error: 'category_not_active' };
      if (toBool(category.is_subscription_eligible) !== true) return { ok: false, error: 'category_not_subscription_eligible' };
    }
  }
  return { ok: true, account_id: String(account.id).trim() };
}
