// =============================================================================
// FULCRUM FORGE — Account Core: CRUD operations
// =============================================================================

function listAccounts() {
  const cols     = getAccountSheetColumns();
  const sheet    = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const accounts = sheetToObjectsWithRow(sheet);
  const netMap   = _buildAccountNetMap(accounts);
  return accounts.map(function(a) {
    const opening = Number(a.opening_value);
    // netMap is pre-seeded for every account id by _buildAccountNetMap.
    const net     = netMap[a.id];
    return Object.assign({}, a, { current_value: opening + net });
  });
}

// Scans the transactions sheet and returns a map of { accountName → net change }.
// tx_amount is always stored as a positive value; tx_type (money-in / money-out)
// determines the sign applied to the running balance.
function _buildAccountNetMap(accounts) {
  // Seed the map to zero for every account first — accounts with no transactions must
  // resolve to opening_value + 0, not opening_value + undefined (which yields NaN).
  const net = {};
  accounts.forEach(function(a) { net[a.id] = 0; });

  const txSheet  = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values   = txSheet.getDataRange().getValues();
  if (values.length <= 1) return net;  // return zero-seeded map, not {}

  const accIdx  = txColIndex('account_id');    // account_id column stores the account UUID
  const amtIdx  = txColIndex('tx_amount');
  const typeIdx = txColIndex('tx_type');
  const statIdx = txColIndex('record_status');

  // Index by account ID — that is what the transactions sheet stores in account_id
  const validIds = {};
  accounts.forEach(function(a) { validIds[a.id] = true; });

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][statIdx]) === 'deleted') continue;
    const accId  = String(values[i][accIdx]).trim();
    const amount = Number(values[i][amtIdx]);
    const type   = String(values[i][typeIdx]).trim();
    if (accId === '' || validIds[accId] !== true) continue;
    if (type === 'money-in')       net[accId] += amount;
    else if (type === 'money-out') net[accId] -= amount;
  }
  return net;
}

function createAccount(body) {
  const validation = validateAccountCreate(body);
  if (validation.ok === false) return validation;

  const normCurrency = String(body.currency).trim().toUpperCase();

  const cols   = getAccountSheetColumns();
  const sheet  = getOrCreateSheet(ACCOUNTS_SHEET, cols);

  // Duplicate guard — reject if an account with the same name already exists
  const nameColIdx  = acctColIndex('name');
  const existingRows = sheet.getDataRange().getValues();
  const normName     = String(body.name).trim().toLowerCase();
  for (let i = 1; i < existingRows.length; i++) {
    if (String(existingRows[i][nameColIdx]).trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_account' };
    }
  }

  const id     = generateAccountId(sheet, existingRows);
  const now    = new Date().toISOString();
  const type   = String(body.type).trim();
  const isLiabilityAccount = isLiabilityType(type);

  // Liabilities stored as negative; user always inputs positive.
  // opening_value presence and numeric validity already checked by validateAccountCreate.
  const rawOV = Number(body.opening_value);
  const openingValue = isLiabilityAccount ? -(Math.abs(rawOV)) : rawOV;

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getAccountSchemaField(key);
    if (field !== undefined && field !== null) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',            id);
  setCol('name',          String(body.name).trim());
  setCol('type',          type);
  setCol('sub_type',      body.sub_type    !== undefined && body.sub_type    !== null ? String(body.sub_type).trim()    : '');
  setCol('currency',      normCurrency);
  setCol('opening_value', openingValue);
  setCol('record_status', 'active');
  setCol('description',   body.description !== undefined && body.description !== null ? String(body.description).trim() : '');
  setCol('sync_status',    SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date_time', '');
  setCol('sync_notes',     '');
  setCol('created_at',     now);
  setCol('updated_at',     now);

  sheet.appendRow(row);
  return { ok: true, id: id };
}

function createAccountsBulk(body) {
  if (Array.isArray(body.accounts) === false || body.accounts.length === 0)
    return { ok: false, error: 'missing_accounts' };

  const results = [];
  body.accounts.forEach(function(acct) {
    const r = createAccount(acct);
    const entry = { name: acct.name, ok: r.ok };
    if (r.id !== undefined) entry.id = r.id;
    if (r.error !== undefined) entry.error = r.error;
    results.push(entry);
  });

  const failed  = results.filter(function(r) { return r.ok === false && r.error !== 'duplicate_account'; });
  const skipped = results.filter(function(r) { return r.error === 'duplicate_account'; });
  return {
    ok:      failed.length === 0,
    created: results.length - failed.length - skipped.length,
    skipped: skipped.length,
    failed:  failed.length,
    results: results,
  };
}

function updateAccount(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const allRows = sheet.getDataRange().getValues();

  if (String(allRows[rowNum - 1][acctColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentType = String(allRows[rowNum - 1][acctColIndex('type')]);

  const validation = validateAccountUpdate(body, currentType);
  if (validation.ok === false) return validation;

  // Duplicate name guard — reject if a different non-deleted row already has the same name
  const nameIdx      = acctColIndex('name');
  const rstatIdx     = acctColIndex('record_status');
  const normName     = String(body.name).trim().toLowerCase();
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

  writeField('name', String(body.name).trim());
  if (body.sub_type !== undefined && body.sub_type !== null) {
    writeField('sub_type', String(body.sub_type).trim());
  }
  if (body.description !== undefined && body.description !== null) {
    writeField('description', String(body.description).trim());
  }
  if (body.record_status !== undefined && body.record_status !== null) {
    writeField('record_status', String(body.record_status));
  }

  // sync_status: preserve create-pending if not yet synced; clear sync_notes either way.
  const syncStatusColIdx  = acctColIndex('sync_status');
  const syncNotesColIdx   = acctColIndex('sync_notes');
  const updatedAtColIdx   = acctColIndex('updated_at');
  const currentSyncStatus = String(allRows[rowNum - 1][syncStatusColIdx]);
  updatedRow[syncStatusColIdx] = computeSyncStatus(currentSyncStatus);
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
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

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
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

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
  row[syncNotesColIdx]    = '';
  row[updatedAtColIdx]    = new Date().toISOString();
  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);

  return { ok: true };
}

