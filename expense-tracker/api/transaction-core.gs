// =============================================================================
// FULCRUM FORGE — Transaction Core: CRUD + balance adjustment
//
// Storage model: one row per account movement (account_id + tx_amount_local).
// Transfers create 2 rows linked via parent_tx_id.
//
// Create API receives: source_account, target_account, source_amount_local, target_amount_local
// (same as CSV import format). Backend maps to account_id / tx_amount_local per row.
//
// Update API receives: account_id, tx_amount_local (single-row edit — no source/target).
// =============================================================================

function listTransactions() {
  return sheetToObjectsWithRow(getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// body: { tx_type, source_account, target_account, source_amount_local, target_amount_local,
//         major_category, minor_category, + location/text fields }
// ─────────────────────────────────────────────────────────────────────────────
function createTransaction(body) {
  if ((body.target_amount_local === undefined || body.target_amount_local === null || String(body.target_amount_local).trim() === '' || !Number.isFinite(Number(body.target_amount_local)) || Number(body.target_amount_local) <= 0) &&
      body.source_amount_local !== undefined && body.source_amount_local !== null && Number.isFinite(Number(body.source_amount_local)) && Number(body.source_amount_local) > 0) {
    body.target_amount_local = body.source_amount_local;
  }

  const catMap     = _buildCategoryMap();
  const accountMap = _loadAccountMap();
  const validation = validateTransactionRecord(body, catMap, accountMap);
  if (!validation.ok) return validation;

  const catKey  = body.tx_type + '|' + body.major_category + '|' + body.minor_category;
  const cat     = catMap[catKey];
  const isTransfer = cat.source_account_mandatory && cat.target_account_mandatory
    && body.source_account !== undefined && body.source_account !== null && String(body.source_account).trim() !== ''
    && body.target_account !== undefined && body.target_account !== null && String(body.target_account).trim() !== '';

  if (isTransfer) {
    const srcAmt = Number(body.source_amount_local);
    const tgtAmt = Number(body.target_amount_local);

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

    // T-C1 + T-C3: pre-check duplicates for BOTH legs before any row is written.
    // This prevents orphan rows when the child leg would be a duplicate.
    // Opening the sheet once here; _checkDuplicate does its own getDataRange() read.
    const txSheet    = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
    const parentBody = Object.assign(_txSharedFields(body), {
      tx_type: parentType, account_id: parentAcct, tx_amount_local: parentAmt, parent_tx_id: '',
    });
    const childBody  = Object.assign(_txSharedFields(body), {
      tx_type: childType, account_id: childAcct, tx_amount_local: childAmt, parent_tx_id: '',
    });

    const parentDup = _checkDuplicate(txSheet, parentBody);
    if (parentDup) return parentDup;
    const childDup  = _checkDuplicate(txSheet, childBody);
    if (childDup) return childDup;

    // Both legs are clean — write parent first, then child (child carries parent_tx_id).
    const parentResult = _writeSingleTransaction(parentBody, { skipDupCheck: true, sheet: txSheet });
    if (!parentResult.ok) return parentResult;

    childBody.parent_tx_id = parentResult.id;
    const childResult = _writeSingleTransaction(childBody, { skipDupCheck: true, sheet: txSheet });
    if (!childResult.ok) return childResult;

    return { ok: true, ids: [parentResult.id, childResult.id] };
  }

  // Non-transfer: single row. Account and amount come from whichever side is mandatory.
  const account_id = cat.source_account_mandatory ? body.source_account : body.target_account;
  const tx_amount_local  = cat.source_account_mandatory ? Number(body.source_amount_local) : Number(body.target_amount_local);

  return _writeSingleTransaction(Object.assign(_txSharedFields(body), {
    tx_type:         body.tx_type,
    account_id:      account_id,
    tx_amount_local: tx_amount_local,
    parent_tx_id:    '',
  }));
}

// Shared categorisation/location/text fields extracted from the create body.
function _txSharedFields(body) {
  return {
    tx_date_local:            body.tx_date_local,
    tx_timezone_local:             body.tx_timezone_local             !== undefined && body.tx_timezone_local             !== null ? String(body.tx_timezone_local)             : '',
    user_location_area:      body.user_location_area      !== undefined && body.user_location_area      !== null ? String(body.user_location_area)      : '',
    user_location_city:      body.user_location_city      !== undefined && body.user_location_city      !== null ? String(body.user_location_city)       : '',
    user_location_country:   body.user_location_country   !== undefined && body.user_location_country   !== null ? String(body.user_location_country)    : '',
    user_location_latitude:  body.user_location_latitude  !== undefined && body.user_location_latitude  !== null ? body.user_location_latitude           : '',
    user_location_longitude: body.user_location_longitude !== undefined && body.user_location_longitude !== null ? body.user_location_longitude          : '',
    major_category:          body.major_category          !== undefined && body.major_category          !== null ? String(body.major_category)           : '',
    minor_category:          body.minor_category          !== undefined && body.minor_category          !== null ? String(body.minor_category)           : '',
    description:             body.description             !== undefined && body.description             !== null ? String(body.description)             : '',
    counterparty_name:       body.counterparty_name       !== undefined && body.counterparty_name       !== null ? String(body.counterparty_name)       : '',
    tx_tags:                 body.tx_tags                 !== undefined && body.tx_tags                 !== null ? String(body.tx_tags)                 : '',
    beneficiaries:           body.beneficiaries           !== undefined && body.beneficiaries           !== null ? String(body.beneficiaries)           : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write one row to the sheet
// body: { tx_type, account_id, tx_amount_local, parent_tx_id, + shared fields }
// opts: { skipDupCheck: boolean, sheet: Sheet } — skipDupCheck: set true when
//   caller has already run _checkDuplicate (e.g. the transfer path pre-checks
//   both legs before any write). sheet: pre-opened sheet object; when provided
//   the function uses it directly and skips the getOrCreateSheet call.
// ─────────────────────────────────────────────────────────────────────────────
function _writeSingleTransaction(body, opts) {
  const cols  = getTransactionSheetColumns();
  const sheet = (opts !== undefined && opts !== null && opts.sheet !== undefined && opts.sheet !== null)
    ? opts.sheet
    : getOrCreateSheet(TRANSACTIONS_SHEET, cols);

  // TX-NEW-H-7: guard against NaN amounts before any sheet interaction.
  if (!Number.isFinite(Number(body.tx_amount_local))) return { ok: false, error: 'invalid_tx_amount' };

  // T-C1/T-C3: skip internal dup check when the caller has already done it.
  if (!opts || !opts.skipDupCheck) {
    const dupCheck = _checkDuplicate(sheet, body);
    if (dupCheck) return dupCheck;
  }

  const id  = generateTransactionId(sheet, body.tx_date_local);
  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getTransactionSchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('id',                      id);
  setCol('tx_date_local',            body.tx_date_local);
  setCol('tx_timezone_local',             body.tx_timezone_local             !== undefined && body.tx_timezone_local             !== null ? String(body.tx_timezone_local)             : '');
  setCol('parent_tx_id',            body.parent_tx_id            !== undefined && body.parent_tx_id            !== null ? String(body.parent_tx_id)            : '');
  setCol('tx_type',                 body.tx_type);
  setCol('account_id',              body.account_id              !== undefined && body.account_id              !== null ? String(body.account_id)              : '');
  setCol('user_location_area',      body.user_location_area      !== undefined && body.user_location_area      !== null ? String(body.user_location_area)      : '');
  setCol('user_location_city',      body.user_location_city      !== undefined && body.user_location_city      !== null ? String(body.user_location_city)       : '');
  setCol('user_location_country',   body.user_location_country   !== undefined && body.user_location_country   !== null ? String(body.user_location_country)   : '');
  setCol('user_location_latitude',  body.user_location_latitude  !== undefined && body.user_location_latitude  !== null ? body.user_location_latitude          : '');
  setCol('user_location_longitude', body.user_location_longitude !== undefined && body.user_location_longitude !== null ? body.user_location_longitude         : '');
  setCol('tx_amount_local',         Number(body.tx_amount_local));
  setCol('major_category',          body.major_category          !== undefined && body.major_category          !== null ? String(body.major_category)           : '');
  setCol('minor_category',          body.minor_category          !== undefined && body.minor_category          !== null ? String(body.minor_category)           : '');
  setCol('description',             body.description             !== undefined && body.description             !== null ? String(body.description)             : '');
  setCol('counterparty_name',       body.counterparty_name       !== undefined && body.counterparty_name       !== null ? String(body.counterparty_name)       : '');
  setCol('tx_tags',                 normaliseTags(body.tx_tags));
  setCol('beneficiaries',           body.beneficiaries           !== undefined && body.beneficiaries           !== null ? String(body.beneficiaries)           : '');

  const now = new Date().toISOString();
  setCol('record_status',   'active');
  setCol('sync_status',     SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date',       '');
  setCol('sync_notes',      '');
  setCol('created_at',      now);
  setCol('updated_at',      now);

  sheet.appendRow(row);
  return { ok: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update (single row)
// body: { row_num, tx_type, account_id, tx_amount_local, + categorisation/location fields }
// ─────────────────────────────────────────────────────────────────────────────
function updateTransaction(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isFinite(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const oldRow = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];

  if (String(oldRow[txColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  if (String(oldRow[txColIndex('record_status')]) === 'deleted')
    return { ok: false, error: 'transaction_deleted' };

  // TX-NEW-H-2: pass catMap so validateTransactionUpdate avoids a redundant sheet read.
  const catMap     = _buildCategoryMap();
  const validation = validateTransactionUpdate(body, oldRow, catMap);
  if (!validation.ok) return validation;

  // TX-M-6: duplicate check — exclude the current row from the scan.
  const dupResult = _checkDuplicate(sheet, {
    tx_date_local:   body.tx_date_local,
    tx_type:         body.tx_type,
    account_id:      body.account_id,
    tx_amount_local: body.tx_amount_local,
  }, rowNum);
  if (dupResult) return dupResult;

  // TX-H-8: read full row once, mutate in-array, write back with single setValues().
  const updatedRow = oldRow.slice(); // shallow copy of the 1-D row array

  function writeField(key, value) {
    const field = getTransactionSchemaField(key);
    if (!field || !field.editable) return;
    updatedRow[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  writeField('tx_date_local',           body.tx_date_local);
  writeField('tx_type',                body.tx_type);
  writeField('account_id',             body.account_id              !== undefined && body.account_id              !== null ? String(body.account_id)              : '');
  writeField('user_location_area',     body.user_location_area      !== undefined && body.user_location_area      !== null ? String(body.user_location_area)      : '');
  writeField('user_location_city',     body.user_location_city      !== undefined && body.user_location_city      !== null ? String(body.user_location_city)       : '');
  writeField('user_location_country',  body.user_location_country   !== undefined && body.user_location_country   !== null ? String(body.user_location_country)   : '');
  writeField('user_location_latitude', body.user_location_latitude  !== undefined && body.user_location_latitude  !== null ? body.user_location_latitude          : '');
  writeField('user_location_longitude',body.user_location_longitude !== undefined && body.user_location_longitude !== null ? body.user_location_longitude         : '');
  writeField('tx_amount_local',        Number(body.tx_amount_local));
  writeField('major_category',         body.major_category          !== undefined && body.major_category          !== null ? String(body.major_category)           : '');
  writeField('minor_category',         body.minor_category          !== undefined && body.minor_category          !== null ? String(body.minor_category)           : '');
  writeField('description',            body.description             !== undefined && body.description             !== null ? String(body.description)             : '');
  writeField('counterparty_name',      body.counterparty_name       !== undefined && body.counterparty_name       !== null ? String(body.counterparty_name)       : '');
  writeField('tx_tags',                normaliseTags(body.tx_tags));
  writeField('beneficiaries',          body.beneficiaries           !== undefined && body.beneficiaries           !== null ? String(body.beneficiaries)           : '');

  const currentSyncStatus = String(oldRow[txColIndex('sync_status')]);
  updatedRow[getTransactionSchemaField('sync_status').sheet_column_position - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[getTransactionSchemaField('sync_notes').sheet_column_position  - 1] = '';
  updatedRow[getTransactionSchemaField('updated_at').sheet_column_position  - 1] = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, cols.length).setValues([updatedRow]);

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete (soft)
// ─────────────────────────────────────────────────────────────────────────────
function deleteTransaction(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };

  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isFinite(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // TX-NEW-H-1 + T-H6: single row read; mutate in-array; single setValues() write.
  const rowData           = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];
  const rstatCol          = getTransactionSchemaField('record_status').sheet_column_position;
  const syncStatusCol     = getTransactionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getTransactionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol      = getTransactionSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(rowData[syncStatusCol - 1]);

  if (String(rowData[rstatCol - 1]) === 'locked')
    return { ok: false, error: 'record_locked' };

  // TX-NEW-C-3: guard against double-delete.
  if (String(rowData[rstatCol - 1]) === 'deleted')
    return { ok: false, error: 'transaction_already_deleted' };

  const updatedRow = rowData.slice();
  updatedRow[rstatCol      - 1] = 'deleted';
  updatedRow[syncStatusCol - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[syncNotesCol  - 1] = '';
  updatedRow[updatedAtCol  - 1] = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, cols.length).setValues([updatedRow]);

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore (un-delete)
// ─────────────────────────────────────────────────────────────────────────────
function restoreTransaction(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };

  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isFinite(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // T-H6: single row read for all field values — replaces N individual getValue() calls.
  const rowData           = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];
  const rstatCol          = getTransactionSchemaField('record_status').sheet_column_position;
  const syncStatusCol     = getTransactionSchemaField('sync_status').sheet_column_position;
  const syncNotesCol      = getTransactionSchemaField('sync_notes').sheet_column_position;
  const updatedAtCol      = getTransactionSchemaField('updated_at').sheet_column_position;
  const currentSyncStatus = String(rowData[syncStatusCol - 1]);

  if (String(rowData[rstatCol - 1]) !== 'deleted')
    return { ok: false, error: 'not_deleted' };

  // TX-NEW-H-1: mutate in-array; single setValues() write.
  const updatedRow = rowData.slice();
  updatedRow[rstatCol      - 1] = 'active';
  updatedRow[syncStatusCol - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[syncNotesCol  - 1] = '';
  updatedRow[updatedAtCol  - 1] = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, cols.length).setValues([updatedRow]);

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

  // Category map — one sheet read shared across all records in this batch.
  const catMap = _buildCategoryMap();

  // TX-NEW-H-3: account map — one sheet read shared across all records in this batch.
  const accountMap = _loadAccountMap();

  // Seed dup set from existing sheet rows so re-importing the same file is safe.
  const dupSet = new Set();
  (function seedDupSet() {
    const existing = sheet.getDataRange().getValues();
    if (existing.length <= 1) return;
    const ciDate  = txColIndex('tx_date_local');
    const ciType  = txColIndex('tx_type');
    const ciAcct  = txColIndex('account_id');
    const ciAmt   = txColIndex('tx_amount_local');
    const ciRstat = txColIndex('record_status');
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][ciRstat]) === 'deleted') continue;
      dupSet.add(
        String(existing[i][ciDate]) + '|' +
        String(existing[i][ciType]) + '|' +
        String(existing[i][ciAcct]) + '|' +
        String(Number(existing[i][ciAmt]))
      );
    }
  })();

  // ID = YYYY-MM-DD-{8 hex chars from UUID} — globally unique, no scan needed.
  function nextId(dateStr) {
    return String(dateStr).slice(0, 10) + '-' + Utilities.getUuid().slice(0, 8);
  }

  function dupKey(dateTime, type, acct, amt) {
    return String(dateTime) + '|' + String(type) + '|' + String(acct) + '|' + String(Number(amt));
  }

  // Build one sheet-row array without touching the sheet.
  function buildRow(b, id) {
    const row = new Array(numCols).fill('');
    function setC(key, value) {
      const f = getTransactionSchemaField(key);
      if (f) row[f.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
    }
    setC('id',                      id);
    setC('tx_date_local',            b.tx_date_local);
    setC('tx_timezone_local',             b.tx_timezone_local             !== undefined && b.tx_timezone_local             !== null ? String(b.tx_timezone_local)             : '');
    setC('parent_tx_id',            b.parent_tx_id            !== undefined && b.parent_tx_id            !== null ? String(b.parent_tx_id)            : '');
    setC('tx_type',                 b.tx_type);
    setC('account_id',              b.account_id              !== undefined && b.account_id              !== null ? String(b.account_id)              : '');
    setC('tx_amount_local',         Number(b.tx_amount_local));
    setC('major_category',          b.major_category          !== undefined && b.major_category          !== null ? String(b.major_category)          : '');
    setC('minor_category',          b.minor_category          !== undefined && b.minor_category          !== null ? String(b.minor_category)          : '');
    setC('description',             b.description             !== undefined && b.description             !== null ? String(b.description)             : '');
    setC('counterparty_name',       b.counterparty_name       !== undefined && b.counterparty_name       !== null ? String(b.counterparty_name)       : '');
    setC('tx_tags',                 normaliseTags(b.tx_tags));
    setC('beneficiaries',           b.beneficiaries           !== undefined && b.beneficiaries           !== null ? String(b.beneficiaries)           : '');
    setC('user_location_area',      b.user_location_area      !== undefined && b.user_location_area      !== null ? String(b.user_location_area)      : '');
    setC('user_location_city',      b.user_location_city      !== undefined && b.user_location_city      !== null ? String(b.user_location_city)       : '');
    setC('user_location_country',   b.user_location_country   !== undefined && b.user_location_country   !== null ? String(b.user_location_country)   : '');
    setC('user_location_latitude',  b.user_location_latitude  !== undefined && b.user_location_latitude  !== null ? b.user_location_latitude          : '');
    setC('user_location_longitude', b.user_location_longitude !== undefined && b.user_location_longitude !== null ? b.user_location_longitude         : '');
    setC('record_status',           'active');
    setC('sync_status',             SYNC_STATUS_CREATE_PENDING);
    setC('sync_date',               '');
    setC('sync_notes',              '');
    setC('created_at',              now);
    setC('updated_at',              now);
    return row;
  }

  // ── Process each transaction in-memory ────────────────────────────────────
  const batchRows = [];
  const results   = [];

  body.transactions.forEach(function(tx) {
    const txBody = Object.assign({}, tx);
    const labelDate = tx.tx_date_local !== undefined && tx.tx_date_local !== null ? String(tx.tx_date_local).slice(0, 10) : '';
    const labelDesc = tx.description !== undefined && tx.description !== null && String(tx.description).trim() !== ''
      ? String(tx.description)
      : (tx.counterparty_name !== undefined && tx.counterparty_name !== null ? String(tx.counterparty_name) : '');
    const label = labelDate + ' ' + labelDesc.slice(0, 40);

    if ((txBody.target_amount_local === undefined || txBody.target_amount_local === null || String(txBody.target_amount_local).trim() === '' || !Number.isFinite(Number(txBody.target_amount_local)) || Number(txBody.target_amount_local) <= 0) &&
        txBody.source_amount_local !== undefined && txBody.source_amount_local !== null && Number.isFinite(Number(txBody.source_amount_local)) && Number(txBody.source_amount_local) > 0) {
      txBody.target_amount_local = txBody.source_amount_local;
    }

    const val = validateTransactionRecord(txBody, catMap, accountMap);
    if (!val.ok) {
      results.push({ label: label, ok: false, error: val.error, id: null, ids: null });
      return;
    }

    const catKey     = txBody.tx_type + '|' + txBody.major_category + '|' + txBody.minor_category;
    const cat        = catMap[catKey];
    const isTransfer = cat.source_account_mandatory && cat.target_account_mandatory
      && txBody.source_account !== undefined && txBody.source_account !== null && String(txBody.source_account).trim() !== ''
      && txBody.target_account !== undefined && txBody.target_account !== null && String(txBody.target_account).trim() !== '';

    if (isTransfer) {
      const srcAmt = Number(txBody.source_amount_local);
      const tgtAmt = Number(txBody.target_amount_local);

      var parentAcct, parentAmt, parentType, childAcct, childAmt, childType;
      if (txBody.tx_type === 'money-out') {
        parentAcct = txBody.source_account; parentAmt = srcAmt; parentType = 'money-out';
        childAcct  = txBody.target_account; childAmt  = tgtAmt; childType  = 'money-in';
      } else {
        parentAcct = txBody.target_account; parentAmt = tgtAmt; parentType = 'money-in';
        childAcct  = txBody.source_account; childAmt  = srcAmt; childType  = 'money-out';
      }

      const pKey = dupKey(txBody.tx_date_local, parentType, parentAcct, parentAmt);
      const cKey = dupKey(txBody.tx_date_local, childType,  childAcct,  childAmt);
      if (dupSet.has(pKey) || dupSet.has(cKey)) {
        results.push({ label: label, ok: false, error: 'duplicate_transaction', id: null, ids: null });
        return;
      }

      const parentId = nextId(txBody.tx_date_local);
      const childId  = nextId(txBody.tx_date_local);
      dupSet.add(pKey);
      dupSet.add(cKey);

      const shared = _txSharedFields(txBody);
      batchRows.push(buildRow(Object.assign({}, shared, { tx_type: parentType, account_id: parentAcct, tx_amount_local: parentAmt, parent_tx_id: '' }), parentId));
      batchRows.push(buildRow(Object.assign({}, shared, { tx_type: childType,  account_id: childAcct,  tx_amount_local: childAmt,  parent_tx_id: parentId }), childId));
      results.push({ label: label, ok: true, error: null, id: null, ids: [parentId, childId] });
      return;
    }

    // Non-transfer: single row. Account and amount from whichever side is mandatory.
    const acct = cat.source_account_mandatory ? txBody.source_account : txBody.target_account;
    const amt  = cat.source_account_mandatory ? Number(txBody.source_amount_local) : Number(txBody.target_amount_local);
    const dKey = dupKey(txBody.tx_date_local, txBody.tx_type, acct, amt);

    if (dupSet.has(dKey)) {
      results.push({ label: label, ok: false, error: 'duplicate_transaction', id: null, ids: null });
      return;
    }

    const id = nextId(txBody.tx_date_local);
    dupSet.add(dKey);
    batchRows.push(buildRow(Object.assign(_txSharedFields(txBody), {
      tx_type: txBody.tx_type, account_id: acct, tx_amount_local: amt, parent_tx_id: '',
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
// Key: (tx_date_local, tx_type, account_id, tx_amount_local) — skips deleted rows.
// ─────────────────────────────────────────────────────────────────────────────
// excludeRowNum — optional 1-based sheet row number to skip (used by updateTransaction to exclude the row being edited).
function _checkDuplicate(sheet, body, excludeRowNum) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return null;

  const ciDate  = txColIndex('tx_date_local');
  const ciType  = txColIndex('tx_type');
  const ciAcct  = txColIndex('account_id');
  const ciAmt   = txColIndex('tx_amount_local');
  const ciRstat = txColIndex('record_status');

  const inDate = body.tx_date_local   !== undefined && body.tx_date_local   !== null ? String(body.tx_date_local)   : '';
  const inType = body.tx_type         !== undefined && body.tx_type         !== null ? String(body.tx_type)         : '';
  const inAcct = body.account_id      !== undefined && body.account_id      !== null ? String(body.account_id)      : '';
  const inAmt  = Number(body.tx_amount_local);

  // TX-NEW-C-1: NaN amount can never match — return null (no duplicate found) immediately.
  if (!Number.isFinite(inAmt)) return null;

  for (var i = 1; i < rows.length; i++) {
    // rows[i] is 0-based; sheet row is i+1 (header is row 1, data starts at row 2 → i=1 → rowNum=2).
    if (excludeRowNum !== undefined && excludeRowNum !== null && (i + 1) === excludeRowNum) continue;
    const r = rows[i];
    if (String(r[ciRstat]) === 'deleted') continue;
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
