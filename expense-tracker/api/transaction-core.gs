// =============================================================================
// FULCRUM FORGE — Transaction Core: CRUD + balance adjustment
//
// Storage model: one row per account movement (account_id + tx_amount).
// Transfers create 2 rows linked via parent_tx_id.
//
// Create API receives: source_account, target_account, source_amount, target_amount
// (same as CSV import format). Backend maps to account_id / tx_amount per row.
//
// Update API receives: account_id, tx_amount (single-row edit — no source/target).
// =============================================================================

function listTransactions() {
  return sheetToObjectsWithRow(getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// body: { tx_type, source_account, target_account, source_amount, target_amount,
//         major_category, minor_category, + location/text fields }
// ─────────────────────────────────────────────────────────────────────────────
function createTransaction(body) {
  const validation = validateTransactionCreate(body);
  if (!validation.ok) return validation;

  const cat = _findCategoryHints(body.tx_type, body.major_category, body.minor_category);
  const isTransfer = cat && cat.source_account_mandatory && cat.target_account_mandatory
    && body.source_account && body.target_account;

  if (isTransfer) {
    const srcAmt = Number(body.source_amount);
    const tgtAmt = body.target_amount && Number(body.target_amount) > 0
      ? Number(body.target_amount) : srcAmt;

    // Parent = the leg matching the submitted tx_type.
    // money-out submitted → source account is the primary leg (parent).
    // money-in submitted  → target account is the primary leg (parent).
    var parentAcct, parentAmt, parentType, childAcct, childAmt, childType;
    if (body.tx_type === 'money-out') {
      parentAcct = body.source_account; parentAmt = srcAmt; parentType = 'money-out';
      childAcct  = body.target_account; childAmt  = tgtAmt; childType  = 'money-in';
    } else {
      parentAcct = body.target_account; parentAmt = tgtAmt; parentType = 'money-in';
      childAcct  = body.source_account; childAmt  = srcAmt; childType  = 'money-out';
    }

    const parentResult = _writeSingleTransaction(Object.assign(_txSharedFields(body), {
      tx_type:      parentType,
      account_id:   parentAcct,
      tx_amount:    parentAmt,
      parent_tx_id: '',
    }));
    if (!parentResult.ok) return parentResult;

    const childResult = _writeSingleTransaction(Object.assign(_txSharedFields(body), {
      tx_type:      childType,
      account_id:   childAcct,
      tx_amount:    childAmt,
      parent_tx_id: parentResult.id,
    }));
    if (!childResult.ok) return childResult;

    return { ok: true, ids: [parentResult.id, childResult.id] };
  }

  // Non-transfer: single row.
  // money-out → account_id from source_account; money-in → from target_account.
  const account_id = body.tx_type === 'money-in'
    ? (body.target_account || body.source_account || '')
    : (body.source_account || '');

  return _writeSingleTransaction(Object.assign(_txSharedFields(body), {
    tx_type:      body.tx_type,
    account_id:   account_id,
    tx_amount:    Number(body.source_amount),
    parent_tx_id: '',
  }));
}

// Shared categorisation/location/text fields extracted from the create body.
function _txSharedFields(body) {
  return {
    tx_date_time:            body.tx_date_time,
    tx_timezone:             body.tx_timezone             || '',
    user_location_area:      body.user_location_area      || '',
    user_location_city:      body.user_location_city      || '',
    user_location_country:   body.user_location_country   || '',
    user_location_latitude:  body.user_location_latitude  ?? '',
    user_location_longitude: body.user_location_longitude ?? '',
    major_category:          body.major_category          || '',
    minor_category:          body.minor_category          || '',
    description:             body.description             || '',
    counterparty_name:       body.counterparty_name       || '',
    tx_tags:                 body.tx_tags                 || '',
    beneficiaries:           body.beneficiaries           || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write one row to the sheet
// body: { tx_type, account_id, tx_amount, parent_tx_id, + shared fields }
// ─────────────────────────────────────────────────────────────────────────────
function _writeSingleTransaction(body) {
  const cols  = getTransactionSheetColumns();
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, cols);

  const dupCheck = _checkDuplicate(sheet, body);
  if (dupCheck) return dupCheck;

  const id  = generateTransactionId(sheet, body.tx_date_time);
  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getTransactionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',                      id);
  setCol('tx_date_time',            body.tx_date_time);
  setCol('tx_timezone',             body.tx_timezone             || '');
  setCol('parent_tx_id',            body.parent_tx_id            || '');
  setCol('tx_type',                 body.tx_type);
  setCol('account_id',              body.account_id              || '');
  setCol('user_location_area',      body.user_location_area      || '');
  setCol('user_location_city',      body.user_location_city      || '');
  setCol('user_location_country',   body.user_location_country   || '');
  setCol('user_location_latitude',  body.user_location_latitude  ?? '');
  setCol('user_location_longitude', body.user_location_longitude ?? '');
  setCol('tx_amount',               Number(body.tx_amount)       || 0);
  setCol('major_category',          body.major_category          || '');
  setCol('minor_category',          body.minor_category          || '');
  setCol('description',             body.description             || '');
  setCol('counterparty_name',       body.counterparty_name       || '');
  setCol('tx_tags',                 normaliseTags(body.tx_tags));
  setCol('beneficiaries',           body.beneficiaries           || '');

  const now = new Date().toISOString();
  setCol('record_status',   'active');
  setCol('sync_status',     SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date_time',  '');
  setCol('sync_notes',      '');
  setCol('created_at',      now);
  setCol('updated_at',      now);

  sheet.appendRow(row);
  return { ok: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update (single row)
// body: { row_num, tx_type, account_id, tx_amount, + categorisation/location fields }
// ─────────────────────────────────────────────────────────────────────────────
function updateTransaction(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const oldRow = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];

  if (String(oldRow[txColIndex('record_status')] || '') === 'locked')
    return { ok: false, error: 'record_locked' };

  const validation = validateTransactionUpdate(body, oldRow);
  if (!validation.ok) return validation;

  function writeField(key, value) {
    const field = getTransactionSchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('tx_date_time',           body.tx_date_time);
  writeField('tx_timezone',            body.tx_timezone            || '');
  writeField('tx_type',                body.tx_type);
  writeField('account_id',             body.account_id             || '');
  writeField('user_location_area',     body.user_location_area     || '');
  writeField('user_location_city',     body.user_location_city     || '');
  writeField('user_location_country',  body.user_location_country  || '');
  writeField('user_location_latitude', body.user_location_latitude ?? '');
  writeField('user_location_longitude',body.user_location_longitude ?? '');
  writeField('tx_amount',              Number(body.tx_amount)      || 0);
  writeField('major_category',         body.major_category         || '');
  writeField('minor_category',         body.minor_category         || '');
  writeField('description',            body.description            || '');
  writeField('counterparty_name',      body.counterparty_name      || '');
  writeField('tx_tags',                normaliseTags(body.tx_tags));
  writeField('beneficiaries',          body.beneficiaries          || '');

  const syncStatusCol     = getTransactionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getTransactionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol      = getTransactionSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(oldRow[txColIndex('sync_status')] || '');
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol).setValue(new Date().toISOString());

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete (soft)
// ─────────────────────────────────────────────────────────────────────────────
function deleteTransaction(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };

  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const rstatCol = getTransactionSchemaField('record_status').sheet_column_position;
  if (String(sheet.getRange(rowNum, rstatCol).getValue() || '') === 'locked')
    return { ok: false, error: 'record_locked' };

  const syncStatusCol     = getTransactionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getTransactionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol      = getTransactionSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(sheet.getRange(rowNum, syncStatusCol).getValue() || '');

  sheet.getRange(rowNum, rstatCol).setValue('deleted');
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol).setValue(new Date().toISOString());

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore (un-delete)
// ─────────────────────────────────────────────────────────────────────────────
function restoreTransaction(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };

  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const rstatCol = getTransactionSchemaField('record_status').sheet_column_position;
  if (String(sheet.getRange(rowNum, rstatCol).getValue() || '') !== 'deleted')
    return { ok: false, error: 'not_deleted' };

  const syncStatusCol     = getTransactionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getTransactionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol      = getTransactionSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(sheet.getRange(rowNum, syncStatusCol).getValue() || '');

  sheet.getRange(rowNum, rstatCol).setValue('active');
  sheet.getRange(rowNum, syncStatusCol).setValue(computeSyncStatus(currentSyncStatus));
  sheet.getRange(rowNum, syncNotesCol).setValue('');
  sheet.getRange(rowNum, updatedAtCol).setValue(new Date().toISOString());

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk create — chunked import path.
//
// The frontend sends rows in chunks of 25. Each chunk completes well inside
// the 30-second GAS doPost limit. One sheet read seeds the dup set from
// existing rows; the write remains a single setValues() for the whole chunk.
//
//   IDs       — Utilities.getUuid() suffix; no row scan needed.
//   Dup-check — existing sheet rows + within this chunk.
//   Write     — single setValues() for the whole chunk.
//
// body: { transactions: [ { same shape as createTransaction body } ] }
// ─────────────────────────────────────────────────────────────────────────────
function createTransactionsBulk(body) {
  if (!Array.isArray(body.transactions) || body.transactions.length === 0)
    return { ok: false, error: 'missing_transactions' };

  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const numCols = cols.length;
  const now     = new Date().toISOString();

  // Seed dup set from existing sheet rows so re-importing the same file is safe.
  const dupSet = new Set();
  (function seedDupSet() {
    const existing = sheet.getDataRange().getValues();
    if (existing.length <= 1) return;
    const ciDate  = txColIndex('tx_date_time');
    const ciType  = txColIndex('tx_type');
    const ciAcct  = txColIndex('account_id');
    const ciAmt   = txColIndex('tx_amount');
    const ciRstat = txColIndex('record_status');
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][ciRstat]) === 'deleted') continue;
      dupSet.add(
        String(existing[i][ciDate]) + '|' +
        String(existing[i][ciType]) + '|' +
        String(existing[i][ciAcct]) + '|' +
        String(Number(existing[i][ciAmt]) || 0)
      );
    }
  })();

  // ID = YYYY-MM-DD-{8 hex chars from UUID} — globally unique, no scan needed.
  function nextId(dateStr) {
    return String(dateStr).slice(0, 10) + '-' + Utilities.getUuid().slice(0, 8);
  }

  function dupKey(dateTime, type, acct, amt) {
    return String(dateTime) + '|' + String(type) + '|' + String(acct) + '|' + String(Number(amt) || 0);
  }

  // Build one sheet-row array without touching the sheet.
  function buildRow(b, id) {
    const row = new Array(numCols).fill('');
    function setC(key, value) {
      const f = getTransactionSchemaField(key);
      if (f) row[f.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
    }
    setC('id',                      id);
    setC('tx_date_time',            b.tx_date_time);
    setC('tx_timezone',             b.tx_timezone             || '');
    setC('parent_tx_id',            b.parent_tx_id            || '');
    setC('tx_type',                 b.tx_type);
    setC('account_id',              b.account_id              || '');
    setC('tx_amount',               Number(b.tx_amount)       || 0);
    setC('major_category',          b.major_category          || '');
    setC('minor_category',          b.minor_category          || '');
    setC('description',             b.description             || '');
    setC('counterparty_name',       b.counterparty_name       || '');
    setC('tx_tags',                 normaliseTags(b.tx_tags));
    setC('beneficiaries',           b.beneficiaries           || '');
    setC('user_location_area',      b.user_location_area      || '');
    setC('user_location_city',      b.user_location_city      || '');
    setC('user_location_country',   b.user_location_country   || '');
    setC('user_location_latitude',  b.user_location_latitude  ?? '');
    setC('user_location_longitude', b.user_location_longitude ?? '');
    setC('record_status',           'active');
    setC('sync_status',             SYNC_STATUS_CREATE_PENDING);
    setC('sync_date_time',          '');
    setC('sync_notes',              '');
    setC('created_at',              now);
    setC('updated_at',              now);
    return row;
  }

  // Memoised category hints — eliminates repeated category-sheet reads when
  // multiple rows in the chunk share the same category.
  const catCache = {};
  function getCat(type, major, minor) {
    const k = (type || '') + '|' + (major || '') + '|' + (minor || '');
    if (!(k in catCache)) catCache[k] = _findCategoryHints(type, major, minor);
    return catCache[k];
  }

  // ── Process each transaction in-memory ────────────────────────────────────
  const batchRows = [];
  const results   = [];

  body.transactions.forEach(function(tx) {
    const txBody = Object.assign({}, tx, { pin: body.pin });
    const label  = String(tx.tx_date_time || '').slice(0, 10) + ' ' +
                   String(tx.description || tx.counterparty_name || '').slice(0, 40);

    const val = validateTransactionCreate(txBody);
    if (!val.ok) {
      results.push({ label: label, ok: false, error: val.error, id: null, ids: null });
      return;
    }

    const cat        = getCat(txBody.tx_type, txBody.major_category, txBody.minor_category);
    const isTransfer = cat && cat.source_account_mandatory && cat.target_account_mandatory
      && txBody.source_account && txBody.target_account;

    if (isTransfer) {
      const srcAmt = Number(txBody.source_amount);
      const tgtAmt = txBody.target_amount && Number(txBody.target_amount) > 0
        ? Number(txBody.target_amount) : srcAmt;

      var parentAcct, parentAmt, parentType, childAcct, childAmt, childType;
      if (txBody.tx_type === 'money-out') {
        parentAcct = txBody.source_account; parentAmt = srcAmt; parentType = 'money-out';
        childAcct  = txBody.target_account; childAmt  = tgtAmt; childType  = 'money-in';
      } else {
        parentAcct = txBody.target_account; parentAmt = tgtAmt; parentType = 'money-in';
        childAcct  = txBody.source_account; childAmt  = srcAmt; childType  = 'money-out';
      }

      const pKey = dupKey(txBody.tx_date_time, parentType, parentAcct, parentAmt);
      const cKey = dupKey(txBody.tx_date_time, childType,  childAcct,  childAmt);
      if (dupSet.has(pKey) || dupSet.has(cKey)) {
        results.push({ label: label, ok: false, error: 'duplicate_transaction', id: null, ids: null });
        return;
      }

      const parentId = nextId(txBody.tx_date_time);
      const childId  = nextId(txBody.tx_date_time);
      dupSet.add(pKey);
      dupSet.add(cKey);

      const shared = _txSharedFields(txBody);
      batchRows.push(buildRow(Object.assign({}, shared, { tx_type: parentType, account_id: parentAcct, tx_amount: parentAmt, parent_tx_id: '' }), parentId));
      batchRows.push(buildRow(Object.assign({}, shared, { tx_type: childType,  account_id: childAcct,  tx_amount: childAmt,  parent_tx_id: parentId }), childId));
      results.push({ label: label, ok: true, error: null, id: null, ids: [parentId, childId] });
      return;
    }

    // Non-transfer: single row
    const acct = txBody.tx_type === 'money-in'
      ? (txBody.target_account || txBody.source_account || '')
      : (txBody.source_account || '');
    const amt  = Number(txBody.source_amount);
    const dKey = dupKey(txBody.tx_date_time, txBody.tx_type, acct, amt);

    if (dupSet.has(dKey)) {
      results.push({ label: label, ok: false, error: 'duplicate_transaction', id: null, ids: null });
      return;
    }

    const id = nextId(txBody.tx_date_time);
    dupSet.add(dKey);
    batchRows.push(buildRow(Object.assign(_txSharedFields(txBody), {
      tx_type: txBody.tx_type, account_id: acct, tx_amount: amt, parent_tx_id: '',
    }), id));
    results.push({ label: label, ok: true, error: null, id: id, ids: null });
  });

  // ── Single write for the entire batch ─────────────────────────────────────
  if (batchRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, batchRows.length, numCols).setValues(batchRows);
  }

  const failed = results.filter(function(r) { return !r.ok; });
  return {
    ok:      failed.length === 0,
    created: results.length - failed.length,
    failed:  failed.length,
    results: results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate check
// Key: (tx_date_time, tx_type, account_id, tx_amount) — skips deleted rows.
// ─────────────────────────────────────────────────────────────────────────────
function _checkDuplicate(sheet, body) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return null;

  const ciDate  = txColIndex('tx_date_time');
  const ciType  = txColIndex('tx_type');
  const ciAcct  = txColIndex('account_id');
  const ciAmt   = txColIndex('tx_amount');
  const ciRstat = txColIndex('record_status');

  const inDate = String(body.tx_date_time || '');
  const inType = String(body.tx_type      || '');
  const inAcct = String(body.account_id   || '');
  const inAmt  = Number(body.tx_amount)   || 0;

  for (var i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[ciRstat] || '') === 'deleted') continue;
    if (
      String(r[ciDate]) === inDate &&
      String(r[ciType]) === inType &&
      String(r[ciAcct]) === inAcct &&
      Number(r[ciAmt])  === inAmt
    ) {
      return { ok: false, error: 'duplicate_transaction' };
    }
  }
  return null;
}
