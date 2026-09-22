// =============================================================================
// FULCRUM FORGE — Import Core: generic multi-file-type account data importer
//
// Action: import_account_data
// Body:   { action:'import_account_data', pin, file_type, rows }
//         rows = array of plain objects keyed by column name (header → value).
//
// Behaviour: id-based upsert. Each detail row carries an `id` (required by the
//   registry for every detail file_type). One sheet read builds a map of
//   id → 1-based row number. A row whose id is not present is INSERTED (appended);
//   a row whose id is present REPLACES that row in place (all columns overwritten).
//   created_at is preserved and updated_at / sync_status advanced only when those
//   columns exist in the spec.
// Response: { ok, file_type, created, updated, failed, results:[{ key, ok, action, error? }] }
//           ok === true iff failed === 0. action is 'created' | 'updated'.
// =============================================================================

function importAccountData(body) {
  const fileType = (body.file_type !== undefined && body.file_type !== null) ? String(body.file_type).trim() : '';
  if (fileType === '') return { ok: false, error: 'missing_file_type' };

  const spec = getImportSpec(fileType);
  if (spec === null) return { ok: false, error: 'unknown_file_type' };

  const rows = body.rows;
  if (Array.isArray(rows) === false || rows.length === 0) return { ok: false, error: 'missing_rows' };

  // accounts_master delegates to the id-based bulk-account upsert, which already
  // handles id assignment, liability negation, created_at preservation, and the
  // { ok, created, updated, failed, results } shape. Attach file_type to match the
  // detail-path response contract.
  if (fileType === 'accounts_master') {
    console.log('importAccountData: file_type=accounts_master rows=' + rows.length + ' delegated=create_accounts_bulk');
    const bulkResult = createAccountsBulk({ accounts: rows });
    return Object.assign({ file_type: fileType }, bulkResult);
  }

  // Build the account map once: id → sub_type. This backs both the FK existence
  // check (unknown_account) and the sub_type applicability check (sub_type_mismatch).
  const accountSheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const accounts     = sheetToObjects(accountSheet);
  const accountSubTypeById = {};
  accounts.forEach(function(account) {
    accountSubTypeById[String(account.id).trim()] = String(account.sub_type).trim();
  });

  const sheet = getOrCreateSheet(spec.sheet_name, spec.columns);

  // One sheet read → map id → 1-based sheet row number. Detail rows are keyed on the
  // 'id' column (registry key_field is 'id' and required for every detail file_type).
  const idColIdx  = spec.columns.indexOf('id');
  const values    = sheet.getDataRange().getValues();
  const rowNumById = {};
  if (idColIdx !== -1) {
    for (let i = 1; i < values.length; i++) {
      const existingId = String(values[i][idColIdx]).trim();
      if (existingId !== '') rowNumById[existingId] = i + 1;
    }
  }

  const results = [];
  let created = 0;
  let updated = 0;
  let failed  = 0;

  rows.forEach(function(row) {
    const outcome = _importRow(sheet, spec, row, accountSubTypeById, rowNumById, values);
    results.push(outcome);
    if (outcome.ok === false) { failed += 1; return; }
    if (outcome.action === 'updated') updated += 1;
    else created += 1;
  });

  console.log('importAccountData: file_type=' + fileType + ' rows=' + rows.length
    + ' created=' + created + ' updated=' + updated + ' failed=' + failed);

  return { ok: failed === 0, file_type: fileType, created: created, updated: updated, failed: failed, results: results };
}

// Validates a single row against the spec, then INSERTs or REPLACEs it by id.
// Returns { key, ok:true, action:'created'|'updated' } or { key, ok:false, error }.
function _importRow(sheet, spec, row, accountSubTypeById, rowNumById, values) {
  const key = (row[spec.key_field] !== undefined && row[spec.key_field] !== null)
    ? row[spec.key_field]
    : '';

  // 1. Required fields — must be present and non-empty (trimmed).
  for (let i = 0; i < spec.required.length; i++) {
    const field = spec.required[i];
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      return { key: key, ok: false, error: 'missing_' + field };
    }
  }

  // 2. FK existence — account_id must exist in the accounts sheet.
  const accountId = String(row.account_id).trim();
  const subType   = accountSubTypeById[accountId];
  if (subType === undefined) {
    return { key: key, ok: false, error: 'unknown_account' };
  }

  // 3. Sub_type applicability — the account's sub_type must be allowed for this file_type.
  if (spec.account_sub_types.indexOf(subType) === -1) {
    return { key: key, ok: false, error: 'sub_type_mismatch' };
  }

  // 4. Enum values — validated only when the cell is present and non-empty.
  const enumFields = Object.keys(spec.enums);
  for (let i = 0; i < enumFields.length; i++) {
    const field = enumFields[i];
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (spec.enums[field].indexOf(String(value).trim()) === -1) {
      return { key: key, ok: false, error: 'invalid_' + field };
    }
  }

  // 5. Mortgage cross-entity rule — a non-empty linked_property_account_id must
  //    reference an existing account with sub_type 'property'.
  const linkedPropertyId = row.linked_property_account_id;
  if (linkedPropertyId !== undefined && linkedPropertyId !== null && String(linkedPropertyId).trim() !== '') {
    const linkedSubType = accountSubTypeById[String(linkedPropertyId).trim()];
    if (linkedSubType !== 'property') {
      return { key: key, ok: false, error: 'invalid_linked_property' };
    }
  }

  const rowId = String(row.id).trim();
  const existingRowNum = rowNumById[rowId];
  const isReplace = existingRowNum !== undefined;

  // Build a row array ordered by spec.columns. A key that is absent from the row
  // object writes '' because the column has NO value in this import, not as a
  // fallback for a value the caller actually provided.
  const rowArray = spec.columns.map(function(column) {
    const value = row[column];
    if (value === undefined) return '';       // column absent from this import row
    if (value === null) return '';            // explicit null → empty cell
    return value;
  });

  // Audit columns are only touched when the spec declares them. Detail specs differ:
  // some carry no audit block at all (e.g. account_deposit).
  const now             = new Date().toISOString();
  const createdAtIdx    = spec.columns.indexOf('created_at');
  const updatedAtIdx    = spec.columns.indexOf('updated_at');
  const syncStatusIdx   = spec.columns.indexOf('sync_status');

  if (updatedAtIdx !== -1) rowArray[updatedAtIdx] = now;

  if (isReplace) {
    const existingRow = values[existingRowNum - 1];
    if (createdAtIdx !== -1)  rowArray[createdAtIdx]  = existingRow[createdAtIdx];
    if (syncStatusIdx !== -1) rowArray[syncStatusIdx] = computeSyncStatus(String(existingRow[syncStatusIdx]));
    sheet.getRange(existingRowNum, 1, 1, spec.columns.length).setValues([rowArray]);
    return { key: key, ok: true, action: 'updated' };
  }

  if (createdAtIdx !== -1)  rowArray[createdAtIdx]  = now;
  if (syncStatusIdx !== -1) rowArray[syncStatusIdx] = SYNC_STATUS_CREATE_PENDING;
  sheet.appendRow(rowArray);
  // Record the new row so a repeated id later in this batch replaces it.
  rowNumById[rowId] = sheet.getLastRow();
  values[rowNumById[rowId] - 1] = rowArray; // keep aligned for created_at preservation
  return { key: key, ok: true, action: 'created' };
}
