// =============================================================================
// FULCRUM FORGE — Subscription Core: CRUD operations
// =============================================================================

function listSubscriptions() {
  const cols  = getSubscriptionSheetColumns();
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rows  = sheetToObjectsWithRow(sheet);

  const today           = new Date().toISOString().slice(0, 10);
  const nowStr          = new Date().toISOString();
  const recordStatusPos = getSubscriptionSchemaField('record_status').sheet_column_position;
  const updatedAtPos    = getSubscriptionSchemaField('updated_at').sheet_column_position;

  const visible = rows.filter(function(row) { return String(row.record_status) !== 'deleted'; });

  visible.forEach(function(row) {
    // Lazy expiry: if end_date is past and subscription is still active, mark inactive
    if (String(row.record_status) === 'active' && row.subscription_end_date) {
      const endDate = String(row.subscription_end_date).slice(0, 10);
      if (endDate && endDate < today) {
        sheet.getRange(row._row, recordStatusPos).setValue('inactive');
        sheet.getRange(row._row, updatedAtPos).setValue(nowStr);
        row.record_status = 'inactive';
      }
    }

    if (String(row.record_status) !== 'active') {
      row.next_payment_date = '';
      return;
    }
    row.next_payment_date = computeNextPaymentDate(
      row.frequency,
      row.day_of_month,
      row.day_of_week
    );
  });

  return visible;
}

function createSubscription(body) {
  const validation = validateSubscriptionCreate(body);
  if (!validation.ok) return validation;

  const cols  = getSubscriptionSheetColumns();
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);

  // Duplicate guard — reject if an active subscription with the same name already exists
  const nameColIdx   = subColIndex('name');
  const statusColIdx = subColIndex('record_status');
  const existingRows = sheet.getDataRange().getValues();
  const normName     = String(body.name).trim().toLowerCase();
  for (let i = 1; i < existingRows.length; i++) {
    if (String(existingRows[i][statusColIdx]) === 'deleted') continue;
    if (String(existingRows[i][nameColIdx]).trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_subscription' };
    }
  }

  const id  = generateSubscriptionId(sheet);
  const now = new Date().toISOString();

  // Derive initial record_status: inactive if end_date is already past
  const endDate     = body.subscription_end_date ? String(body.subscription_end_date).trim() : '';
  const today       = now.slice(0, 10);
  const initStatus  = (endDate && endDate < today) ? 'inactive' : 'active';

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getSubscriptionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',               id);
  setCol('name',             String(body.name).trim());
  setCol('counterparty_name', body.counterparty_name !== undefined ? String(body.counterparty_name).trim() : '');
  setCol('amount',           Number(body.amount));
  setCol('currency',         String(body.currency).trim().toUpperCase());
  setCol('frequency',        String(body.frequency).trim());
  setCol('day_of_month',     body.day_of_month !== undefined && body.day_of_month !== '' ? Number(body.day_of_month) : '');
  setCol('day_of_week',      body.day_of_week  !== undefined && body.day_of_week  !== '' ? Number(body.day_of_week)  : '');
  setCol('source_account',   String(body.source_account).trim());
  setCol('major_category',   body.major_category !== undefined ? String(body.major_category).trim() : '');
  setCol('minor_category',   body.minor_category !== undefined ? String(body.minor_category).trim() : '');
  setCol('tags',             normaliseTags(body.tags !== undefined ? body.tags : ''));
  setCol('description',      body.description !== undefined ? String(body.description).trim() : '');
  setCol('created_at',       now);
  setCol('tx_type',          body.tx_type !== undefined ? String(body.tx_type).trim() : '');
  setCol('record_status',    initStatus);
  setCol('sync_status',      SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date_time',   '');
  setCol('sync_notes',       '');
  setCol('updated_at',       now);
  setCol('subscription_start_date', body.subscription_start_date ? String(body.subscription_start_date).trim() : '');
  setCol('subscription_end_date',   endDate);

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
    results.push({ name: sub.name, ok: r.ok, error: r.error, id: r.id });
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

  const allRows = sheet.getDataRange().getValues();
  if (String(allRows[rowNum - 1][subColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentSyncStatus = String(allRows[rowNum - 1][subColIndex('sync_status')]);

  // Toggle path: caller explicitly sends record_status ('active' or 'inactive' only)
  if (body.record_status !== undefined) {
    const rs = String(body.record_status);
    if (rs !== 'active' && rs !== 'inactive') return { ok: false, error: 'invalid_record_status' };
    sheet.getRange(rowNum, getSubscriptionSchemaField('record_status').sheet_column_position).setValue(rs);
  }

  function writeField(key, value) {
    const field = getSubscriptionSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('name',             String(body.name).trim());
  writeField('counterparty_name', body.counterparty_name !== undefined ? String(body.counterparty_name).trim() : '');
  writeField('amount',           body.amount !== undefined && body.amount !== '' ? Number(body.amount) : '');
  writeField('currency',         body.currency !== undefined ? String(body.currency).trim().toUpperCase() : '');
  writeField('frequency',        body.frequency !== undefined ? String(body.frequency).trim() : '');
  writeField('day_of_month',     body.day_of_month !== undefined && body.day_of_month !== '' ? Number(body.day_of_month) : '');
  writeField('day_of_week',      body.day_of_week  !== undefined && body.day_of_week  !== '' ? Number(body.day_of_week)  : '');
  writeField('source_account',   body.source_account !== undefined ? String(body.source_account).trim() : '');
  writeField('major_category',   body.major_category !== undefined ? String(body.major_category).trim() : '');
  writeField('minor_category',   body.minor_category !== undefined ? String(body.minor_category).trim() : '');
  writeField('tags',             normaliseTags(body.tags !== undefined ? body.tags : ''));
  writeField('description',      body.description !== undefined ? String(body.description).trim() : '');
  writeField('tx_type',          body.tx_type !== undefined ? String(body.tx_type).trim() : '');
  writeField('subscription_start_date', body.subscription_start_date !== undefined ? String(body.subscription_start_date).trim() : '');
  writeField('subscription_end_date',   body.subscription_end_date   !== undefined ? String(body.subscription_end_date).trim()   : '');

  const syncStatusCol = getSubscriptionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol  = getSubscriptionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol  = getSubscriptionSchemaField('updated_at').sheet_column_position;
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol).setValue(new Date().toISOString());

  return { ok: true };
}

function deleteSubscription(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };

  const cols    = getSubscriptionSheetColumns();
  const sheet   = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const allRows = sheet.getDataRange().getValues();
  if (String(allRows[rowNum - 1][subColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentSyncStatus = String(allRows[rowNum - 1][subColIndex('sync_status')]);

  const recordStatusCol = getSubscriptionSchemaField('record_status').sheet_column_position;
  const syncStatusCol   = getSubscriptionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol    = getSubscriptionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol    = getSubscriptionSchemaField('updated_at').sheet_column_position;

  sheet.getRange(rowNum, recordStatusCol).setValue('deleted');
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol).setValue(new Date().toISOString());

  return { ok: true };
}
