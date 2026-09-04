// =============================================================================
// FULCRUM FORGE — Subscription Validation
// All validation is driven by SUBSCRIPTION_SCHEMA (subscription-schema.gs).
// =============================================================================

function validateSubscriptionCreate(body) {
  if (body.name === undefined || body.name === null || String(body.name).trim() === '')
    return { ok: false, error: 'missing_name' };

  if (body.subscription_amount_local === undefined || body.subscription_amount_local === null) return { ok: false, error: 'missing_subscription_amount_local' };
  const amount = Number(body.subscription_amount_local);
  if (isNaN(amount) || amount <= 0) return { ok: false, error: 'invalid_subscription_amount_local' };

  if (body.source_account === undefined || body.source_account === null || String(body.source_account).trim() === '')
    return { ok: false, error: 'missing_source_account' };

  const schedErr = _validateSchedule(body);
  if (!schedErr.ok) return schedErr;

  if (body.tx_type !== undefined && body.tx_type !== null && String(body.tx_type).trim() !== '') {
    if (['money-in', 'money-out'].indexOf(String(body.tx_type).trim()) === -1) {
      return { ok: false, error: 'invalid_tx_type' };
    }
  }

  return { ok: true };
}

function validateSubscriptionUpdate(body) {
  if (body.row_num === undefined || body.row_num === null)
    return { ok: false, error: 'missing_row_num' };
  if (!Number.isInteger(Number(body.row_num)) || Number(body.row_num) < 2)
    return { ok: false, error: 'invalid_row' };
  if (body.name === undefined || body.name === null || String(body.name).trim() === '')
    return { ok: false, error: 'missing_name' };
  if (body.source_account === undefined || body.source_account === null || String(body.source_account).trim() === '')
    return { ok: false, error: 'missing_source_account' };

  if (body.frequency === undefined || body.frequency === null || String(body.frequency).trim() === '') {
    return { ok: false, error: 'missing_frequency' };
  }

  if (body.subscription_amount_local !== undefined && body.subscription_amount_local !== null) {
    const amount = Number(body.subscription_amount_local);
    if (isNaN(amount) || amount <= 0) return { ok: false, error: 'invalid_subscription_amount_local' };
  }

  const schedErr = _validateSchedule(body);
  if (!schedErr.ok) return schedErr;

  if (body.tx_type !== undefined && body.tx_type !== null && String(body.tx_type).trim() !== '') {
    if (['money-in', 'money-out'].indexOf(String(body.tx_type).trim()) === -1) {
      return { ok: false, error: 'invalid_tx_type' };
    }
  }

  // Reject attempts to send immutable fields
  const fields = getFieldsForSubscriptionType(null);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field.editable && body[field.key] !== undefined) {
      return { ok: false, error: 'field_not_editable', field: field.key };
    }
  }

  return { ok: true };
}

function _validateSchedule(body) {
  if (body.frequency === undefined || body.frequency === null || String(body.frequency).trim() === '')
    return { ok: false, error: 'missing_frequency' };
  const frequency = String(body.frequency).trim();
  if (VALID_FREQUENCIES.indexOf(frequency) === -1) return { ok: false, error: 'invalid_frequency' };

  if (frequency === 'weekly') {
    if (body.day_of_week === undefined || body.day_of_week === null) return { ok: false, error: 'missing_day_of_week' };
    const dow = Number(body.day_of_week);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7)  return { ok: false, error: 'invalid_day_of_week' };
  } else {
    // monthly / quarterly / annual — day_of_month required
    if (body.day_of_month === undefined || body.day_of_month === null) return { ok: false, error: 'missing_day_of_month' };
    const dom = Number(body.day_of_month);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31)  return { ok: false, error: 'invalid_day_of_month' };
  }

  return { ok: true };
}
