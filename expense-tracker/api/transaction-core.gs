// =============================================================================
// FULCRUM FORGE — Transaction Core: CRUD + balance adjustment
// =============================================================================

function listTransactions() {
  return sheetToObjectsWithRow(getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns()));
}

function createTransaction(body) {
  const validation = validateTransactionCreate(body);
  if (!validation.ok) return validation;

  const amount = Number(body.amount);

  const cols  = getTransactionSheetColumns();
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, cols);

  // Duplicate guard — reject if an identical row already exists
  const dupCheck = _checkDuplicate(sheet, body);
  if (dupCheck) return dupCheck;
  const id = generateTransactionId(sheet, body.tx_date_time);

  const finalDescription = body.description || '';

  const row = new Array(cols.length).fill('');
  function setCol(key, value) {
    const field = getTransactionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }
  setCol('id',                     id);
  setCol('tx_date_time',           body.tx_date_time);
  setCol('tx_timezone',            body.tx_timezone            || '');
  setCol('tx_type',                body.tx_type);
  setCol('source_account',         body.source_account         || '');
  setCol('target_account',         body.target_account         || '');
  setCol('user_location_area',     body.user_location_area     || '');
  setCol('user_location_city',     body.user_location_city     || '');
  setCol('user_location_country',  body.user_location_country  || '');
  setCol('user_location_latitude', body.user_location_latitude ?? '');
  setCol('user_location_longitude',body.user_location_longitude ?? '');
  setCol('amount',                 amount);
  setCol('currency',               body.currency               || '');
  setCol('major_category',         body.major_category         || '');
  setCol('minor_category',         body.minor_category         || '');
  setCol('description',            finalDescription);
  setCol('counterparty_name',      body.counterparty_name      || '');
  setCol('tx_tags',                normaliseTags(body.tx_tags));
  setCol('beneficiaries',          body.beneficiaries          || '');
  sheet.appendRow(row);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, txColIndex('sync_status') + 1).setValue('create-pending');

  return { ok: true, id };
}

function updateTransaction(body) {
  // Row-range guard runs first so we can hand the old row to the validator,
  // which uses it to compute the post-reversal balance for Rules 1–5.
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const cols   = getTransactionSheetColumns();
  const sheet  = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const oldRow = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];

  const validation = validateTransactionUpdate(body, oldRow);
  if (!validation.ok) return validation;

  const newAmount = Number(body.amount);

  const finalDescription = body.description || '';

  function writeField(key, value) {
    const field = getTransactionSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }
  writeField('tx_date_time',           body.tx_date_time);
  writeField('tx_timezone',            body.tx_timezone            || '');
  writeField('tx_type',                body.tx_type);
  writeField('source_account',         body.source_account         || '');
  writeField('target_account',         body.target_account         || '');
  writeField('user_location_area',     body.user_location_area     || '');
  writeField('user_location_city',     body.user_location_city     || '');
  writeField('user_location_country',  body.user_location_country  || '');
  writeField('user_location_latitude', body.user_location_latitude ?? '');
  writeField('user_location_longitude',body.user_location_longitude ?? '');
  writeField('amount',                 newAmount);
  writeField('currency',               body.currency               || '');
  writeField('major_category',         body.major_category         || '');
  writeField('minor_category',         body.minor_category         || '');
  writeField('description',            finalDescription);
  writeField('counterparty_name',      body.counterparty_name      || '');
  writeField('tx_tags',                normaliseTags(body.tx_tags));
  writeField('beneficiaries',          body.beneficiaries          || '');
  sheet.getRange(rowNum, txColIndex('sync_status') + 1).setValue('update-pending');
  sheet.getRange(rowNum, txColIndex('sync_notes')  + 1).setValue('');

  return { ok: true };
}

function deleteTransaction(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };

  const cols  = getTransactionSheetColumns();
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  sheet.deleteRow(rowNum);
  return { ok: true };
}

function createTransactionsBulk(body) {
  if (!Array.isArray(body.transactions) || body.transactions.length === 0)
    return { ok: false, error: 'missing_transactions' };

  const results = [];
  body.transactions.forEach(function(tx) {
    const txBody = {};
    Object.keys(tx).forEach(function(k) { txBody[k] = tx[k]; });
    txBody.pin = body.pin;
    const r = createTransaction(txBody);
    results.push({
      label: (tx.tx_date_time || '').slice(0, 10) + ' ' + String(tx.description || tx.counterparty_name || '').slice(0, 40),
      ok:    r.ok,
      error: r.error || null,
      id:    r.id    || null,
    });
  });

  const failed = results.filter(function(r) { return !r.ok; });
  return {
    ok:      failed.length === 0,
    created: results.length - failed.length,
    failed:  failed.length,
    results: results,
  };
}

// Returns { ok: false, error: 'duplicate_transaction' } if a row with the same
// (date, type, amount, source_account, target_account) already exists.
function _checkDuplicate(sheet, body) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return null;

  const ciDate   = txColIndex('tx_date_time');
  const ciType   = txColIndex('tx_type');
  const ciAmt    = txColIndex('amount');
  const ciSrc    = txColIndex('source_account');
  const ciTgt    = txColIndex('target_account');

  const inDate   = String(body.tx_date_time   || '');
  const inType   = String(body.tx_type        || '');
  const inAmt    = Number(body.amount);
  const inSrc    = String(body.source_account || '');
  const inTgt    = String(body.target_account || '');

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (
      String(r[ciDate]) === inDate   &&
      String(r[ciType]) === inType   &&
      Number(r[ciAmt])  === inAmt    &&
      String(r[ciSrc])  === inSrc    &&
      String(r[ciTgt])  === inTgt
    ) {
      return { ok: false, error: 'duplicate_transaction' };
    }
  }
  return null;
}
