// =============================================================================
// FULCRUM FORGE — Account Core: CRUD operations
// =============================================================================

function listAccounts() {
  const cols     = getAccountSheetColumns();
  const sheet    = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const accounts = sheetToObjectsWithRow(sheet);
  const netMap   = _buildAccountNetMap(accounts);
  return accounts.map(function(a) {
    const opening = Number(a.opening_value_local);
    if (a.opening_value_local === undefined || a.opening_value_local === null
        || String(a.opening_value_local).trim() === '' || !Number.isFinite(opening))
      throw new Error('invalid_account_opening_value');
    // netMap is pre-seeded for every account id by _buildAccountNetMap.
    const net     = netMap[a.id];
    return Object.assign({}, a, { current_value_local: opening + net });
  });
}

// Scans transaction_master and returns a map of { accountId → net change }.
// tx_amount_local is always stored as a positive value; tx_type (money-in / money-out)
// determines the sign applied to the running balance.
function _buildAccountNetMap(accounts) {
  // Seed the map to zero for every account first — accounts with no transactions must
  // resolve to opening_value + 0, not opening_value + undefined (which yields NaN).
  const net = Object.create(null);
  const trackingStartById = Object.create(null);
  accounts.forEach(function(a) { trackingStartById[a.id] = sheetDateTimeToDate(a.tracking_start_date_local); });
  accounts.forEach(function(a) { net[a.id] = 0; });

  const txSheet  = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values   = txSheet.getDataRange().getValues();
  if (values.length <= 1) return net;  // return zero-seeded map, not {}

  const accIdx  = txColIndex('account_id');    // account_id column stores the account UUID
  const amtIdx  = txColIndex('tx_amount_local');
  const typeIdx = txColIndex('tx_type');
  const statIdx = txColIndex('record_status');
  const dateIdx = txColIndex('tx_date_local');

  // Index by account ID — transaction_master stores that UUID in account_id.
  const validIds = {};
  accounts.forEach(function(a) { validIds[a.id] = true; });

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][statIdx]) === 'deleted') continue;
    const accId  = String(values[i][accIdx]).trim();
    const amount = Number(values[i][amtIdx]);
    const type   = String(values[i][typeIdx]).trim();
    if (accId === '' || validIds[accId] !== true) continue;
    if (!Number.isFinite(amount) || amount <= 0) {
      console.warn('_buildAccountNetMap: skipped_reason=invalid_amount row=' + (i + 1));
      continue;
    }
    const transactionDate = sheetDateTimeToDate(values[i][dateIdx]);
    if (transactionDate === null) continue;
    const trackingStart = trackingStartById[accId];
    if (trackingStart !== null && transactionDate < trackingStart) continue;
    if (type === 'money-in')       net[accId] += amount;
    else if (type === 'money-out') net[accId] -= amount;
  }
  return net;
}

function createAccount(body) {
  const validation = validateAccountCreate(body);
  if (validation.ok === false) return validation;

  const normCurrency = String(body.account_currency_local).trim().toUpperCase();

  const cols   = getAccountSheetColumns();
  const sheet  = getOrCreateSheet(ACCOUNTS_SHEET, cols);

  // Use caller-supplied id (seed CSV import) when provided; otherwise generate a UUID.
  const id  = (body.id !== undefined && body.id !== null && String(body.id).trim() !== '')
    ? String(body.id).trim().toLowerCase()
    : Utilities.getUuid();
  const idColumn = acctColIndex('id');
  if (sheet.getDataRange().getValues().slice(1).some(function(existingRow) {
    return String(existingRow[idColumn]).trim().toLowerCase() === id;
  })) return { ok: false, error: 'account_id_exists' };
  const now = new Date().toISOString();
  const type = String(body.type).trim();

  // Liabilities stored as negative; user always inputs positive.
  // opening_value presence and numeric validity already checked by validateAccountCreate.
  const openingValue = accountOpeningValue(body.opening_value_local, type);

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getAccountSchemaField(key);
    if (field !== undefined && field !== null) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',                 id);
  setCol('account_name',       String(body.account_name).trim());
  setCol('legal_entity_name',  body.legal_entity_name  !== undefined && body.legal_entity_name  !== null ? String(body.legal_entity_name).trim()  : '');
  setCol('type',               type);
  setCol('sub_type',           body.sub_type            !== undefined && body.sub_type            !== null ? String(body.sub_type).trim()            : '');
  setCol('account_currency_local',     normCurrency);
  setCol('local_timezone',     body.local_timezone      !== undefined && body.local_timezone      !== null ? String(body.local_timezone).trim()      : '');
  setCol('account_opening_date_local', String(body.account_opening_date_local).trim());
  setCol('account_closing_date_local', body.account_closing_date_local  !== undefined && body.account_closing_date_local  !== null ? String(body.account_closing_date_local).trim()  : '');
  setCol('tracking_start_date_local',  body.tracking_start_date_local   !== undefined && body.tracking_start_date_local   !== null ? String(body.tracking_start_date_local).trim()   : '');
  setCol('opening_value_local', openingValue);
  // Honor a supplied record_status (seed import may bring closed/inactive accounts);
  // absent → 'active'. Validity already enforced by validateAccountCreate.
  setCol('record_status',      (body.record_status !== undefined && body.record_status !== null && String(body.record_status).trim() !== '') ? String(body.record_status).trim() : 'active');
  setCol('description',        body.description         !== undefined && body.description         !== null ? String(body.description).trim()         : '');
  setCol('sync_status',        SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date',          '');
  setCol('sync_notes',         '');
  setCol('created_at',         now);
  setCol('updated_at',         now);

  sheet.appendRow(row);
  return { ok: true, id: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk create/replace — id-based upsert (does NOT delegate to createAccount).
//
// Dedup rule: each incoming row carries an `id` (uuid). One sheet read at the
// start builds a map of id → 1-based sheet row number. For each incoming row:
//   - id absent          → generate a uuid and INSERT (append).
//   - id not in the map  → INSERT (append).
//   - id present in map   → REPLACE that row in place (overwrite all columns),
//                          preserving created_at and setting sync_status to
//                          update-pending.
// Existing UUID collisions fail before writes; repeated incoming UUIDs replace the same row.
// ─────────────────────────────────────────────────────────────────────────────
function createAccountsBulk(body) {
  if (Array.isArray(body.accounts) === false || body.accounts.length === 0)
    return { ok: false, error: 'missing_accounts' };

  const prepared = body.accounts.map(function(account) { return { account: account, validation: validateAccountCreate(account) }; });
  if (prepared.every(function(entry) { return entry.validation.ok === false; })) {
    return {
      ok: false, created: 0, updated: 0, failed: prepared.length,
      results: prepared.map(function(entry) {
        return { key: entry.account !== null && typeof entry.account === 'object' ? entry.account.id : '', ok: false, error: entry.validation.error };
      }),
    };
  }

  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const numCols = cols.length;

  // One sheet read → map id → 1-based sheet row number.
  const idColIdx     = acctColIndex('id');
  const existingData = sheet.getDataRange().getValues();
  const rowNumById   = Object.create(null);
  for (let i = 1; i < existingData.length; i++) {
    const existingId = String(existingData[i][idColIdx]).trim().toLowerCase();
    if (existingId === '') continue;
    if (rowNumById[existingId] !== undefined) return { ok: false, error: 'duplicate_account_id' };
    rowNumById[existingId] = i + 1;
  }

  const createdAtIdx  = getAccountSchemaField('created_at').sheet_column_position - 1;
  const syncStatusIdx = getAccountSchemaField('sync_status').sheet_column_position - 1;

  const results = [];
  let created = 0;
  let updated = 0;
  let failed  = 0;

  prepared.forEach(function(entry) {
    const acct = entry.account;
    const validation = entry.validation;
    if (validation.ok === false) {
      results.push({ key: acct !== null && typeof acct === 'object' ? acct.id : '', ok: false, error: validation.error });
      failed += 1;
      return;
    }

    const now  = new Date().toISOString();
    const type = String(acct.type).trim();
    const normCurrency = String(acct.account_currency_local).trim().toUpperCase();

    // Liabilities stored as negative; user always inputs positive.
    const openingValue = accountOpeningValue(acct.opening_value_local, type);

    const hasId = acct.id !== undefined && acct.id !== null && String(acct.id).trim() !== '';
    const id = hasId ? String(acct.id).trim().toLowerCase() : Utilities.getUuid();
    const existingRowNum = rowNumById[id];
    const isReplace = existingRowNum !== undefined;

    const row = new Array(numCols).fill('');
    function setCol(key, value) {
      const field = getAccountSchemaField(key);
      if (field !== undefined && field !== null) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
    }

    setCol('id',                 id);
    setCol('account_name',       String(acct.account_name).trim());
    setCol('legal_entity_name',  acct.legal_entity_name  !== undefined && acct.legal_entity_name  !== null ? String(acct.legal_entity_name).trim()  : '');
    setCol('type',               type);
    setCol('sub_type',           acct.sub_type            !== undefined && acct.sub_type            !== null ? String(acct.sub_type).trim()            : '');
    setCol('account_currency_local',     normCurrency);
    setCol('local_timezone',     acct.local_timezone      !== undefined && acct.local_timezone      !== null ? String(acct.local_timezone).trim()      : '');
    setCol('account_opening_date_local', String(acct.account_opening_date_local).trim());
    setCol('account_closing_date_local', acct.account_closing_date_local  !== undefined && acct.account_closing_date_local  !== null ? String(acct.account_closing_date_local).trim()  : '');
    setCol('tracking_start_date_local',  acct.tracking_start_date_local   !== undefined && acct.tracking_start_date_local   !== null ? String(acct.tracking_start_date_local).trim()   : '');
    setCol('opening_value_local', openingValue);
    // Honor an explicit lifecycle status. New IDs default to active; replacement
    // of an existing ID preserves omitted status below.
    setCol('record_status',      (acct.record_status !== undefined && acct.record_status !== null && String(acct.record_status).trim() !== '') ? String(acct.record_status).trim() : 'active');
    setCol('description',        acct.description         !== undefined && acct.description         !== null ? String(acct.description).trim()         : '');
    setCol('sync_date',          '');
    setCol('sync_notes',         '');
    setCol('updated_at',         now);

    if (isReplace) {
      if (!Number.isInteger(existingRowNum) || existingRowNum < 2 || existingRowNum > sheet.getLastRow()) {
        results.push({ key: id, ok: false, error: 'invalid_row' });
        failed += 1;
        return;
      }
      // Preserve created_at from the existing row; advance sync_status.
      const existingRow = existingData[existingRowNum - 1];
      // Existing transaction/subscription references may use the original UUID
      // spelling. Match UUIDs canonically without rewriting that stored identity.
      row[idColIdx] = existingRow[idColIdx];
      if (acct.record_status === undefined || acct.record_status === null || String(acct.record_status).trim() === '') {
        const previousStatus = String(existingRow[acctColIndex('record_status')]).trim();
        if (getAccountSchemaField('record_status').enum_values.indexOf(previousStatus) === -1) {
          results.push({ key: id, ok: false, error: 'invalid_record_status' });
          failed += 1;
          return;
        }
        row[acctColIndex('record_status')] = previousStatus;
      }
      row[createdAtIdx]  = existingRow[createdAtIdx];
      row[syncStatusIdx] = computeSyncStatus(String(existingRow[syncStatusIdx]));
      sheet.getRange(existingRowNum, 1, 1, numCols).setValues([row]);
      existingData[existingRowNum - 1] = row;
      results.push({ key: id, ok: true, action: 'updated' });
      updated += 1;
    } else {
      row[createdAtIdx]  = now;
      row[syncStatusIdx] = SYNC_STATUS_CREATE_PENDING;
      sheet.appendRow(row);
      // Record the new row so a repeated id later in this batch replaces it.
      rowNumById[id] = sheet.getLastRow();
      existingData[rowNumById[id] - 1] = row; // keep aligned for created_at preservation
      results.push({ key: id, ok: true, action: 'created' });
      created += 1;
    }
  });

  console.log('createAccountsBulk: input=' + body.accounts.length
    + ' created=' + created + ' updated=' + updated + ' failed=' + failed);

  return {
    ok:      failed === 0,
    created: created,
    updated: updated,
    failed:  failed,
    results: results,
  };
}

function updateAccount(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const allRows = sheet.getDataRange().getValues();

  if (String(allRows[rowNum - 1][acctColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentType = String(allRows[rowNum - 1][acctColIndex('type')]);

  const validation = validateAccountUpdate(body, currentType, allRows[rowNum - 1][acctColIndex('account_opening_date_local')]);
  if (validation.ok === false) return validation;

  // Duplicate name guard — reject if a different non-deleted row already has the same account_name
  const nameIdx      = acctColIndex('account_name');
  const rstatIdx     = acctColIndex('record_status');
  const normName     = String(body.account_name).trim().toLowerCase();
  for (let i = 1; i < allRows.length; i++) {
    if (i + 1 === rowNum) continue;
    if (String(allRows[i][rstatIdx]) === 'deleted') continue;
    if (String(allRows[i][nameIdx]).trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_account' };
    }
  }

  // Build updated row from current data, then apply editable field changes.
  const updatedRow = allRows[rowNum - 1].slice();

  function writeField(key, value) {
    const field = getAccountSchemaField(key);
    if (field === null || field.editable === false) return;
    updatedRow[field.sheet_column_position - 1] = value;
  }

  writeField('account_name', String(body.account_name).trim());
  if (body.sub_type !== undefined && body.sub_type !== null) {
    writeField('sub_type', String(body.sub_type).trim());
  }
  if (body.account_closing_date_local !== undefined && body.account_closing_date_local !== null) {
    writeField('account_closing_date_local', String(body.account_closing_date_local).trim());
  }
  if (body.description !== undefined && body.description !== null) {
    writeField('description', String(body.description).trim());
  }
  if (body.record_status !== undefined && body.record_status !== null) {
    writeField('record_status', String(body.record_status).trim());
  }

  // sync_status: preserve create-pending if not yet synced; clear sync_notes either way.
  const syncStatusColIdx  = acctColIndex('sync_status');
  const syncNotesColIdx   = acctColIndex('sync_notes');
  const updatedAtColIdx   = acctColIndex('updated_at');
  const currentSyncStatus = String(allRows[rowNum - 1][syncStatusColIdx]);
  updatedRow[syncStatusColIdx] = computeSyncStatus(currentSyncStatus);
  updatedRow[acctColIndex('sync_date')] = '';
  updatedRow[syncNotesColIdx]  = '';
  updatedRow[updatedAtColIdx]  = new Date().toISOString();

  // Single batch write for the entire row.
  sheet.getRange(rowNum, 1, 1, updatedRow.length).setValues([updatedRow]);

  return { ok: true };
}

function deleteAccount(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // Single read — extract all needed values from this row before mutating.
  const allData       = sheet.getDataRange().getValues();
  const row           = allData[rowNum - 1].slice(); // copy so we can mutate

  const recordStatusColIdx = acctColIndex('record_status');
  const idColIdx           = acctColIndex('id');
  const syncStatusColIdx   = acctColIndex('sync_status');
  const syncNotesColIdx    = acctColIndex('sync_notes');
  const updatedAtColIdx    = acctColIndex('updated_at');

  // T-04 FK check: refuse if any transaction references this account.
  // Deactivate (record_status = inactive) is the recommended path for retiring
  // an account while keeping its transaction history intact.
  if (String(row[recordStatusColIdx]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const accountId = String(row[idColIdx]);
  if (accountId === '') return { ok: false, error: 'missing_account_id' };

  const refCount = _countTransactionsReferencingAccount(accountId);
  if (refCount > 0) {
    return {
      ok: false,
      error: 'account_in_use',
      referenced_count: refCount,
      hint: 'deactivate_instead',
    };
  }

  // Soft delete: mark as deleted, advance sync_status, clear sync_notes — single batch write.
  const currentSyncStatus = String(row[syncStatusColIdx]);
  row[recordStatusColIdx] = 'deleted';
  row[syncStatusColIdx]   = computeSyncStatus(currentSyncStatus);
  row[acctColIndex('sync_date')] = '';
  row[syncNotesColIdx]    = '';
  row[updatedAtColIdx]    = new Date().toISOString();
  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);

  return { ok: true };
}

// Counts non-deleted transactions where account_id equals accountId.
function _countTransactionsReferencingAccount(accountId) {
  const txSheet  = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values   = txSheet.getDataRange().getValues();
  const acctIdx  = txColIndex('account_id');
  const statIdx  = txColIndex('record_status');
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][statIdx]) === 'deleted') continue;
    if (String(values[i][acctIdx]) === String(accountId)) count++;
  }
  return count;
}

function restoreAccount(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };

  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // Single read — extract both the status check and the sync_status from the same read.
  const allData = sheet.getDataRange().getValues();
  const row     = allData[rowNum - 1].slice(); // copy so we can mutate

  const recordStatusColIdx = acctColIndex('record_status');
  const syncStatusColIdx   = acctColIndex('sync_status');
  const syncNotesColIdx    = acctColIndex('sync_notes');
  const updatedAtColIdx    = acctColIndex('updated_at');

  if (String(row[recordStatusColIdx]) !== 'deleted')
    return { ok: false, error: 'not_deleted' };

  // Restore: set active, advance sync_status, clear sync_notes — single batch write.
  const currentSyncStatus = String(row[syncStatusColIdx]);
  row[recordStatusColIdx] = 'active';
  row[syncStatusColIdx]   = computeSyncStatus(currentSyncStatus);
  row[acctColIndex('sync_date')] = '';
  row[syncNotesColIdx]    = '';
  row[updatedAtColIdx]    = new Date().toISOString();
  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);

  return { ok: true };
}

// Master business/lifecycle edits must re-enter normal sync, including the
// appended tracking timestamp after the audit block. Write only sync/audit cells.
function markAccountMasterEditPending(e) {
  const editedSheet = e.range.getSheet();
  if (editedSheet.getName() !== ACCOUNTS_SHEET) return false;
  const firstColumn = e.range.getColumn();
  const lastColumn = firstColumn + e.range.getNumColumns() - 1;
  const businessEdit = Object.keys(ACCOUNT_SCHEMA).some(function(key) {
    const field = ACCOUNT_SCHEMA[key];
    return (field.group === 'core' || key === 'id' || key === 'record_status')
      && key !== 'current_value_local'
      && field.sheet_column_position >= firstColumn && field.sheet_column_position <= lastColumn;
  });
  if (businessEdit === false) return true;
  const firstRow = Math.max(2, e.range.getRow());
  const lastRow = Math.min(editedSheet.getLastRow(), e.range.getRow() + e.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const values = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  for (let rowNum = firstRow; rowNum <= lastRow; rowNum++) {
    if (rowNum < 2 || rowNum > sheet.getLastRow()) throw new Error('invalid_row');
    const row = values[rowNum - 1];
    if (row[acctColIndex('id')] === undefined || String(row[acctColIndex('id')]).trim() === '') continue;
    const rawStatus = row[acctColIndex('sync_status')];
    const currentStatus = rawStatus === undefined || rawStatus === null ? '' : String(rawStatus).trim();
    sheet.getRange(rowNum, acctColIndex('sync_status') + 1, 1, 3).setValues([[computeSyncStatus(currentStatus), '', '']]);
    sheet.getRange(rowNum, acctColIndex('updated_at') + 1).setValue(now);
  }
  return true;
}
