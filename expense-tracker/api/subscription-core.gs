// =============================================================================
// FULCRUM FORGE — Subscription Core: CRUD operations
// =============================================================================

function listSubscriptions() {
  const cols  = getSubscriptionSheetColumns();
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rows  = sheetToObjectsWithRow(sheet);

  rows.forEach(function(row) {
    const isActive = row.is_active === true || String(row.is_active).toLowerCase() === 'true';
    row.is_active = isActive;
    if (!isActive) {
      row.next_payment_date = '';
      return;
    }
    row.next_payment_date = computeNextPaymentDate(
      row.frequency,
      row.day_of_month,
      row.day_of_week
    );
  });

  return rows;
}

function createSubscription(body) {
  const validation = validateSubscriptionCreate(body);
  if (!validation.ok) return validation;

  const cols  = getSubscriptionSheetColumns();
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);

  // Duplicate guard — reject if a subscription with the same name already exists
  const nameColIdx   = subColIndex('name');
  const existingRows = sheet.getDataRange().getValues();
  const normName     = String(body.name).trim().toLowerCase();
  for (let i = 1; i < existingRows.length; i++) {
    if (String(existingRows[i][nameColIdx] || '').trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_subscription' };
    }
  }

  const id  = generateSubscriptionId(sheet);
  const now = new Date().toISOString();

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getSubscriptionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',               id);
  setCol('name',             String(body.name).trim());
  setCol('counterparty_name', String(body.counterparty_name || '').trim());
  setCol('amount',           Number(body.amount));
  setCol('currency',         String(body.currency).trim().toUpperCase());
  setCol('frequency',        String(body.frequency).trim());
  setCol('day_of_month',     body.day_of_month !== undefined && body.day_of_month !== '' ? Number(body.day_of_month) : '');
  setCol('day_of_week',      body.day_of_week  !== undefined && body.day_of_week  !== '' ? Number(body.day_of_week)  : '');
  setCol('source_account',   String(body.source_account).trim());
  setCol('major_category',   String(body.major_category || '').trim());
  setCol('minor_category',   String(body.minor_category || '').trim());
  setCol('tags',             normaliseTags(body.tags || ''));
  setCol('is_active',        true);
  setCol('description',      String(body.description || '').trim());
  setCol('created_at',       now);
  setCol('tx_type',          String(body.tx_type || '').trim());

  sheet.appendRow(row);
  return { ok: true, id: id };
}

function createSubscriptionsBulk(body) {
  if (!Array.isArray(body.subscriptions) || body.subscriptions.length === 0)
    return { ok: false, error: 'missing_subscriptions' };

  const results = [];
  body.subscriptions.forEach(function(sub) {
    const subBody = {};
    Object.keys(sub).forEach(function(k) { subBody[k] = sub[k]; });
    subBody.pin = body.pin;
    const r = createSubscription(subBody);
    results.push({ name: sub.name || '', ok: r.ok, error: r.error || null, id: r.id || null });
  });

  const failed  = results.filter(function(r) { return !r.ok && r.error !== 'duplicate_subscription'; });
  const skipped = results.filter(function(r) { return r.error === 'duplicate_subscription'; });
  return {
    ok:      failed.length === 0,
    created: results.length - failed.length - skipped.length,
    skipped: skipped.length,
    failed:  failed.length,
    results: results,
  };
}

function updateSubscription(body) {
  const validation = validateSubscriptionUpdate(body);
  if (!validation.ok) return validation;

  const cols    = getSubscriptionSheetColumns();
  const sheet   = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  function writeField(key, value) {
    const field = getSubscriptionSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('name',             String(body.name).trim());
  writeField('counterparty_name', String(body.counterparty_name || '').trim());
  writeField('amount',           body.amount !== undefined && body.amount !== '' ? Number(body.amount) : '');
  writeField('currency',         body.currency !== undefined ? String(body.currency).trim().toUpperCase() : '');
  writeField('frequency',        body.frequency !== undefined ? String(body.frequency).trim() : '');
  writeField('day_of_month',     body.day_of_month !== undefined && body.day_of_month !== '' ? Number(body.day_of_month) : '');
  writeField('day_of_week',      body.day_of_week  !== undefined && body.day_of_week  !== '' ? Number(body.day_of_week)  : '');
  writeField('source_account',   body.source_account !== undefined ? String(body.source_account).trim() : '');
  writeField('major_category',   String(body.major_category || '').trim());
  writeField('minor_category',   String(body.minor_category || '').trim());
  writeField('tags',             normaliseTags(body.tags || ''));
  writeField('is_active',        body.is_active === true || body.is_active === 'true');
  writeField('description',      String(body.description || '').trim());
  writeField('tx_type',          String(body.tx_type || '').trim());

  return { ok: true };
}

function deleteSubscription(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };

  const cols    = getSubscriptionSheetColumns();
  const sheet   = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  sheet.deleteRow(rowNum);
  return { ok: true };
}
