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
  const fxRate = body.fx_rate !== undefined && body.fx_rate !== '' ? Number(body.fx_rate) : 0;

  if (body.tx_type === 'money-transfer') {
    const fxValidation = validateFxRate(body.source_account, body.target_account, fxRate);
    if (!fxValidation.ok) return fxValidation;
  }
  if (body.tx_type === 'money-out' && body.target_account) {
    const fxValidation = validateFxRate(body.source_account, body.target_account, fxRate);
    if (!fxValidation.ok) return fxValidation;
  }

  // Resolve workflow before any sheet mutation — fail fast if category not found
  const hints  = _findCategoryHints(body.tx_type, body.major_category, body.minor_category);
  const wfType = resolveWorkflow(hints ? hints.workflow_type : null);
  if (typeof wfType !== 'string') return wfType;

  const cols  = getTransactionSheetColumns();
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, cols);

  // Duplicate guard — reject if an identical row already exists
  const dupCheck = _checkDuplicate(sheet, body);
  if (dupCheck) return dupCheck;
  const id = generateTransactionId(sheet, body.tx_date_time);

  // Augment description with the conversion rate used (no-op when not cross-currency).
  const finalDescription = applyFxNote(body.description, body.source_account, body.target_account, amount, fxRate);

  const row = new Array(cols.length).fill('');
  function setCol(key, value) {
    const field = getTransactionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }
  setCol('id',                   id);
  setCol('tx_date_time',         body.tx_date_time);
  setCol('tx_type',              body.tx_type);
  setCol('source_account',       body.source_account      || '');
  setCol('target_account',       body.target_account      || '');
  setCol('tx_location_area',     body.tx_location_area    || '');
  setCol('tx_location_city',     body.tx_location_city    || '');
  setCol('tx_location_country',  body.tx_location_country || '');
  setCol('amount',               amount);
  setCol('currency',             body.currency            || '');
  setCol('fx_rate',              fxRate > 0 ? fxRate : '');
  setCol('major_category',       body.major_category      || '');
  setCol('minor_category',       body.minor_category      || '');
  setCol('tags',                 normaliseTags(body.tags));
  setCol('counterparty_name',    body.counterparty_name   || '');
  setCol('description',          finalDescription);
  sheet.appendRow(row);

  const wfResult = executeWorkflow(wfType, {
    source_account: body.source_account || '',
    target_account: body.target_account || '',
    amount:         amount,
    to_amount:      fxRate > 0 ? amount * fxRate : amount,
    fx_rate:        fxRate,
  });
  if (!wfResult.ok) return wfResult;

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

  // T-02: ALL validation must run BEFORE Phase 1 reversal. A validation failure
  // between Phase 1 and Phase 2 would leave the sheet in an orphaned state
  // (old row reversed, new row never applied). Rules 1–5 are inside
  // validateTransactionUpdate; Rule 6 (FX) is the two checks below.
  const newType   = body.tx_type;
  const newAmount = Number(body.amount);
  const newFxRate = body.fx_rate ? Number(body.fx_rate) : 0;

  if (newType === 'money-transfer') {
    const fxValidation = validateFxRate(body.source_account, body.target_account, newFxRate);
    if (!fxValidation.ok) return fxValidation;
  }
  if (newType === 'money-out' && body.target_account) {
    const fxValidation = validateFxRate(body.source_account, body.target_account, newFxRate);
    if (!fxValidation.ok) return fxValidation;
  }

  // All validation passed — resolve both workflows before any balance mutation
  const oldType            = String(oldRow[txColIndex('tx_type')]);
  const oldMajor           = String(oldRow[txColIndex('major_category')] || '');
  const oldMinor           = String(oldRow[txColIndex('minor_category')] || '');
  const oldAmount          = Number(oldRow[txColIndex('amount')]) || 0;
  const oldSourceAccountId = String(oldRow[txColIndex('source_account')]);
  const oldTargetAccountId = String(oldRow[txColIndex('target_account')]);
  const oldFxRate          = Number(oldRow[txColIndex('fx_rate')]) || 0;

  const oldHints  = _findCategoryHints(oldType, oldMajor, oldMinor);
  const oldWfType = resolveWorkflow(oldHints ? oldHints.workflow_type : null);
  if (typeof oldWfType !== 'string') return oldWfType;

  const newHints  = _findCategoryHints(body.tx_type, body.major_category, body.minor_category);
  const newWfType = resolveWorkflow(newHints ? newHints.workflow_type : null);
  if (typeof newWfType !== 'string') return newWfType;

  // Phase 1 — reverse old transaction
  reverseWorkflow(oldWfType, {
    source_account: oldSourceAccountId,
    target_account: oldTargetAccountId,
    amount:         oldAmount,
    to_amount:      oldFxRate > 0 ? oldAmount * oldFxRate : oldAmount,
    fx_rate:        oldFxRate,
  });

  // Phase 2 — apply new transaction
  executeWorkflow(newWfType, {
    source_account: body.source_account || '',
    target_account: body.target_account || '',
    amount:         newAmount,
    to_amount:      newFxRate > 0 ? newAmount * newFxRate : newAmount,
    fx_rate:        newFxRate,
  });

  // Augment description with the conversion rate used (no-op when not cross-currency).
  // On edit, applyFxNote strips any stale [FX: ...] marker before re-appending,
  // so changing fx_rate updates the inline rate record correctly.
  const finalDescription = applyFxNote(body.description, body.source_account, body.target_account, newAmount, newFxRate);

  function writeField(key, value) {
    const field = getTransactionSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }
  writeField('tx_date_time',        body.tx_date_time);
  writeField('source_account',      body.source_account      || '');
  writeField('target_account',      body.target_account      || '');
  writeField('tx_location_area',    body.tx_location_area    || '');
  writeField('tx_location_city',    body.tx_location_city    || '');
  writeField('tx_location_country', body.tx_location_country || '');
  writeField('amount',              newAmount);
  writeField('currency',            body.currency            || '');
  writeField('fx_rate',             newFxRate > 0 ? newFxRate : '');
  writeField('major_category',      body.major_category      || '');
  writeField('minor_category',      body.minor_category      || '');
  writeField('tags',                normaliseTags(body.tags));
  writeField('counterparty_name',   body.counterparty_name   || '');
  writeField('description',         finalDescription);

  return { ok: true };
}

function deleteTransaction(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };

  const cols  = getTransactionSheetColumns();
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const row    = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];
  const txType          = String(row[txColIndex('tx_type')]);
  const txMajor         = String(row[txColIndex('major_category')] || '');
  const txMinor         = String(row[txColIndex('minor_category')] || '');
  const txAmount        = Number(row[txColIndex('amount')]) || 0;
  const sourceAccountId = String(row[txColIndex('source_account')]);
  const targetAccountId = String(row[txColIndex('target_account')]);
  const fxRate          = Number(row[txColIndex('fx_rate')]) || 0;

  const hints  = _findCategoryHints(txType, txMajor, txMinor);
  const wfType = resolveWorkflow(hints ? hints.workflow_type : null);
  if (typeof wfType !== 'string') return wfType;

  reverseWorkflow(wfType, {
    source_account: sourceAccountId,
    target_account: targetAccountId,
    amount:         txAmount,
    to_amount:      fxRate > 0 ? txAmount * fxRate : txAmount,
    fx_rate:        fxRate,
  });

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
