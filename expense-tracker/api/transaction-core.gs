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
  return sheetToObjectsWithRow(getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns())).map(function(row) {
    row.tx_date_local = sheetLocalDateTimeText(row.tx_date_local);
    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// body: { tx_type, source_account, target_account, source_amount_local, target_amount_local,
//         major_category, minor_category, + location/text fields }
// ─────────────────────────────────────────────────────────────────────────────
// Failures carry field + message for the form (txvFormError).
function createTransaction(body) {
  return txvFormError(_txcCreateTransaction(body), body);
}

function _txcCreateTransaction(body) {
  const catMap     = _buildCategoryMap();
  const accountMap = _loadAccountMap();
  _defaultSameCurrencyTransferAmount(body, catMap, accountMap);
  const validation = validateTransactionRecord(body, catMap, accountMap);
  if (!validation.ok) return validation;
  // Interactive-only rule; createTransactionsBulk (CSV import) never runs it.
  const balance = validateTransactionBalanceCreate(body, catMap, accountMap);
  if (balance.ok === false) return balance;

  const catKey  = body.tx_type + '|' + body.major_category + '|' + body.minor_category;
  const cat     = catMap[catKey];
  const isTransfer = cat.source_account_mandatory && cat.target_account_mandatory
    && body.source_account !== undefined && body.source_account !== null && String(body.source_account).trim() !== ''
    && body.target_account !== undefined && body.target_account !== null && String(body.target_account).trim() !== '';

  if (isTransfer) {
    const srcAmt = transactionDecimal(body.source_amount_local);
    const tgtAmt = transactionDecimal(body.target_amount_local);

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
  const tx_amount_local  = cat.source_account_mandatory ? transactionDecimal(body.source_amount_local) : transactionDecimal(body.target_amount_local);

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
      && isFiniteDecimal(body.source_amount_local) && Number(body.source_amount_local) > 0)
    body.target_amount_local = body.source_amount_local;
}

// Shared categorisation/location/text fields extracted from the create body.
function _txSharedFields(body) {
  return {
    tx_date_local:            body.tx_date_local,
    tx_timezone_local:             canonicalTransactionTimezone(body.tx_timezone_local),
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
  if (isFiniteDecimal(body.tx_amount_local) === false || Number(body.tx_amount_local) <= 0) return { ok: false, error: 'invalid_tx_amount' };

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
  setCol('tx_amount_local',         transactionDecimal(body.tx_amount_local));
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
// Failures carry field + message for the form (txvFormError).
function updateTransaction(body) {
  return txvFormError(_txcUpdateTransaction(body), body);
}

function _txcUpdateTransaction(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const cols    = getTransactionSheetColumns();
  const sheet   = getOrCreateSheet(TRANSACTIONS_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const oldRow = sheet.getRange(rowNum, 1, 1, cols.length).getValues()[0];
  if (matchesExpectedRecord(body, oldRow[txColIndex('id')], oldRow[txColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };

  if (String(oldRow[txColIndex('record_status')]) === 'locked')
    return { ok: false, error: 'record_locked' };

  if (String(oldRow[txColIndex('record_status')]) === 'deleted')
    return { ok: false, error: 'transaction_deleted' };

  // TX-NEW-H-2: pass catMap so validateTransactionUpdate avoids a redundant sheet read.
  const catMap     = _buildCategoryMap();
  const validation = validateTransactionUpdate(body, oldRow, catMap);
  if (!validation.ok) return validation;
  const balance = validateTransactionBalanceUpdate(body, oldRow);
  if (balance.ok === false) return balance;

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
  writeField('tx_amount_local',        transactionDecimal(body.tx_amount_local));
  writeField('major_category',         body.major_category          !== undefined && body.major_category          !== null ? String(body.major_category)           : '');
  writeField('minor_category',         body.minor_category          !== undefined && body.minor_category          !== null ? String(body.minor_category)           : '');
  writeField('description',            body.description             !== undefined && body.description             !== null ? String(body.description)             : '');
  writeField('counterparty_name',      body.counterparty_name       !== undefined && body.counterparty_name       !== null ? String(body.counterparty_name)       : '');
  writeField('tx_tags',                normaliseTags(body.tx_tags));
  writeField('beneficiaries',          body.beneficiaries           !== undefined && body.beneficiaries           !== null ? String(body.beneficiaries)           : '');

  const currentSyncStatus = String(oldRow[txColIndex('sync_status')]);
  updatedRow[getTransactionSchemaField('sync_status').sheet_column_position - 1] = computeSyncStatus(currentSyncStatus);
  updatedRow[txColIndex('sync_date')] = '';
  updatedRow[getTransactionSchemaField('sync_notes').sheet_column_position  - 1] = '';
  updatedRow[getTransactionSchemaField('updated_at').sheet_column_position  - 1] = new Date().toISOString();

  const pairValidation = validateTransactionPairChange(sheet, rowNum, updatedRow);
  if (pairValidation.ok === false) return pairValidation;

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
  if (matchesExpectedRecord(body, rowData[txColIndex('id')], rowData[txColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };
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
  updatedRow[txColIndex('sync_date')] = '';
  updatedRow[syncNotesCol  - 1] = '';
  updatedRow[updatedAtCol  - 1] = new Date().toISOString();

  const pairValidation = validateTransactionPairChange(sheet, rowNum, updatedRow);
  if (pairValidation.ok === false) return pairValidation;

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
  if (matchesExpectedRecord(body, rowData[txColIndex('id')], rowData[txColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };
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
  updatedRow[txColIndex('sync_date')] = '';
  updatedRow[syncNotesCol  - 1] = '';
  updatedRow[updatedAtCol  - 1] = new Date().toISOString();

  const pairValidation = validateTransactionPairChange(sheet, rowNum, updatedRow);
  if (pairValidation.ok === false) return pairValidation;

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
  const existingRowById = Object.create(null);
  // Set of ids addressable by an existing row (its own id, or a parent_tx_id it points
  // to) — a CSV id in this set means the incoming row REPLACES existing leg(s).
  const existingAddressableIds = Object.create(null);
  const childIdByParentId = Object.create(null);
  const existingChildIds = Object.create(null);
  for (let index = 0; index < existingRows.length; index++) {
    const row = existingRows[index];
    if (row.every(function(value) { return value === '' || value === null || value === undefined; })) continue;
    const rowId = _transactionUuid(row[idColIdx]);
    const rawParentId = String(row[parentColIdx] === undefined || row[parentColIdx] === null ? '' : row[parentColIdx]).trim();
    const parentId = rawParentId === '' ? '' : _transactionUuid(rawParentId);
    if (rowId === null) return { ok: false, error: 'invalid_existing_transaction_id', row_num: index + 2 };
    if (parentId === null) return { ok: false, error: 'invalid_existing_parent_tx_id', row_num: index + 2 };
    if (existingRowById[rowId] !== undefined) return { ok: false, error: 'duplicate_existing_transaction_id', row_num: index + 2 };
    createdAtById[rowId] = row[createdAtColIdx];
    existingRowById[rowId] = row;
    existingAddressableIds[rowId] = true;
    if (parentId !== '') {
      existingAddressableIds[parentId] = true;
      existingChildIds[rowId] = true;
      const previousChild = childIdByParentId[parentId];
      if (previousChild !== undefined && String(existingRowById[previousChild][txColIndex('record_status')]) !== 'deleted') {
        if (String(row[txColIndex('record_status')]) !== 'deleted') {
          return { ok: false, error: 'multiple_live_transfer_children', row_num: index + 2 };
        }
      } else {
        childIdByParentId[parentId] = rowId;
      }
    }
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
    setC('tx_amount_local',         transactionDecimal(b.tx_amount_local));
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
    setC('record_status',           b.record_status);
    setC('sync_status',             SYNC_STATUS_CREATE_PENDING);
    setC('sync_date',               '');
    setC('sync_notes',              '');
    setC('updated_at',              now);
    // created_at: preserve when this leg's own id matches an existing (replaced) row;
    // otherwise stamp now. Reimported transfer children retain their IDs.
    const preserved = createdAtById[_transactionUuid(id)];
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
  let skipped = 0;
  let failed  = 0;

  // Same values as every stored leg of this group (and no leg added or removed):
  // keep the stored rows exactly, so their sync status is untouched.
  function keepIfUnchanged(legRows) {
    const stored = legRows.map(function(leg) { return existingRowById[_transactionUuid(leg[idColIdx])]; });
    if (!legRows.every(function(leg, index) { return importRowUnchanged(cols, stored[index], leg); })) return null;
    return stored.map(function(row) { return row.slice(); });
  }

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
    const csvId = _transactionUuid(hasId ? txBody.id : Utilities.getUuid());
    if (csvId === null) {
      results.push({ key: hasId ? String(txBody.id) : '', ok: false, error: 'invalid_id' });
      failed += 1;
      return;
    }
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
    // Replace vs insert is decided by whether this id already addresses existing legs.
    const isReplace = existingAddressableIds[csvId] === true;
    const action    = isReplace ? 'updated' : 'created';
    const previous = existingRowById[csvId];
    const rawStatus = txBody.record_status === undefined || txBody.record_status === null ? '' : String(txBody.record_status).trim();
    const recordStatus = rawStatus !== '' ? rawStatus : previous === undefined ? 'active' : String(previous[txColIndex('record_status')]);
    if (getTransactionSchemaField('record_status').enum_values.indexOf(recordStatus) === -1) {
      results.push({ key: csvId, ok: false, error: 'invalid_record_status' });
      failed += 1;
      return;
    }
    const existingChildId = childIdByParentId[csvId];
    const previousChild = existingChildId === undefined ? undefined : existingRowById[existingChildId];
    if ((previous !== undefined && String(previous[txColIndex('record_status')]) === 'locked') ||
        (previousChild !== undefined && String(previousChild[txColIndex('record_status')]) === 'locked')) {
      results.push({ key: csvId, ok: false, error: 'record_locked' });
      failed += 1;
      return;
    }

    const catKey     = txBody.tx_type + '|' + txBody.major_category + '|' + txBody.minor_category;
    const cat        = catMap[catKey];
    const isTransfer = cat.source_account_mandatory && cat.target_account_mandatory
      && txBody.source_account !== undefined && txBody.source_account !== null && String(txBody.source_account).trim() !== ''
      && txBody.target_account !== undefined && txBody.target_account !== null && String(txBody.target_account).trim() !== '';

    if (isTransfer) {
      const srcAmt = transactionDecimal(txBody.source_amount_local);
      const tgtAmt = transactionDecimal(txBody.target_amount_local);

      var parentAcct, parentAmt, parentType, childAcct, childAmt, childType;
      if (txBody.tx_type === 'money-out') {
        parentAcct = txBody.source_account; parentAmt = srcAmt; parentType = 'money-out';
        childAcct  = txBody.target_account; childAmt  = tgtAmt; childType  = 'money-in';
      } else {
        parentAcct = txBody.target_account; parentAmt = tgtAmt; parentType = 'money-in';
        childAcct  = txBody.source_account; childAmt  = srcAmt; childType  = 'money-out';
      }

      // Match UUIDs canonically while preserving existing source spellings and links.
      const parentId = previous === undefined ? csvId : String(previous[idColIdx]).trim();
      const childId = previousChild === undefined ? _transactionUuid(Utilities.getUuid()) : String(previousChild[idColIdx]).trim();
      if (childId === null || _transactionUuid(childId) === csvId || batchIds[_transactionUuid(childId)] === true ||
          (previousChild === undefined && existingAddressableIds[_transactionUuid(childId)] === true)) {
        results.push({ key: csvId, ok: false, error: 'duplicate_generated_transaction_id' });
        failed += 1;
        return;
      }
      // An omitted lifecycle field retains each existing leg's lifecycle. An
      // explicit lifecycle applies to the complete pair, including restoration.
      // A tombstoned child (left by re-importing the transfer as a single row)
      // follows a live parent instead: one live leg alone would move money out
      // of one account without it arriving in the other.
      const storedChildStatus = previousChild === undefined ? '' : String(previousChild[txColIndex('record_status')]);
      const childStatus = rawStatus !== '' || previousChild === undefined || (storedChildStatus === 'deleted' && recordStatus !== 'deleted')
        ? recordStatus : storedChildStatus;
      if (getTransactionSchemaField('record_status').enum_values.indexOf(childStatus) === -1 ||
          (recordStatus === 'deleted') !== (childStatus === 'deleted')) {
        results.push({ key: csvId, ok: false, error: 'invalid_transfer_lifecycle' });
        failed += 1;
        return;
      }

      const shared = _txSharedFields(txBody);
      const legs = [
        buildRow(Object.assign({}, shared, { tx_type: parentType, account_id: parentAcct, tx_amount_local: parentAmt, parent_tx_id: '', record_status: recordStatus }), parentId),
        buildRow(Object.assign({}, shared, { tx_type: childType,  account_id: childAcct,  tx_amount_local: childAmt,  parent_tx_id: parentId, record_status: childStatus }), childId),
      ];
      const kept = isReplace && previousChild !== undefined ? keepIfUnchanged(legs) : null;
      Array.prototype.push.apply(newRows, kept === null ? legs : kept);
      batchIds[csvId] = true;
      batchIds[_transactionUuid(childId)] = true;
      results.push({ key: csvId, ok: true, action: kept === null ? action : 'unchanged' });
      if (kept !== null) skipped += 1; else if (isReplace) updated += 1; else created += 1;
      return;
    }

    // Non-transfer: single row. Account and amount from whichever side is mandatory.
    const acct = cat.source_account_mandatory ? txBody.source_account : txBody.target_account;
    const amt  = cat.source_account_mandatory ? transactionDecimal(txBody.source_amount_local) : transactionDecimal(txBody.target_amount_local);

    const leg = buildRow(Object.assign(_txSharedFields(txBody), {
      tx_type: txBody.tx_type, account_id: acct, tx_amount_local: amt, parent_tx_id: '', record_status: recordStatus,
    }), previous === undefined ? csvId : String(previous[idColIdx]).trim());
    // A former transfer re-imported as a single row changes shape (its child is tombstoned).
    const kept = isReplace && previous !== undefined && previousChild === undefined ? keepIfUnchanged([leg]) : null;
    Array.prototype.push.apply(newRows, kept === null ? [leg] : kept);
    batchIds[csvId] = true;
    results.push({ key: csvId, ok: true, action: kept === null ? action : 'unchanged' });
    if (kept !== null) skipped += 1; else if (isReplace) updated += 1; else created += 1;
  });

  // ── Filter out existing rows being replaced by this batch ──────────────────
  // Drop any existing row whose own id, or whose parent_tx_id, is a CSV id in this
  // batch. Everything else is kept as-is.
  const newLegIds = Object.create(null);
  newRows.forEach(function(row) { newLegIds[_transactionUuid(row[idColIdx])] = true; });
  const keptRows = [];
  existingRows.forEach(function(r) {
    const rowId = _transactionUuid(r[idColIdx]);
    const parentId = _transactionUuid(r[parentColIdx]);
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
      tombstone[txColIndex('sync_date')] = '';
      tombstone[txColIndex('sync_notes')] = '';
      tombstone[txColIndex('updated_at')] = now;
    }
    keptRows.push(tombstone);
  });

  if (created + updated === 0)
    return { ok: skipped > 0 && failed === 0, created: created, updated: updated, skipped: skipped, failed: failed, results: results };

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
    + ' created=' + created + ' updated=' + updated + ' unchanged=' + skipped + ' failed=' + failed
    + ' kept=' + keptRows.length + ' new_legs=' + newRows.length);

  return {
    ok:      failed === 0,
    created: created,
    updated: updated,
    skipped: skipped,
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
    if (_transactionUuid(existingRows[i][idColIdx]) === _transactionUuid(id)) return String(existingRows[i][syncStatusColIdx]);
  }
  return '';
}

function _transactionUuid(value) {
  if (typeof value !== 'string') return null;
  const identity = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity) ? identity : null;
}

// Sheet business/lifecycle edits must enter normal sync. Metadata-only edits do
// not requeue rows. Multi-row pastes update only sync cells and updated_at.
function markTransactionEditPending(event) {
  const editedSheet = event.range.getSheet();
  if (editedSheet.getName() !== TRANSACTIONS_SHEET) return false;
  _assertMasterSheetNameReady(SpreadsheetApp.getActiveSpreadsheet(), TRANSACTIONS_SHEET);
  const firstColumn = event.range.getColumn();
  const lastColumn = firstColumn + event.range.getNumColumns() - 1;
  const lifecycleColumn = txColIndex('record_status') + 1;
  if (firstColumn > lifecycleColumn || lastColumn < 1) return true;
  const firstRow = Math.max(2, event.range.getRow());
  const lastRow = Math.min(editedSheet.getLastRow(), event.range.getRow() + event.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const columns = getTransactionSheetColumns();
  const headers = editedSheet.getRange(1, 1, 1, editedSheet.getLastColumn()).getValues()[0];
  if (headers.length !== columns.length || headers.some(function(header, index) { return header !== columns[index]; })) {
    throw new Error('sheet_header_mismatch');
  }
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, columns);
  const rows = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  const syncValues = [];
  const updateValues = [];
  let queued = 0;
  for (let rowNum = firstRow; rowNum <= lastRow; rowNum++) {
    const row = rows[rowNum - 1];
    if (row.every(function(value) { return value === '' || value === null || value === undefined; })) {
      // Retain interior blank rows without creating phantom pending records.
      syncValues.push(['', '', '']);
      updateValues.push(['']);
      continue;
    }
    const rawStatus = row[txColIndex('sync_status')];
    const currentStatus = rawStatus === undefined || rawStatus === null ? '' : String(rawStatus).trim();
    syncValues.push([computeSyncStatus(currentStatus), '', '']);
    updateValues.push([now]);
    queued += 1;
  }
  if (queued === 0) return true;
  // Two range writes keep large pastes within the simple-trigger time budget.
  // Queue status first so a later audit-write failure cannot leave edited rows in-sync.
  if (firstRow < 2 || lastRow > sheet.getLastRow()) throw new Error('invalid_row');
  sheet.getRange(firstRow, txColIndex('sync_status') + 1, syncValues.length, 3).setValues(syncValues);
  if (firstRow < 2 || lastRow > sheet.getLastRow()) throw new Error('invalid_row');
  sheet.getRange(firstRow, txColIndex('updated_at') + 1, updateValues.length, 1).setValues(updateValues);
  return true;
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

  const inDate = localDateTimeKey(sheetLocalDateTimeText(body.tx_date_local));
  const inType = body.tx_type         !== undefined && body.tx_type         !== null ? String(body.tx_type)         : '';
  const inAcct = body.account_id      !== undefined && body.account_id      !== null ? String(body.account_id).trim().toLowerCase() : '';
  const inAmt  = transactionDecimalKey(body.tx_amount_local);

  // TX-NEW-C-1: NaN amount can never match — return null (no duplicate found) immediately.
  if (inAmt === null || inDate === null) return null;

  for (var i = 1; i < rows.length; i++) {
    // rows[i] is 0-based; sheet row is i+1 (header is row 1, data starts at row 2 → i=1 → rowNum=2).
    if (excludeRowNum !== undefined && excludeRowNum !== null && (i + 1) === excludeRowNum) continue;
    const r = rows[i];
    if (String(r[ciRstat]) === 'deleted') continue;
    if (
      localDateTimeKey(sheetLocalDateTimeText(r[ciDate])) === inDate &&
      String(r[ciType]) === inType &&
      String(r[ciAcct]).trim().toLowerCase() === inAcct &&
      transactionDecimalKey(r[ciAmt]) === inAmt
    ) {
      return { ok: false, error: 'duplicate_transaction' };
    }
  }
  return null;
}
