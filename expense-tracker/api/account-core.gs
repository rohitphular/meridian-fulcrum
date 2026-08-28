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
    const net     = netMap[a.name];
    return Object.assign({}, a, { current_value: opening + net });
  });
}

// Scans the transactions sheet and returns a map of { accountName → net change }.
// tx_amount is always stored as a positive value; tx_type (money-in / money-out)
// determines the sign applied to the running balance.
function _buildAccountNetMap(accounts) {
  const txSheet  = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values   = txSheet.getDataRange().getValues();
  if (values.length <= 1) return {};

  const accIdx  = txColIndex('account_id');    // stores account name, not UUID
  const amtIdx  = txColIndex('tx_amount');
  const typeIdx = txColIndex('tx_type');
  const statIdx = txColIndex('record_status');

  // Index valid names for O(1) lookup
  const validNames = {};
  accounts.forEach(function(a) { validNames[a.name] = true; });

  const net = {};
  accounts.forEach(function(a) { net[a.name] = 0; });

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][statIdx]) === 'deleted') continue;
    const name   = String(values[i][accIdx]).trim();
    const amount = Number(values[i][amtIdx]);
    const type   = String(values[i][typeIdx]).trim();
    if (!name || !validNames[name]) continue;
    if (type === 'money-in')       net[name] += amount;
    else if (type === 'money-out') net[name] -= amount;
  }
  return net;
}

function createAccount(body) {
  const validation = validateAccountCreate(body);
  if (!validation.ok) return validation;

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

  const id     = generateAccountId(sheet);
  const now    = new Date().toISOString();
  const type   = String(body.type).trim();
  const isLiabilityAccount = isLiabilityType(type);

  // Liabilities stored as negative; user always inputs positive
  const openingValue = isLiabilityAccount
    ? -(Math.abs(Number(body.opening_value)))
    : Number(body.opening_value);

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getAccountSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',            id);
  setCol('name',          String(body.name).trim());
  setCol('type',          type);
  setCol('sub_type',      String(body.sub_type).trim());
  setCol('currency',      normCurrency);
  setCol('opening_value', openingValue);
  setCol('current_value', openingValue);
  setCol('record_status', VALID_RECORD_STATUSES.includes(body.record_status) ? body.record_status : 'active');
  setCol('description',   String(body.description).trim());
  setCol('sync_status',    SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date_time', '');
  setCol('sync_notes',     '');
  setCol('created_at',     now);
  setCol('updated_at',     now);

  sheet.appendRow(row);
  return { ok: true, id: id };
}

function createAccountsBulk(body) {
  if (!Array.isArray(body.accounts) || body.accounts.length === 0)
    return { ok: false, error: 'missing_accounts' };

  const results = [];
  body.accounts.forEach(function(acct) {
    const acctBody = {};
    Object.keys(acct).forEach(function(k) { acctBody[k] = acct[k]; });
    acctBody.pin = body.pin;
    const r = createAccount(acctBody);
    results.push({ name: acct.name, ok: r.ok, error: r.error, id: r.id });
  });

  const failed  = results.filter(function(r) { return !r.ok && r.error !== 'duplicate_account'; });
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
  if (!validation.ok) return validation;

  // Duplicate name guard — reject if a different row already has the same name
  const nameIdx  = acctColIndex('name');
  const normName = String(body.name).trim().toLowerCase();
  for (let i = 1; i < allRows.length; i++) {
    if (i + 1 === rowNum) continue;
    if (String(allRows[i][nameIdx]).trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_account' };
    }
  }

  function writeField(key, value) {
    const field = getAccountSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('name',          String(body.name).trim());
  writeField('sub_type',      String(body.sub_type).trim());
  writeField('record_status', VALID_RECORD_STATUSES.includes(body.record_status) ? body.record_status : 'active');
  writeField('description',   String(body.description).trim());

  // sync_status: preserve create-pending if not yet synced; clear sync_notes either way
  const syncStatusCol     = getAccountSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getAccountSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol      = getAccountSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(allRows[rowNum - 1][syncStatusCol - 1]);
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol).setValue(new Date().toISOString());

  return { ok: true };
}

function deleteAccount(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // T-04 FK check: refuse if any transaction references this account.
  // Deactivate (record_status = inactive) is the recommended path for retiring
  // an account while keeping its transaction history intact.
  const rstatColPos2 = getAccountSchemaField('record_status').sheet_column_position;
  if (String(sheet.getRange(rowNum, rstatColPos2).getValue()) === 'locked')
    return { ok: false, error: 'record_locked' };

  const idColPos  = getAccountSchemaField('id').sheet_column_position;
  const accountId = String(sheet.getRange(rowNum, idColPos).getValue());
  if (!accountId) return { ok: false, error: 'missing_account_id' };

  const refCount = _countTransactionsReferencingAccount(accountId);
  if (refCount > 0) {
    return {
      ok: false,
      error: 'account_in_use',
      referenced_count: refCount,
      hint: 'deactivate_instead',
    };
  }

  // Soft delete: mark as deleted, advance sync_status, clear sync_notes
  const recordStatusCol   = getAccountSchemaField('record_status').sheet_column_position;
  const syncStatusCol     = getAccountSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getAccountSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol2     = getAccountSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(sheet.getRange(rowNum, syncStatusCol).getValue());

  sheet.getRange(rowNum, recordStatusCol).setValue('deleted');
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol2).setValue(new Date().toISOString());

  return { ok: true };
}

// Counts transactions where account_id equals accountId.
function _countTransactionsReferencingAccount(accountId) {
  const txSheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values  = txSheet.getDataRange().getValues();
  const acctIdx = txColIndex('account_id');
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][acctIdx]) === String(accountId)) count++;
  }
  return count;
}

function getAccountById(id) {
  if (!id) return null;
  const cols  = getAccountSheetColumns();
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rows  = sheetToObjectsWithRow(sheet);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === id) return rows[i];
  }
  return null;
}
