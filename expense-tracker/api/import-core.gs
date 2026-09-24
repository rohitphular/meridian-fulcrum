// =============================================================================
// FULCRUM FORGE — Import Core: generic multi-file-type account data importer
//
// Action: import_account_data
// Body:   { action:'import_account_data', pin, file_type, rows }
//         rows = array of plain objects keyed by column name (header → value).
//
// Behaviour: id-based upsert. Each detail row carries an `id` (required by the
//   registry for every detail file_type). One sheet read builds a map of
//   id → 1-based row number. A row whose id is not present is INSERTED (appended);
//   a row whose id is present REPLACES that row in place (all columns overwritten).
//   created_at is preserved and updated_at / sync_status advanced on replacement.
// Response: { ok, file_type, created, updated, failed, results:[{ key, ok, action, error? }] }
//           ok === true iff failed === 0. action is 'created' | 'updated'.
// =============================================================================

function importAccountData(body) {
  const fileType = (body.file_type !== undefined && body.file_type !== null) ? String(body.file_type).trim() : '';
  if (fileType === '') return { ok: false, error: 'missing_file_type' };

  const spec = getImportSpec(fileType);
  if (spec === null) return { ok: false, error: 'unknown_file_type' };

  const rows = body.rows;
  if (Array.isArray(rows) === false || rows.length === 0) return { ok: false, error: 'missing_rows' };

  // account_master delegates to the id-based bulk-account upsert, which already
  // handles id assignment, liability negation, created_at preservation, and the
  // { ok, created, updated, failed, results } shape. Attach file_type to match the
  // detail-path response contract.
  if (fileType === 'account_master') {
    console.log('importAccountData: file_type=account_master rows=' + rows.length + ' delegated=create_accounts_bulk');
    const bulkResult = createAccountsBulk({ accounts: rows });
    return Object.assign({ file_type: fileType }, bulkResult);
  }

  // Validate and canonicalize all supplied UUIDs before opening or creating a
  // sheet. Invalid rows retain their own failure result; valid rows may import.
  let preparedRows = rows.map(function(row) { return _prepareImportDetailRow(spec, row); });
  if (preparedRows.every(function(prepared) { return prepared.ok === false; })) {
    return { ok: false, file_type: fileType, created: 0, updated: 0, failed: rows.length, results: preparedRows };
  }

  // Build the account map once: id → sub_type. This backs both the FK existence
  // check (unknown_account) and the sub_type applicability check (sub_type_mismatch).
  const accountSheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const accounts     = sheetToObjects(accountSheet);
  const accountSubTypeById = Object.create(null);
  accounts.forEach(function(account) {
    accountSubTypeById[String(account.id).trim().toLowerCase()] = String(account.sub_type).trim();
  });
  preparedRows = preparedRows.map(function(prepared) {
    if (prepared.ok === false) return prepared;
    const referenceCheck = _validateImportDetailAccount(spec, prepared.row, accountSubTypeById);
    return referenceCheck.ok === false ? Object.assign({ key: prepared.key }, referenceCheck) : prepared;
  });
  if (preparedRows.every(function(prepared) { return prepared.ok === false; })) {
    return { ok: false, file_type: fileType, created: 0, updated: 0, failed: rows.length, results: preparedRows };
  }

  // Inspect existing identities without getOrCreateSheet: that helper may append
  // headers, and an invalid reassignment must not migrate even metadata first.
  const existingAssociations = _existingImportDetailAccounts(spec);
  if (existingAssociations.ok === false) return existingAssociations;
  preparedRows = preparedRows.map(function(prepared) {
    if (prepared.ok === false) return prepared;
    const existingAccountId = existingAssociations.accountById[prepared.row.id];
    if (existingAccountId !== undefined && existingAccountId !== prepared.row.account_id) {
      return { key: prepared.key, ok: false, error: 'detail_account_move_rejected' };
    }
    return prepared;
  });
  if (preparedRows.every(function(prepared) { return prepared.ok === false; })) {
    return { ok: false, file_type: fileType, created: 0, updated: 0, failed: rows.length, results: preparedRows };
  }

  const sheet = getOrCreateSheet(spec.sheet_name, spec.columns);

  // One sheet read → map id → 1-based sheet row number. Detail rows are keyed on the
  // 'id' column (registry key_field is 'id' and required for every detail file_type).
  const idColIdx  = spec.columns.indexOf('id');
  let values      = sheet.getDataRange().getValues();
  const rowNumById = Object.create(null);
  if (idColIdx !== -1) {
    for (let i = 1; i < values.length; i++) {
      const existingId = String(values[i][idColIdx]).trim().toLowerCase();
      if (existingId === '') continue;
      if (rowNumById[existingId] !== undefined) return { ok: false, error: 'duplicate_detail_id' };
      rowNumById[existingId] = i + 1;
    }
  }
  values = _initializeAccountDetailMetadata(sheet, spec, values).values;

  const results = [];
  let created = 0;
  let updated = 0;
  let failed  = 0;

  preparedRows.forEach(function(prepared) {
    const outcome = prepared.ok === false
      ? prepared
      : _importRow(sheet, spec, prepared.row, accountSubTypeById, rowNumById, values);
    results.push(outcome);
    if (outcome.ok === false) { failed += 1; return; }
    if (outcome.action === 'updated') updated += 1;
    else created += 1;
  });

  console.log('importAccountData: file_type=' + fileType + ' rows=' + rows.length
    + ' created=' + created + ' updated=' + updated + ' failed=' + failed);

  return { ok: failed === 0, file_type: fileType, created: created, updated: updated, failed: failed, results: results };
}

// Validate values independent of Sheets, keeping caller objects unchanged.
// UUIDs are preserved as identities, written in lowercase hyphenated form.
function _prepareImportDetailRow(spec, row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row))
    return { key: '', ok: false, error: 'invalid_row' };
  const key = (row[spec.key_field] !== undefined && row[spec.key_field] !== null)
    ? row[spec.key_field]
    : '';

  // 1. Required fields — must be present and non-empty (trimmed).
  for (let i = 0; i < spec.required.length; i++) {
    const field = spec.required[i];
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      return { key: key, ok: false, error: 'missing_' + field };
    }
  }

  const normalisedRow = Object.assign({}, row);
  const uuidFields = ['id', 'account_id', 'linked_property_account_id', 'evaluation_currency_rate_id'];
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < uuidFields.length; i++) {
    const field = uuidFields[i];
    if (spec.columns.indexOf(field) === -1) continue;
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (typeof value !== 'string' || uuidPattern.test(value.trim()) === false) {
      return { key: key, ok: false, error: 'invalid_' + field };
    }
    normalisedRow[field] = value.trim().toLowerCase();
  }

  // Enum values — validated only when the cell is present and non-empty.
  const enumFields = Object.keys(spec.enums);
  for (let i = 0; i < enumFields.length; i++) {
    const field = enumFields[i];
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (spec.enums[field].indexOf(String(value).trim()) === -1) {
      return { key: key, ok: false, error: 'invalid_' + field };
    }
  }

  // Numeric cells must contain finite numbers; malformed text must never reach Sheets.
  const numericFields = spec.numeric_fields;
  const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  for (let i = 0; i < numericFields.length; i++) {
    const field = numericFields[i];
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    // Number() accepts hex/binary/octal strings, while the extractor expects
    // decimal text. Validate syntax without coercing away source precision.
    if (typeof value === 'string' && decimalPattern.test(value.trim()) === false)
      return { key: key, ok: false, error: 'invalid_' + field };
    if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value)))
      return { key: key, ok: false, error: 'invalid_' + field };
  }

  return { key: normalisedRow[spec.key_field], ok: true, row: normalisedRow };
}

function _existingImportDetailAccounts(spec) {
  const existingSheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  const target = existingSheets.find(function(sheet) { return sheet.getName() === spec.sheet_name; });
  const accountById = Object.create(null);
  if (target === undefined) return { ok: true, accountById: accountById };
  const values = target.getDataRange().getValues();
  if (values.length === 0) return { ok: true, accountById: accountById };
  const idIdx = values[0].indexOf('id');
  const accountIdx = values[0].indexOf('account_id');
  // Structural mismatches still fail in getOrCreateSheet before any append/write.
  if (idIdx === -1 || accountIdx === -1) return { ok: true, accountById: accountById };
  for (let i = 1; i < values.length; i++) {
    const id = _detailCellText(values[i][idIdx]).toLowerCase();
    if (id === '') continue;
    if (accountById[id] !== undefined) return { ok: false, error: 'duplicate_detail_id' };
    accountById[id] = _detailCellText(values[i][accountIdx]).toLowerCase();
  }
  return { ok: true, accountById: accountById };
}

function _validateImportDetailAccount(spec, row, accountSubTypeById) {
  const subType = accountSubTypeById[row.account_id];
  if (subType === undefined) return { ok: false, error: 'unknown_account' };
  const configuredTypes = getAvailableAccountTypes();
  const accountType = configuredTypes.find(function(candidate) { return candidate.account_subtype_key === subType; });
  if (accountType === undefined || accountType.detail_sheet !== spec.sheet_name) return { ok: false, error: 'sub_type_mismatch' };
  const linkedPropertyId = row.linked_property_account_id;
  if (spec.columns.indexOf('linked_property_account_id') !== -1 && linkedPropertyId !== undefined && linkedPropertyId !== null && String(linkedPropertyId).trim() !== '') {
    const propertyType = configuredTypes.find(function(candidate) { return candidate.account_subtype_key === accountSubTypeById[linkedPropertyId]; });
    if (propertyType === undefined || propertyType.detail_sheet !== ACCOUNT_INVESTMENT_PROPERTY_SHEET) return { ok: false, error: 'invalid_linked_property' };
  }
  return { ok: true };
}

// Validates a single row against the spec, then INSERTs or REPLACEs it by id.
// Returns { key, ok:true, action:'created'|'updated' } or { key, ok:false, error }.
function _importRow(sheet, spec, row, accountSubTypeById, rowNumById, values) {
  const prepared = _prepareImportDetailRow(spec, row);
  if (prepared.ok === false) return prepared;
  row = prepared.row;
  const key = prepared.key;

  const referenceCheck = _validateImportDetailAccount(spec, row, accountSubTypeById);
  if (referenceCheck.ok === false) return Object.assign({ key: key }, referenceCheck);

  const rowId = String(row.id).trim();
  const existingRowNum = rowNumById[rowId];
  const isReplace = existingRowNum !== undefined;

  // Build a row array ordered by spec.columns. A key that is absent from the row
  // object writes '' because the column has NO value in this import, not as a
  // fallback for a value the caller actually provided.
  const rowArray = spec.columns.map(function(column) {
    const value = row[column];
    if (value === undefined) return '';       // column absent from this import row
    if (value === null) return '';            // explicit null → empty cell
    return typeof value === 'string' ? value.trim() : value;
  });

  // Every supported detail type has system-owned audit fields; ignore CSV values.
  const now             = new Date().toISOString();
  const createdAtIdx    = spec.columns.indexOf('created_at');
  const updatedAtIdx    = spec.columns.indexOf('updated_at');
  const syncStatusIdx   = spec.columns.indexOf('sync_status');
  const recordStatusIdx = spec.columns.indexOf('record_status');
  const syncDateIdx     = spec.columns.indexOf('sync_date');
  const syncNotesIdx    = spec.columns.indexOf('sync_notes');

  rowArray[updatedAtIdx] = now;
  rowArray[syncDateIdx] = '';
  rowArray[syncNotesIdx] = '';

  if (isReplace) {
    if (!Number.isInteger(existingRowNum) || existingRowNum < 2 || existingRowNum > sheet.getLastRow())
      return { key: key, ok: false, error: 'invalid_row' };
    const existingRow = values[existingRowNum - 1];
    if (_detailCellText(existingRow[spec.columns.indexOf('account_id')]).toLowerCase() !== row.account_id) {
      return { key: key, ok: false, error: 'detail_account_move_rejected' };
    }
    rowArray[createdAtIdx] = existingRow[createdAtIdx] === undefined || existingRow[createdAtIdx] === null ? '' : existingRow[createdAtIdx];
    rowArray[syncStatusIdx] = computeSyncStatus(_detailCellText(existingRow[syncStatusIdx]));
    if (rowArray[recordStatusIdx] === '') {
      const previousStatus = _detailCellText(existingRow[recordStatusIdx]);
      rowArray[recordStatusIdx] = previousStatus === '' ? 'active' : previousStatus;
    }
    sheet.getRange(existingRowNum, 1, 1, spec.columns.length).setValues([rowArray]);
    values[existingRowNum - 1] = rowArray;
    return { key: key, ok: true, action: 'updated' };
  }

  rowArray[createdAtIdx] = now;
  rowArray[syncStatusIdx] = SYNC_STATUS_CREATE_PENDING;
  if (rowArray[recordStatusIdx] === '') rowArray[recordStatusIdx] = 'active';
  sheet.appendRow(rowArray);
  // Record the new row so a repeated id later in this batch replaces it.
  rowNumById[rowId] = sheet.getLastRow();
  values[rowNumById[rowId] - 1] = rowArray; // keep aligned for created_at preservation
  return { key: key, ok: true, action: 'created' };
}

function _detailCellText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// Metadata-only migration. Unknown creation timestamps remain blank. Existing
// nonblank lifecycle/sync values are preserved, including failures for retry.
function _initializeAccountDetailMetadata(sheet, spec, values) {
  if (values === undefined) values = sheet.getDataRange().getValues();
  if (spec.columns.indexOf('sync_status') === -1) return { values: values, initialized: 0 };
  const recordStatusIdx = spec.columns.indexOf('record_status');
  const syncStatusIdx = spec.columns.indexOf('sync_status');
  const updatedAtIdx = spec.columns.indexOf('updated_at');
  const metadataWidth = spec.columns.length - recordStatusIdx;
  const now = new Date().toISOString();
  let initialized = 0;
  for (let i = 1; i < values.length; i++) {
    if (_detailCellText(values[i][0]) === '') continue;
    const original = values[i];
    const row = spec.columns.map(function(_, index) { return original[index] === undefined ? '' : original[index]; });
    let changed = false;
    if (_detailCellText(row[recordStatusIdx]) === '') {
      row[recordStatusIdx] = 'active';
      changed = true;
    }
    if (_detailCellText(row[syncStatusIdx]) === '') {
      row[syncStatusIdx] = SYNC_STATUS_CREATE_PENDING;
      changed = true;
    }
    if (changed === false) continue;
    row[updatedAtIdx] = now;
    const rowNum = i + 1;
    if (rowNum < 2 || rowNum > sheet.getLastRow()) throw new Error('invalid_row');
    sheet.getRange(rowNum, recordStatusIdx + 1, 1, metadataWidth).setValues([row.slice(recordStatusIdx)]);
    values[i] = row;
    initialized += 1;
  }
  return { values: values, initialized: initialized };
}

// Run once from the Apps Script editor after deploying the appended six-tab
// schema. Only existing tabs are touched. Optional fileType limits the migration
// to one supported detail tab.
// Re-running is safe; the importer also initializes metadata on its target tab.
function migrateAccountDetailMetadata(fileType) {
  const selectedTypes = fileType === undefined || fileType === null || String(fileType).trim() === ''
    ? Object.keys(IMPORT_REGISTRY).filter(function(key) { return IMPORT_REGISTRY[key].columns.indexOf('sync_status') !== -1; })
    : [String(fileType).trim()];
  for (let i = 0; i < selectedTypes.length; i++) {
    const spec = getImportSpec(selectedTypes[i]);
    if (spec === null || spec.columns.indexOf('sync_status') === -1) return { ok: false, error: 'unsupported_detail_metadata_type' };
  }
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) === false) return { ok: false, error: 'busy_retry' };
  try {
    const existingSheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    const existingByName = Object.create(null);
    existingSheets.forEach(function(sheet) { existingByName[sheet.getName()] = sheet; });
    const existingTypes = selectedTypes.filter(function(key) { return existingByName[IMPORT_REGISTRY[key].sheet_name] !== undefined; });
    // Check every selected existing header before any column append/backfill.
    existingTypes.forEach(function(key) {
      const spec = getImportSpec(key);
      const sheet = existingByName[spec.sheet_name];
      const headers = sheet.getLastColumn() === 0 ? [] : sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (spec.sheet_name === ACCOUNT_INVESTMENT_PROPERTY_SHEET && headers.indexOf('evaluation_currency_rate_id') !== -1) {
        throw new Error('sheet_header_mismatch: run migrateAccountPropertyRateColumn() before metadata migration for ' + spec.sheet_name);
      }
      if (headers.length > spec.columns.length) throw new Error('sheet_header_mismatch: migrate sheet ' + spec.sheet_name);
      for (let i = 0; i < headers.length; i++) {
        if (headers[i] !== spec.columns[i]) throw new Error('sheet_header_mismatch: migrate sheet ' + spec.sheet_name + ' column ' + (i + 1));
      }
    });
    const results = existingTypes.map(function(key) {
      const spec = getImportSpec(key);
      const sheet = getOrCreateSheet(spec.sheet_name, spec.columns);
      const migration = _initializeAccountDetailMetadata(sheet, spec);
      return { file_type: key, initialized: migration.initialized };
    });
    console.log('migrateAccountDetailMetadata: sheets=' + results.length);
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

// Explicit retirement of the property's source rate reference. Only exact known
// old/new layouts are accepted; imports never remove an interior Sheet column.
function migrateAccountPropertyRateColumn() {
  const lock = LockService.getScriptLock();
  if (lock.tryLock(10000) === false) return { ok: false, error: 'busy_retry' };
  try {
    const spec = getImportSpec(ACCOUNT_INVESTMENT_PROPERTY_SHEET);
    const existingSheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    const existing = existingSheets.find(function(sheet) { return sheet.getName() === spec.sheet_name; });
    if (existing === undefined) return { ok: true, removed: false, initialized: 0, queued: 0 };
    const width = existing.getLastColumn();
    const headers = width === 0 ? [] : existing.getRange(1, 1, 1, width).getValues()[0];
    const newBusinessColumns = spec.columns.slice(0, spec.columns.indexOf('record_status'));
    const retiredColumnIdx = spec.columns.indexOf('property_address');
    const oldColumns = spec.columns.slice();
    oldColumns.splice(retiredColumnIdx, 0, 'evaluation_currency_rate_id');
    const oldBusinessColumns = oldColumns.slice(0, oldColumns.indexOf('record_status'));
    function matches(columns) {
      return headers.length === columns.length && headers.every(function(header, index) { return header === columns[index]; });
    }
    const hasRetiredColumn = matches(oldColumns) || matches(oldBusinessColumns);
    if (hasRetiredColumn === false && matches(spec.columns) === false && matches(newBusinessColumns) === false) {
      throw new Error('sheet_header_mismatch: property rate-column migration requires a known 18/24-column old or 17/23-column new layout');
    }
    if (hasRetiredColumn === false) {
      const sheet = getOrCreateSheet(spec.sheet_name, spec.columns);
      const migration = _initializeAccountDetailMetadata(sheet, spec);
      return { ok: true, removed: false, initialized: migration.initialized, queued: 0 };
    }
    // Queue while the old columns are still aligned. If deletion is interrupted,
    // existing synced rows are already pending and the migration can be retried.
    const oldSpec = Object.assign({}, spec, { columns: oldColumns });
    const sheet = getOrCreateSheet(spec.sheet_name, oldColumns);
    const migration = _initializeAccountDetailMetadata(sheet, oldSpec);
    const queued = _queueAccountDetailRows(sheet, oldSpec, migration.values, 2, sheet.getLastRow());
    sheet.deleteColumn(retiredColumnIdx + 1);
    console.log('migrateAccountPropertyRateColumn: removed=1 queued=' + queued);
    return { ok: true, removed: true, initialized: migration.initialized, queued: queued };
  } finally {
    lock.releaseLock();
  }
}

function _queueAccountDetailRows(sheet, spec, values, firstRow, lastRow) {
  const recordStatusIdx = spec.columns.indexOf('record_status');
  const syncStatusIdx = spec.columns.indexOf('sync_status');
  const syncDateIdx = spec.columns.indexOf('sync_date');
  const syncNotesIdx = spec.columns.indexOf('sync_notes');
  const updatedAtIdx = spec.columns.indexOf('updated_at');
  const now = new Date().toISOString();
  let queued = 0;
  for (let rowNum = firstRow; rowNum <= lastRow; rowNum++) {
    if (rowNum < 2 || rowNum > sheet.getLastRow()) throw new Error('invalid_row');
    const row = values[rowNum - 1];
    if (_detailCellText(row[0]) === '') continue;
    row[syncStatusIdx] = computeSyncStatus(_detailCellText(row[syncStatusIdx]));
    row[syncDateIdx] = '';
    row[syncNotesIdx] = '';
    row[updatedAtIdx] = now;
    sheet.getRange(rowNum, recordStatusIdx + 1, 1, spec.columns.length - recordStatusIdx).setValues([row.slice(recordStatusIdx)]);
    queued += 1;
  }
  return queued;
}

// Simple onEdit integration: business/lifecycle edits write only audit cells,
// never financial data. Multi-row pastes queue every affected nonempty detail row.
function markAccountDetailEditPending(e) {
  const editedSheet = e.range.getSheet();
  const spec = getImportSpec(editedSheet.getName());
  if (spec === null || spec.columns.indexOf('sync_status') === -1) return false;
  if (e.range.getColumn() > spec.columns.indexOf('record_status') + 1) return true;
  const firstRow = Math.max(2, e.range.getRow());
  const lastRow = Math.min(editedSheet.getLastRow(), e.range.getRow() + e.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const sheet = getOrCreateSheet(spec.sheet_name, spec.columns);
  const values = _initializeAccountDetailMetadata(sheet, spec).values;
  _queueAccountDetailRows(sheet, spec, values, firstRow, lastRow);
  return true;
}
