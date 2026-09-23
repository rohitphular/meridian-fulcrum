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
  const catMap     = _buildCategoryMap();
  const accountMap = _loadAccountMap();
  _defaultSameCurrencyTransferAmount(body, catMap, accountMap);
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

    // Build both validated legs before one sheet write to avoid half a transfer.
    const parentResult = _writeSingleTransaction(parentBody, { skipDupCheck: true, sheet: txSheet, deferWrite: true });
    if (!parentResult.ok) return parentResult;

    childBody.parent_tx_id = parentResult.id;
    const childResult = _writeSingleTransaction(childBody, { skipDupCheck: true, sheet: txSheet, deferWrite: true });
    if (!childResult.ok) return childResult;

    txSheet.getRange(txSheet.getLastRow() + 1, 1, 2, getTransactionSheetColumns().length)
      .setValues([parentResult.row, childResult.row]);
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

// Only a transfer between known accounts in the same currency can infer its
// missing target amount. Cross-currency legs require an explicit target amount.
function _defaultSameCurrencyTransferAmount(body, catMap, accountMap) {
  const category = catMap[body.tx_type + '|' + body.major_category + '|' + body.minor_category];
  if (category === undefined || category.source_account_mandatory !== true || category.target_account_mandatory !== true) return;
  if (body.target_amount_local !== undefined && body.target_amount_local !== null && String(body.target_amount_local).trim() !== '') return;
  const source = accountMap[String(body.source_account)];
  const target = accountMap[String(body.target_account)];
  if (source === undefined || target === undefined) return;
  const sourceCurrency = source.account_currency_local;
  const targetCurrency = target.account_currency_local;
  if (sourceCurrency === undefined || sourceCurrency === null || String(sourceCurrency).trim() === '') return;
  if (targetCurrency === undefined || targetCurrency === null || String(targetCurrency).trim() === '') return;
  if (String(sourceCurrency).trim().toUpperCase() !== String(targetCurrency).trim().toUpperCase()) return;
  if (body.source_amount_local !== undefined && body.source_amount_local !== null
      && Number.isFinite(Number(body.source_amount_local)) && Number(body.source_amount_local) > 0)
    body.target_amount_local = body.source_amount_local;
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
//   the function uses it directly and skips the getOrCreateSheet call. deferWrite
//   returns the built row so the caller can write a complete transfer in one call.
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

  const id  = generateTransactionId();
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

  if (opts !== undefined && opts !== null && opts.deferWrite === true) return { ok: true, id: id, row: row };
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
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

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
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

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
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

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
// Bulk create/replace — chunked import path with id-based upsert.
//
// Dedup rule: each incoming CSV row carries an `id` (uuid).
//   - Non-transfer row: the single sheet leg's `id` = the CSV row's `id`.
//   - Transfer row:     the PARENT leg's `id` = the CSV row's `id`; the CHILD leg
//                       retains its existing ID when present; parent_tx_id = CSV id.
//   - id absent:        generate a uuid for the (parent/single) leg and INSERT.
//
// Upsert per CSV id: before writing, every existing sheet row whose `id` equals a
// CSV id in this batch OR whose `parent_tx_id` equals a CSV id in this batch is
// replaced, with displaced children retained as deleted sync tombstones. Both legs of
// a transfer on re-import.
//
// Implementation — read-once, filter, rewrite:
//   1. Read all existing data rows once.
//   2. Build every new leg row in memory and collect the set of CSV ids used.
//   3. Keep existing rows whose id AND parent_tx_id are both outside the CSV-id set.
//      (Rows matching a CSV id are the ones being replaced — drop them.)
//   4. Write kept-rows + new-rows back in a single setValues(), preserving
//      created_at for any leg whose own id matched a kept-out (replaced) row, then
//      clear any now-surplus trailing rows left over from a shorter result set.
//
// This is correct because row deletions renumber the sheet: rewriting the entire
// data region from a computed array avoids the fragility of deleting rows by
// number mid-batch. POST dispatch serializes mutations with the script lock.
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
  // include_closed: historical import rows legitimately reference accounts that have
  // since been closed (inactive/locked). Interactive create keeps the strict map.
  const accountMap = _loadAccountMap({ include_closed: true });

  // ── Single read of existing rows ───────────────────────────────────────────
  const idColIdx        = txColIndex('id');
  const parentColIdx    = txColIndex('parent_tx_id');
  const createdAtColIdx = getTransactionSchemaField('created_at').sheet_column_position - 1;
  const existingData    = sheet.getDataRange().getValues();
  const existingRows    = existingData.length <= 1 ? [] : existingData.slice(1);

  // created_at lookup by leg id — used to preserve created_at when a leg is replaced.
  const createdAtById = Object.create(null);
  // Set of ids addressable by an existing row (its own id, or a parent_tx_id it points
  // to) — a CSV id in this set means the incoming row REPLACES existing leg(s).
  const existingAddressableIds = Object.create(null);
  const childIdByParentId = Object.create(null);
  const existingChildIds = Object.create(null);
  existingRows.forEach(function(r) {
    const rowId    = String(r[idColIdx]).trim();
    const parentId = String(r[parentColIdx]).trim();
    if (rowId !== '') {
      createdAtById[rowId]           = r[createdAtColIdx];
      existingAddressableIds[rowId]  = true;
    }
    if (parentId !== '') {
      existingAddressableIds[parentId] = true;
      childIdByParentId[parentId] = rowId;
      existingChildIds[rowId] = true;
    }
  });

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
    setC('updated_at',              now);
    // created_at: preserve when this leg's own id matches an existing (replaced) row;
    // otherwise stamp now. Reimported transfer children retain their IDs.
    const preserved = createdAtById[id];
    setC('created_at', preserved !== undefined ? preserved : now);
    // sync_status: a replaced leg advances to update-pending via computeSyncStatus.
    if (preserved !== undefined) {
      setC('sync_status', computeSyncStatus(_txSyncStatusForId(existingRows, idColIdx, id)));
    }
    return row;
  }

  // ── Process each transaction in-memory ────────────────────────────────────
  const newRows   = [];   // freshly built leg rows to write
  const batchIds  = Object.create(null);   // set of CSV ids used as a leg id or parent_tx_id in this batch
  const results   = [];
  let created = 0;
  let updated = 0;
  let failed  = 0;

  body.transactions.forEach(function(tx) {
    if (tx === null || typeof tx !== 'object' || Array.isArray(tx)) {
      results.push({ key: '', ok: false, error: 'invalid_row' });
      failed += 1;
      return;
    }
    const txBody = Object.assign({}, tx);

    _defaultSameCurrencyTransferAmount(txBody, catMap, accountMap);

    const val = validateTransactionRecord(txBody, catMap, accountMap);
    if (!val.ok) {
      results.push({ key: tx.id, ok: false, error: val.error });
      failed += 1;
      return;
    }

    // Resolve the leg id for this CSV row: caller-supplied id, else a generated uuid.
    const hasId = txBody.id !== undefined && txBody.id !== null && String(txBody.id).trim() !== '';
    const csvId = hasId ? String(txBody.id).trim() : Utilities.getUuid();
    if (existingChildIds[csvId] === true) {
      results.push({ key: csvId, ok: false, error: 'transfer_child_id_requires_parent' });
      failed += 1;
      return;
    }
    if (batchIds[csvId] === true) {
      results.push({ key: csvId, ok: false, error: 'duplicate_id_in_batch' });
      failed += 1;
      return;
    }
    batchIds[csvId] = true;
    // Replace vs insert is decided by whether this id already addresses existing legs.
    const isReplace = existingAddressableIds[csvId] === true;
    const action    = isReplace ? 'updated' : 'created';

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

      const parentId = csvId;                 // parent leg id = CSV id
      const childId  = childIdByParentId[parentId] !== undefined ? childIdByParentId[parentId] : Utilities.getUuid();

      const shared = _txSharedFields(txBody);
      newRows.push(buildRow(Object.assign({}, shared, { tx_type: parentType, account_id: parentAcct, tx_amount_local: parentAmt, parent_tx_id: '' }), parentId));
      newRows.push(buildRow(Object.assign({}, shared, { tx_type: childType,  account_id: childAcct,  tx_amount_local: childAmt,  parent_tx_id: parentId }), childId));
      results.push({ key: csvId, ok: true, action: action });
      if (isReplace) updated += 1; else created += 1;
      return;
    }

    // Non-transfer: single row. Account and amount from whichever side is mandatory.
    const acct = cat.source_account_mandatory ? txBody.source_account : txBody.target_account;
    const amt  = cat.source_account_mandatory ? Number(txBody.source_amount_local) : Number(txBody.target_amount_local);

    newRows.push(buildRow(Object.assign(_txSharedFields(txBody), {
      tx_type: txBody.tx_type, account_id: acct, tx_amount_local: amt, parent_tx_id: '',
    }), csvId));
    results.push({ key: csvId, ok: true, action: action });
    if (isReplace) updated += 1; else created += 1;
  });

  // ── Filter out existing rows being replaced by this batch ──────────────────
  // Drop any existing row whose own id, or whose parent_tx_id, is a CSV id in this
  // batch. Everything else is kept as-is.
  const newLegIds = Object.create(null);
  newRows.forEach(function(row) { newLegIds[String(row[idColIdx])] = true; });
  const keptRows = [];
  existingRows.forEach(function(r) {
    const rowId = String(r[idColIdx]).trim();
    const parentId = String(r[parentColIdx]).trim();
    if (batchIds[rowId] !== true && batchIds[parentId] !== true) {
      keptRows.push(r);
      return;
    }
    if (newLegIds[rowId] === true) return;
    // A removed transfer child must reach downstream sync as a deletion.
    const tombstone = r.slice();
    if (String(tombstone[txColIndex('record_status')]) !== 'deleted') {
      tombstone[txColIndex('record_status')] = 'deleted';
      tombstone[txColIndex('sync_status')] = computeSyncStatus(String(tombstone[txColIndex('sync_status')]));
      tombstone[txColIndex('sync_notes')] = '';
      tombstone[txColIndex('updated_at')] = now;
    }
    keptRows.push(tombstone);
  });

  if (created + updated === 0)
    return { ok: false, created: created, updated: updated, failed: failed, results: results };

  // ── Single rewrite of the whole data region ────────────────────────────────
  const finalRows      = keptRows.concat(newRows);
  const priorDataRows  = existingRows.length;
  if (finalRows.length > 0) {
    sheet.getRange(2, 1, finalRows.length, numCols).setValues(finalRows);
  }
  // Clear any surplus trailing rows left over when the batch shrank the row count
  // (e.g. re-importing a transfer as a single leg, or replacing 2 legs with 1).
  if (priorDataRows > finalRows.length) {
    const surplus = priorDataRows - finalRows.length;
    sheet.getRange(2 + finalRows.length, 1, surplus, numCols).clearContent();
  }

  console.log('createTransactionsBulk: input=' + body.transactions.length
    + ' created=' + created + ' updated=' + updated + ' failed=' + failed
    + ' kept=' + keptRows.length + ' new_legs=' + newRows.length);

  return {
    ok:      failed === 0,
    created: created,
    updated: updated,
    failed:  failed,
    results: results,
  };
}

// Returns the current sync_status of the existing leg with the given id, or '' if
// none. Used so a replaced leg advances via computeSyncStatus (create-pending stays
// create-pending; everything else becomes update-pending).
function _txSyncStatusForId(existingRows, idColIdx, id) {
  const syncStatusColIdx = getTransactionSchemaField('sync_status').sheet_column_position - 1;
  for (var i = 0; i < existingRows.length; i++) {
    if (String(existingRows[i][idColIdx]).trim() === id) return String(existingRows[i][syncStatusColIdx]);
  }
  return '';
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
