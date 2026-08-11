// =============================================================================
// FULCRUM FORGE — Account Core: CRUD operations
// =============================================================================

function listAccounts() {
  const cols  = getAccountSheetColumns();
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  return sheetToObjectsWithRow(sheet).map(function(a) {
    a.is_active = a.is_active === true || String(a.is_active).toLowerCase() === 'true';
    return a;
  });
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
    if (String(existingRows[i][nameColIdx] || '').trim().toLowerCase() === normName) {
      return { ok: false, error: 'duplicate_account' };
    }
  }

  const id     = generateAccountId(sheet);
  const now    = new Date().toISOString();
  const type   = String(body.type).trim();
  const isLiabilityAccount = isLiabilityType(type);

  // Liabilities stored as negative; user always inputs positive
  const openingValue = isLiabilityAccount
    ? -(Math.abs(Number(body.opening_value) || 0))
    : (Number(body.opening_value) || 0);

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getAccountSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',            id);
  setCol('name',          String(body.name).trim());
  setCol('type',          type);
  setCol('sub_type',      String(body.sub_type || '').trim());
  setCol('currency',      normCurrency);
  setCol('opening_value', openingValue);
  setCol('current_value', openingValue);
  setCol('is_active',     true);
  setCol('description',   String(body.description || '').trim());
  setCol('created_at',    now);

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
    results.push({ name: acct.name || '', ok: r.ok, error: r.error || null, id: r.id || null });
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

  const typeColPos  = getAccountSchemaField('type').sheet_column_position;
  const currentType = sheet.getRange(rowNum, typeColPos).getValue();

  const validation = validateAccountUpdate(body, currentType);
  if (!validation.ok) return validation;

  function writeField(key, value) {
    const field = getAccountSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('name',     String(body.name).trim());
  writeField('is_active', body.is_active === true || body.is_active === 'true');
  writeField('description', String(body.description || '').trim());

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
  // Archive (is_active = false) is the recommended path for retiring an
  // account while keeping its transaction history intact.
  const idColPos  = getAccountSchemaField('id').sheet_column_position;
  const accountId = String(sheet.getRange(rowNum, idColPos).getValue() || '');
  if (!accountId) return { ok: false, error: 'missing_account_id' };

  const refCount = _countTransactionsReferencingAccount(accountId);
  if (refCount > 0) {
    return {
      ok: false,
      error: 'account_in_use',
      referenced_count: refCount,
      hint: 'archive_instead',
    };
  }

  sheet.deleteRow(rowNum);
  return { ok: true };
}

// Counts transactions where source_account or target_account equals accountId.
function _countTransactionsReferencingAccount(accountId) {
  const txSheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const values  = txSheet.getDataRange().getValues();
  const srcIdx  = txColIndex('source_account');
  const tgtIdx  = txColIndex('target_account');
  let count   = 0;
  for (let i = 1; i < values.length; i++) {
    const src = String(values[i][srcIdx] || '');
    const tgt = String(values[i][tgtIdx] || '');
    if (src === accountId || tgt === accountId) count++;
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
