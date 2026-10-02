// =============================================================================
// FULCRUM FORGE — Subscription Core: CRUD and source-owned sync metadata
// =============================================================================

function _subscriptionRowObject(row, rowNumber) {
  const subscription = { _row: rowNumber };
  getSubscriptionSheetColumns().forEach(function(column, index) {
    const value = row[index];
    if (Object.prototype.toString.call(value) === '[object Date]') {
      if (!Number.isFinite(value.getTime())) { subscription[column] = ''; return; }
      if (column === 'subscription_start_date_local' || column === 'subscription_end_date_local') {
        // A Sheets date cell's wall-clock display uses the spreadsheet timezone,
        // not the subscription zone subsequently used to interpret that wall time.
        const zone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
        subscription[column] = Utilities.formatDate(value, zone, 'yyyy-MM-dd HH:mm:ss.SSS');
      } else {
        subscription[column] = value.toISOString();
      }
    } else {
      subscription[column] = value === undefined || value === null ? '' : value;
    }
  });
  return subscription;
}

function listSubscriptions() {
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, getSubscriptionSheetColumns());
  const now = new Date();
  return sheet.getDataRange().getValues().slice(1).map(function(row, index) {
    return _subscriptionRowObject(row, index + 2);
  }).filter(function(subscription) {
    return subscriptionText(subscription.id) !== '' || subscriptionText(subscription.subscription_name) !== '';
  }).map(function(subscription) {
    subscription.next_payment_date = '';
    subscription.schedule_status = 'inactive';
    subscription.record_status = subscriptionText(subscription.record_status);
    subscription.frequency = subscriptionText(subscription.frequency);
    if (subscription.record_status !== 'active') return subscription;
    const validation = _validateSchedule(subscription);
    if (validation.ok === false) {
      subscription.schedule_status = 'invalid';
      subscription.schedule_error = validation.error;
      return subscription;
    }
    const zone = subscriptionText(subscription.subscription_timezone_local) === '' ? 'Europe/London' : subscription.subscription_timezone_local;
    const today = _subscriptionLocalDate(now, zone);
    const start = subscriptionText(subscription.subscription_start_date_local).slice(0, 10);
    const end = subscriptionText(subscription.subscription_end_date_local).slice(0, 10);
    subscription.schedule_status = end !== '' && end < today ? 'expired' : start !== '' && start > today ? 'upcoming' : 'current';
    subscription.next_payment_date = computeNextPaymentDate(subscription.frequency, subscription.day_of_month, subscription.day_of_week,
      subscription.subscription_start_date_local, subscription.subscription_end_date_local, zone, now);
    return subscription;
  });
}

function _loadSubscriptionReferences() {
  const accounts = Object.create(null);
  sheetToObjects(getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns())).forEach(function(account) {
    const identity = subscriptionUuid(account.id);
    if (identity === null) return;
    if (accounts[identity] !== undefined) throw new Error('duplicate_source_account_id');
    accounts[identity] = account;
  });
  const categories = Object.create(null);
  sheetToObjects(getOrCreateSheet(CATEGORIES_SHEET, getCategorySheetColumns())).forEach(function(category) {
    if (subscriptionText(category.id) === '' && subscriptionText(category.tx_type_key) === '') return;
    const key = [category.tx_type_key, category.major_category_key, category.minor_category_key].map(subscriptionText).join('|');
    // Deleted duplicate category keys can coexist with their replacement. Prefer
    // the live definition and reject two live definitions instead of guessing.
    const previous = categories[key];
    if (previous !== undefined && previous.record_status !== 'deleted' && category.record_status !== 'deleted') {
      throw new Error('duplicate_subscription_category_key');
    }
    if (previous === undefined || previous.record_status === 'deleted') categories[key] = category;
  });
  return { accounts: accounts, categories: categories };
}

function _subscriptionDuplicateName(rows, name, excludedRow) {
  const normalized = subscriptionText(name).toLowerCase();
  return rows.some(function(row, index) {
    return index > 0 && index + 1 !== excludedRow && subscriptionText(row[subColIndex('record_status')]) !== 'deleted'
      && subscriptionText(row[subColIndex('subscription_name')]).toLowerCase() === normalized;
  });
}

function _subscriptionBuildRow(body, id, currentRow, now) {
  const row = currentRow === null ? new Array(getSubscriptionSheetColumns().length).fill('') : currentRow.slice();
  function setCol(key, value) { row[subColIndex(key)] = value; }
  function writeField(key, value) {
    if (getSubscriptionSchemaField(key).editable === true) row[subColIndex(key)] = value;
  }
  Object.keys(SUBSCRIPTION_SCHEMA).forEach(function(key) {
    const field = SUBSCRIPTION_SCHEMA[key];
    if (field.group !== 'core') return;
    let value = subscriptionText(body[key]);
    // Decimal text survives CSV/API import until the ETL converts to minor units.
    if ((key === 'day_of_month' || key === 'day_of_week') && value !== '') value = Number(value);
    if (key === 'subscription_timezone_local' && value !== '') value = _subscriptionDateFormatter(value).resolvedOptions().timeZone;
    if (currentRow === null) setCol(key, value); else writeField(key, value);
  });
  setCol('id', id);
  const requestedStatus = subscriptionText(body.record_status);
  const status = requestedStatus !== '' ? requestedStatus : currentRow === null ? 'active' : subscriptionText(currentRow[subColIndex('record_status')]);
  if (currentRow === null) setCol('record_status', status); else writeField('record_status', status);
  setCol('created_at', currentRow === null ? now : currentRow[subColIndex('created_at')]);
  setCol('updated_at', now);
  setCol('sync_status', currentRow === null ? SYNC_STATUS_CREATE_PENDING : computeSyncStatus(subscriptionText(currentRow[subColIndex('sync_status')])));
  setCol('sync_date', '');
  setCol('sync_notes', '');
  return row;
}

function createSubscription(body) {
  const validation = validateSubscriptionCreate(body);
  if (validation.ok === false) return validation;
  const references = _validateSubscriptionReferences(body, _loadSubscriptionReferences(), false);
  if (references.ok === false) return references;
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, getSubscriptionSheetColumns());
  const rows = sheet.getDataRange().getValues();
  if (_subscriptionDuplicateName(rows, body.subscription_name)) return { ok: false, error: 'duplicate_subscription' };
  const id = subscriptionText(body.id) === '' ? subscriptionUuid(generateSubscriptionId()) : subscriptionUuid(body.id);
  if (id === null) return { ok: false, error: 'invalid_id' };
  if (rows.slice(1).some(function(row) { return subscriptionUuid(row[subColIndex('id')]) === id; })) return { ok: false, error: 'duplicate_subscription_id' };
  const prepared = Object.assign({}, body, { source_account: references.account_id });
  sheet.appendRow(_subscriptionBuildRow(prepared, id, null, new Date().toISOString()));
  return { ok: true, id: id };
}

// ID-based CSV upsert. Failure rows remain retryable; imported sync/audit fields
// never replace server-owned state, and omitted lifecycle preserves existing rows.
function createSubscriptionsBulk(body) {
  if (!Array.isArray(body.subscriptions) || body.subscriptions.length === 0) return { ok: false, error: 'missing_subscriptions' };
  const columns = getSubscriptionSheetColumns();
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, columns);
  const rows = sheet.getDataRange().getValues();
  const rowById = Object.create(null);
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].every(function(value) { return value === '' || value === null || value === undefined; })) continue;
    const identity = subscriptionUuid(rows[index][subColIndex('id')]);
    if (identity === null) return { ok: false, error: 'invalid_existing_subscription_id' };
    if (rowById[identity] !== undefined) return { ok: false, error: 'duplicate_existing_subscription_id' };
    rowById[identity] = index + 1;
  }
  const references = _loadSubscriptionReferences();
  const results = [], seenIds = new Set();
  let created = 0, updated = 0, skipped = 0;
  const now = new Date().toISOString();
  body.subscriptions.forEach(function(subscription, index) {
    function fail(error, field) {
      const outcome = { index: index, key: subscription === null || typeof subscription !== 'object' ? '' : subscriptionText(subscription.id), ok: false, error: error };
      if (field !== undefined) outcome.field = field;
      results.push(outcome);
    }
    if (subscription === null || typeof subscription !== 'object' || Array.isArray(subscription)) { fail('invalid_row'); return; }
    const suppliedId = subscriptionText(subscription.id) !== '';
    const identity = subscriptionUuid(suppliedId ? subscription.id : generateSubscriptionId());
    if (identity === null) { fail('invalid_id'); return; }
    if (seenIds.has(identity)) { fail('duplicate_id_in_batch'); return; }
    seenIds.add(identity);
    const rowNumber = rowById[identity];
    if (!suppliedId && rowNumber !== undefined) { fail('duplicate_generated_subscription_id'); return; }
    const current = rowNumber === undefined ? null : rows[rowNumber - 1];
    if (current !== null && subscriptionText(current[subColIndex('record_status')]) === 'locked') { fail('record_locked'); return; }
    const prepared = Object.assign({}, subscription);
    if (subscriptionText(prepared.record_status) === '' && current !== null) prepared.record_status = current[subColIndex('record_status')];
    const validation = validateSubscriptionCreate(prepared);
    if (validation.ok === false) { fail(validation.error, validation.field); return; }
    const historicalReference = (subscriptionText(prepared.record_status) !== '' && subscriptionText(prepared.record_status) !== 'active')
      || (current !== null && subscriptionUuid(current[subColIndex('source_account')]) === subscriptionUuid(prepared.source_account));
    const referenceValidation = _validateSubscriptionReferences(prepared, references, historicalReference);
    if (referenceValidation.ok === false) { fail(referenceValidation.error); return; }
    prepared.source_account = referenceValidation.account_id;
    const storedId = current === null ? identity : String(current[subColIndex('id')]).trim();
    const row = _subscriptionBuildRow(prepared, storedId, current, now);
    // Same values as stored: leave the row (and its sync status) untouched.
    if (current !== null && importRowUnchanged(columns, current, row)) {
      results.push({ index: index, key: storedId, id: storedId, ok: true, action: 'unchanged' });
      skipped += 1;
      return;
    }
    if (current === null) {
      sheet.appendRow(row);
      rowById[identity] = sheet.getLastRow();
      rows[rowById[identity] - 1] = row;
      created += 1;
    } else {
      if (rowNumber < 2 || rowNumber > sheet.getLastRow()) { fail('invalid_row'); return; }
      sheet.getRange(rowNumber, 1, 1, columns.length).setValues([row]);
      rows[rowNumber - 1] = row;
      updated += 1;
    }
    results.push({ index: index, key: storedId, id: storedId, ok: true, action: current === null ? 'created' : 'updated' });
  });
  const failed = results.filter(function(result) { return result.ok === false; }).length;
  console.log('createSubscriptionsBulk: input=' + body.subscriptions.length + ' created=' + created + ' updated=' + updated + ' unchanged=' + skipped + ' failed=' + failed);
  return { ok: failed === 0, created: created, updated: updated, skipped: skipped, failed: failed, results: results };
}

function updateSubscription(body) {
  const requestValidation = validateSubscriptionUpdate(body);
  if (requestValidation.ok === false) return requestValidation;
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, getSubscriptionSheetColumns());
  const rowNumber = Number(body.row_num);
  if (rowNumber < 2 || rowNumber > sheet.getLastRow()) return { ok: false, error: 'invalid_row' };
  const rows = sheet.getDataRange().getValues();
  const current = rows[rowNumber - 1];
  if (matchesExpectedRecord(body, current[subColIndex('id')], current[subColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };
  const currentStatus = subscriptionText(current[subColIndex('record_status')]);
  if (currentStatus === 'locked') return { ok: false, error: 'record_locked' };
  if (currentStatus === 'deleted') return { ok: false, error: 'record_deleted' };
  const prepared = Object.assign(_subscriptionRowObject(current, rowNumber), body);
  const status = subscriptionText(body.record_status);
  if (body.record_status !== undefined && status !== 'active' && status !== 'inactive') return { ok: false, error: 'invalid_record_status' };
  const validation = validateSubscriptionCreate(prepared);
  if (validation.ok === false) return validation;
  const historicalReference = prepared.record_status !== 'active'
    || subscriptionUuid(current[subColIndex('source_account')]) === subscriptionUuid(prepared.source_account);
  const references = _validateSubscriptionReferences(prepared, _loadSubscriptionReferences(), historicalReference);
  if (references.ok === false) return references;
  if (_subscriptionDuplicateName(rows, prepared.subscription_name, rowNumber)) return { ok: false, error: 'duplicate_subscription' };
  prepared.source_account = references.account_id;
  const updated = _subscriptionBuildRow(prepared, current[subColIndex('id')], current, new Date().toISOString());
  if (rowNumber < 2 || rowNumber > sheet.getLastRow()) return { ok: false, error: 'invalid_row' };
  sheet.getRange(rowNumber, 1, 1, getSubscriptionSheetColumns().length).setValues([updated]);
  return { ok: true };
}

function _subscriptionLifecycleChange(body, restoring) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const rowNumber = Number(body.row_num);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) return { ok: false, error: 'invalid_row' };
  const columns = getSubscriptionSheetColumns();
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, columns);
  if (rowNumber > sheet.getLastRow()) return { ok: false, error: 'invalid_row' };
  const rows = sheet.getDataRange().getValues();
  const current = rows[rowNumber - 1];
  if (matchesExpectedRecord(body, current[subColIndex('id')], current[subColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };
  const status = subscriptionText(current[subColIndex('record_status')]);
  if (status === 'locked') return { ok: false, error: 'record_locked' };
  if (restoring && status !== 'deleted') return { ok: false, error: 'not_deleted' };
  if (!restoring && status === 'deleted') return { ok: false, error: 'subscription_already_deleted' };
  if (restoring) {
    const prepared = Object.assign(_subscriptionRowObject(current, rowNumber), { record_status: 'active' });
    const validation = validateSubscriptionCreate(prepared);
    if (validation.ok === false) return validation;
    const references = _validateSubscriptionReferences(prepared, _loadSubscriptionReferences(), true);
    if (references.ok === false) return references;
    if (_subscriptionDuplicateName(rows, prepared.subscription_name, rowNumber)) return { ok: false, error: 'duplicate_name' };
  }
  const updated = current.slice();
  updated[subColIndex('record_status')] = restoring ? 'active' : 'deleted';
  updated[subColIndex('sync_status')] = computeSyncStatus(subscriptionText(current[subColIndex('sync_status')]));
  updated[subColIndex('sync_date')] = '';
  updated[subColIndex('sync_notes')] = '';
  updated[subColIndex('updated_at')] = new Date().toISOString();
  if (rowNumber < 2 || rowNumber > sheet.getLastRow()) return { ok: false, error: 'invalid_row' };
  sheet.getRange(rowNumber, 1, 1, columns.length).setValues([updated]);
  return { ok: true };
}

function restoreSubscription(body) { return _subscriptionLifecycleChange(body, true); }
function deleteSubscription(body) { return _subscriptionLifecycleChange(body, false); }

function markSubscriptionEditPending(event) {
  const editedSheet = event.range.getSheet();
  if (editedSheet.getName() !== SUBSCRIPTIONS_SHEET) return false;
  _assertMasterSheetNameReady(SpreadsheetApp.getActiveSpreadsheet(), SUBSCRIPTIONS_SHEET);
  const firstColumn = event.range.getColumn(), lastColumn = firstColumn + event.range.getNumColumns() - 1;
  const businessEdit = Object.keys(SUBSCRIPTION_SCHEMA).some(function(key) {
    const field = SUBSCRIPTION_SCHEMA[key];
    return (field.group === 'core' || key === 'id' || key === 'record_status')
      && field.sheet_column_position >= firstColumn && field.sheet_column_position <= lastColumn;
  });
  if (!businessEdit) return true;
  const firstRow = Math.max(2, event.range.getRow());
  const lastRow = Math.min(editedSheet.getLastRow(), event.range.getRow() + event.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const columns = getSubscriptionSheetColumns();
  const headers = editedSheet.getRange(1, 1, 1, editedSheet.getLastColumn()).getValues()[0];
  if (headers.length !== columns.length || headers.some(function(header, index) { return header !== columns[index]; })) throw new Error('sheet_header_mismatch');
  const sheet = getOrCreateSheet(SUBSCRIPTIONS_SHEET, columns);
  const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, columns.length).getValues();
  const now = new Date().toISOString();
  let queued = 0;
  const metadata = rows.map(function(row) {
    if (row.every(function(value) { return value === '' || value === null || value === undefined; })) return ['', '', '', ''];
    queued += 1;
    return [computeSyncStatus(subscriptionText(row[subColIndex('sync_status')])), '', '', now];
  });
  if (queued === 0) return true;
  if (firstRow < 2 || lastRow > sheet.getLastRow()) throw new Error('invalid_row');
  sheet.getRange(firstRow, subColIndex('sync_status') + 1, metadata.length, 4).setValues(metadata);
  return true;
}
