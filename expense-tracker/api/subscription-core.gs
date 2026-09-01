// =============================================================================
// FULCRUM FORGE — Subscription Core: CRUD operations
// =============================================================================

function listSubscriptions() {
  const cols     = getSubscriptionSheetColumns();
  const sheet    = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const totalCols = cols.length;

  // Single read — used for both the object array and the raw-row write-back.
  const rawData = sheet.getDataRange().getValues();
  const rows = rawData.length <= 1 ? [] : (function() {
    const headers = rawData[0];
    return rawData.slice(1).map(function(r, i) {
      const obj = { _row: i + 2 };
      headers.forEach(function(h, j) { obj[h] = (r[j] !== null && r[j] !== undefined) ? r[j] : ''; });
      return obj;
    });
  })();

  const nowLocal        = new Date();
  const today           = nowLocal.getFullYear() + '-' +
    String(nowLocal.getMonth() + 1).padStart(2, '0') + '-' +
    String(nowLocal.getDate()).padStart(2, '0');
  const nowStr          = nowLocal.toISOString();
  const recordStatusPos = getSubscriptionSchemaField('record_status').sheet_column_position;
  const updatedAtPos    = getSubscriptionSchemaField('updated_at').sheet_column_position;
  const syncStatusPos   = getSubscriptionSchemaField('sync_status').sheet_column_position;
  const syncNotesPos    = getSubscriptionSchemaField('sync_notes').sheet_column_position;

  const visible = rows.filter(function(row) { return String(row.record_status) !== 'deleted'; });

  // Collect expired rows in-memory during the scan pass; write them all after the loop.
  const expiredWrites = []; // { rowNum, updatedRow }

  visible.forEach(function(row) {
    // Lazy expiry: if end_date is past and subscription is still active, mark inactive
    if (String(row.record_status) === 'active'
        && row.subscription_end_date !== undefined
        && row.subscription_end_date !== null
        && String(row.subscription_end_date).trim() !== ''
        && String(row.subscription_end_date).trim() < today) {
      const newSyncStatus = computeSyncStatus(String(row.sync_status));
      const updatedRow    = rawData[row._row - 1].slice();
      updatedRow[recordStatusPos - 1] = 'inactive';
      updatedRow[updatedAtPos    - 1] = nowStr;
      updatedRow[syncStatusPos   - 1] = newSyncStatus;
      updatedRow[syncNotesPos    - 1] = '';
      expiredWrites.push({ rowNum: row._row, updatedRow: updatedRow });
      row.record_status = 'inactive';
      row.updated_at    = nowStr;
      row.sync_status   = newSyncStatus;
      row.sync_notes    = '';
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

  // Batch write all expired rows — one setValues call per expired row.
  expiredWrites.forEach(function(w) {
    sheet.getRange(w.rowNum, 1, 1, totalCols).setValues([w.updatedRow]);
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

  const id      = generateSubscriptionId(sheet, existingRows);
  const nowObj  = new Date();
  const now     = nowObj.toISOString();
  const today   = nowObj.getFullYear() + '-' +
    String(nowObj.getMonth() + 1).padStart(2, '0') + '-' +
    String(nowObj.getDate()).padStart(2, '0');

  // Derive initial record_status: inactive if end_date is already past
  const endDate     = body.subscription_end_date !== undefined && body.subscription_end_date !== null ? String(body.subscription_end_date).trim() : '';
  const initStatus  = (endDate !== '' && endDate < today) ? 'inactive' : 'active';

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getSubscriptionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',               id);
  setCol('name',             String(body.name).trim());
  setCol('counterparty_name', body.counterparty_name !== undefined && body.counterparty_name !== null ? String(body.counterparty_name).trim() : '');
  setCol('amount',           Number(body.amount));
  setCol('currency',         String(body.currency).trim().toUpperCase());
  setCol('frequency',        String(body.frequency).trim());
  setCol('day_of_month',     body.day_of_month !== undefined && body.day_of_month !== null && body.day_of_month !== '' ? Number(body.day_of_month) : '');
  setCol('day_of_week',      body.day_of_week  !== undefined && body.day_of_week  !== null && body.day_of_week  !== '' ? Number(body.day_of_week)  : '');
  setCol('source_account',   String(body.source_account).trim());
  setCol('major_category',   body.major_category !== undefined && body.major_category !== null ? String(body.major_category).trim() : '');
  setCol('minor_category',   body.minor_category !== undefined && body.minor_category !== null ? String(body.minor_category).trim() : '');
  setCol('tags',             normaliseTags(body.tags !== undefined && body.tags !== null ? body.tags : ''));
  setCol('description',      body.description !== undefined && body.description !== null ? String(body.description).trim() : '');
  setCol('created_at',       now);
  setCol('tx_type',          body.tx_type !== undefined && body.tx_type !== null ? String(body.tx_type).trim() : '');
  setCol('record_status',    initStatus);
  setCol('sync_status',      SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date_time',   '');
  setCol('sync_notes',       '');
  setCol('updated_at',       now);
  setCol('subscription_start_date', body.subscription_start_date !== undefined && body.subscription_start_date !== null ? String(body.subscription_start_date).trim() : '');
  setCol('subscription_end_date',   endDate);

  sheet.appendRow(row);
  return { ok: true, id: id };
}

function createSubscriptionsBulk(body) {
  if (!Array.isArray(body.subscriptions) || body.subscriptions.length === 0)
    return { ok: false, error: 'missing_subscriptions' };

  const cols    = getSubscriptionSheetColumns();
  const sheet   = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const numCols = cols.length;
  const nowObj  = new Date();
  const now     = nowObj.toISOString();
  const today   = nowObj.getFullYear() + '-' +
    String(nowObj.getMonth() + 1).padStart(2, '0') + '-' +
    String(nowObj.getDate()).padStart(2, '0');

  // Build the duplicate-name set once from existing sheet rows.
  // Also capture the ID base so we can generate sequential IDs without re-reading the sheet.
  const nameColIdx   = subColIndex('name');
  const statusColIdx = subColIndex('record_status');
  const existingData = sheet.getDataRange().getValues();
  const dupNameSet   = new Set();
  for (let i = 1; i < existingData.length; i++) {
    if (String(existingData[i][statusColIdx]) === 'deleted') continue;
    dupNameSet.add(String(existingData[i][nameColIdx]).trim().toLowerCase());
  }
  const idBase    = _subscriptionIdBase(existingData);
  let   idCounter = idBase.max;

  // Build one sheet-row array in memory without touching the sheet.
  function buildRow(b, id, initStatus) {
    const row = new Array(numCols).fill('');
    function setC(key, value) {
      const f = getSubscriptionSchemaField(key);
      if (f) row[f.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
    }
    const endDate = b.subscription_end_date !== undefined && b.subscription_end_date !== null ? String(b.subscription_end_date).trim() : '';
    setC('id',               id);
    setC('name',             String(b.name).trim());
    setC('counterparty_name', b.counterparty_name !== undefined && b.counterparty_name !== null ? String(b.counterparty_name).trim() : '');
    setC('amount',           Number(b.amount));
    setC('currency',         String(b.currency).trim().toUpperCase());
    setC('frequency',        String(b.frequency).trim());
    setC('day_of_month',     b.day_of_month !== undefined && b.day_of_month !== null && b.day_of_month !== '' ? Number(b.day_of_month) : '');
    setC('day_of_week',      b.day_of_week  !== undefined && b.day_of_week  !== null && b.day_of_week  !== '' ? Number(b.day_of_week)  : '');
    setC('source_account',   String(b.source_account).trim());
    setC('major_category',   b.major_category !== undefined && b.major_category !== null ? String(b.major_category).trim() : '');
    setC('minor_category',   b.minor_category !== undefined && b.minor_category !== null ? String(b.minor_category).trim() : '');
    setC('tags',             normaliseTags(b.tags !== undefined && b.tags !== null ? b.tags : ''));
    setC('description',      b.description !== undefined && b.description !== null ? String(b.description).trim() : '');
    setC('created_at',       now);
    setC('tx_type',          b.tx_type !== undefined && b.tx_type !== null ? String(b.tx_type).trim() : '');
    setC('record_status',    initStatus);
    setC('sync_status',      SYNC_STATUS_CREATE_PENDING);
    setC('sync_date_time',   '');
    setC('sync_notes',       '');
    setC('updated_at',       now);
    setC('subscription_start_date', b.subscription_start_date !== undefined && b.subscription_start_date !== null ? String(b.subscription_start_date).trim() : '');
    setC('subscription_end_date',   endDate);
    return row;
  }

  // Process each subscription in-memory, accumulate valid rows for a single write.
  const batchRows = [];
  const results   = [];

  body.subscriptions.forEach(function(sub) {
    const subBody = Object.assign({}, sub);
    const label   = sub.name !== undefined && sub.name !== null ? String(sub.name) : '';

    const val = validateSubscriptionCreate(subBody);
    if (!val.ok) {
      results.push({ name: label, ok: false, error: val.error, id: null });
      return;
    }

    const normName = String(subBody.name).trim().toLowerCase();
    if (dupNameSet.has(normName)) {
      results.push({ name: label, ok: false, error: 'duplicate_subscription', id: null });
      return;
    }

    idCounter++;
    const id         = idBase.prefix + String(idCounter).padStart(3, '0');
    const endDate    = subBody.subscription_end_date !== undefined && subBody.subscription_end_date !== null ? String(subBody.subscription_end_date).trim() : '';
    const initStatus = (endDate !== '' && endDate < today) ? 'inactive' : 'active';

    // Add name to dup set so within-batch duplicates are also caught.
    dupNameSet.add(normName);
    batchRows.push(buildRow(subBody, id, initStatus));
    results.push({ name: label, ok: true, error: null, id: id });
  });

  // Single write for the entire valid batch.
  if (batchRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, batchRows.length, numCols).setValues(batchRows);
  }

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

  const cols     = getSubscriptionSheetColumns();
  const sheet    = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rowNum   = Number(body.row_num);
  if (!Number.isFinite(rowNum) || !Number.isInteger(rowNum)) return { ok: false, error: 'invalid_row' };
  const lastRow  = sheet.getLastRow();
  const totalCols = cols.length;
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const allRows = sheet.getDataRange().getValues();
  if (String(allRows[rowNum - 1][subColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentSyncStatus = String(allRows[rowNum - 1][subColIndex('sync_status')]);

  // Build the updated row from the current row, then apply changes in memory.
  const updatedRow = allRows[rowNum - 1].slice();

  function setField(key, value) {
    const field = getSubscriptionSchemaField(key);
    if (!field || !field.editable) return;
    updatedRow[field.sheet_column_position - 1] = value;
  }

  // Toggle path: caller explicitly sends record_status ('active' or 'inactive' only)
  if (body.record_status !== undefined) {
    const rs = String(body.record_status);
    if (rs !== 'active' && rs !== 'inactive') return { ok: false, error: 'invalid_record_status' };
    updatedRow[getSubscriptionSchemaField('record_status').sheet_column_position - 1] = rs;
  }

  setField('name',             String(body.name).trim());
  setField('counterparty_name', body.counterparty_name !== undefined && body.counterparty_name !== null ? String(body.counterparty_name).trim() : '');
  if (body.amount !== undefined && body.amount !== null) setField('amount', Number(body.amount));
  setField('currency',         String(body.currency).trim().toUpperCase());
  setField('frequency',        String(body.frequency).trim());
  setField('day_of_month',     body.day_of_month !== undefined && body.day_of_month !== null && body.day_of_month !== '' ? Number(body.day_of_month) : '');
  setField('day_of_week',      body.day_of_week  !== undefined && body.day_of_week  !== null && body.day_of_week  !== '' ? Number(body.day_of_week)  : '');
  setField('source_account',   body.source_account !== undefined && body.source_account !== null ? String(body.source_account).trim() : '');
  setField('major_category',   body.major_category !== undefined && body.major_category !== null ? String(body.major_category).trim() : '');
  setField('minor_category',   body.minor_category !== undefined && body.minor_category !== null ? String(body.minor_category).trim() : '');
  setField('tags',             normaliseTags(body.tags !== undefined && body.tags !== null ? body.tags : ''));
  setField('description',      body.description !== undefined && body.description !== null ? String(body.description).trim() : '');
  setField('tx_type',          body.tx_type !== undefined && body.tx_type !== null ? String(body.tx_type).trim() : '');
  setField('subscription_start_date', body.subscription_start_date !== undefined && body.subscription_start_date !== null ? String(body.subscription_start_date).trim() : '');
  setField('subscription_end_date',   body.subscription_end_date   !== undefined && body.subscription_end_date   !== null ? String(body.subscription_end_date).trim()   : '');

  updatedRow[getSubscriptionSchemaField('sync_status').sheet_column_position - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[getSubscriptionSchemaField('sync_notes').sheet_column_position  - 1] = '';
  updatedRow[getSubscriptionSchemaField('updated_at').sheet_column_position  - 1] = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, totalCols).setValues([updatedRow]);

  return { ok: true };
}

function restoreSubscription(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };

  const cols    = getSubscriptionSheetColumns();
  const sheet   = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  if (!Number.isFinite(rowNum) || !Number.isInteger(rowNum)) return { ok: false, error: 'invalid_row' };
  const lastRow   = sheet.getLastRow();
  const totalCols = cols.length;
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const rstatCol       = getSubscriptionSchemaField('record_status').sheet_column_position;
  const nameColIdx     = getSubscriptionSchemaField('name').sheet_column_position;
  const syncStatusCol  = getSubscriptionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol   = getSubscriptionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol   = getSubscriptionSchemaField('updated_at').sheet_column_position;

  // Single full read — extract target row and use same data for duplicate scan
  const allData           = sheet.getDataRange().getValues();
  const targetRow         = allData[rowNum - 1];
  const currentRecordStatus = String(targetRow[rstatCol - 1]);
  if (currentRecordStatus !== 'deleted') return { ok: false, error: 'not_deleted' };

  const normName          = String(targetRow[nameColIdx - 1]).trim().toLowerCase();
  const currentSyncStatus = String(targetRow[syncStatusCol - 1]);

  // Duplicate guard — reject if any non-deleted subscription with the same name already exists
  for (let i = 1; i < allData.length; i++) {
    if (i === rowNum - 1) continue; // skip the row being restored
    if (String(allData[i][rstatCol - 1]) === 'deleted') continue;
    if (String(allData[i][nameColIdx - 1]).trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_name' };
    }
  }

  // Read the full row, mutate needed columns in memory, write back in a single call.
  const updatedRow = allData[rowNum - 1].slice();
  updatedRow[rstatCol      - 1] = 'active';
  updatedRow[syncStatusCol - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[syncNotesCol  - 1] = '';
  updatedRow[updatedAtCol  - 1] = new Date().toISOString();
  sheet.getRange(rowNum, 1, 1, totalCols).setValues([updatedRow]);

  return { ok: true };
}

function deleteSubscription(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };

  const cols    = getSubscriptionSheetColumns();
  const sheet   = getOrCreateSheet(SUBSCRIPTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  if (!Number.isFinite(rowNum) || !Number.isInteger(rowNum)) return { ok: false, error: 'invalid_row' };
  const lastRow   = sheet.getLastRow();
  const totalCols = cols.length;
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const allRows = sheet.getDataRange().getValues();
  if (String(allRows[rowNum - 1][subColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentSyncStatus = String(allRows[rowNum - 1][subColIndex('sync_status')]);

  const recordStatusCol = getSubscriptionSchemaField('record_status').sheet_column_position;
  const syncStatusCol   = getSubscriptionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol    = getSubscriptionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol    = getSubscriptionSchemaField('updated_at').sheet_column_position;

  // Read the full row, mutate needed columns in memory, write back in a single call.
  const updatedRow = allRows[rowNum - 1].slice();
  updatedRow[recordStatusCol - 1] = 'deleted';
  updatedRow[syncStatusCol   - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[syncNotesCol    - 1] = '';
  updatedRow[updatedAtCol    - 1] = new Date().toISOString();
  sheet.getRange(rowNum, 1, 1, totalCols).setValues([updatedRow]);

  return { ok: true };
}
