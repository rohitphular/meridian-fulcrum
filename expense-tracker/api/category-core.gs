// =============================================================================
// FULCRUM FORGE — Category Core: CRUD + seed + onEdit sheet cascade
// =============================================================================

// CAT-NEW-M-7: lookup map so tx_type_label derivation has no implicit fallback.
// The validator always rejects unknown tx_type_key values before we reach this map.
var TX_TYPE_LABEL_MAP = { 'money-in': 'Money In', 'money-out': 'Money Out' };

// CAT-R14-M-1: helper for optional string fields — avoids ternary-as-fallback patterns.
function strField(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function listCategories() {
  const cols  = getCategorySheetColumns();
  const sheet = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const rows  = sheetToObjectsWithRow(sheet);
  // Coerce boolean fields (sheet may store TRUE/FALSE as boolean or string)
  return rows.map(function(r) {
    r.source_account_mandatory = toBool(r.source_account_mandatory);
    r.target_account_mandatory = toBool(r.target_account_mandatory);
    r.is_subscription_eligible = toBool(r.is_subscription_eligible);
    return r;
  });
}


function createCategory(body) {
  const validation = validateCategoryCreate(body);
  if (!validation.ok) return validation;

  const cols  = getCategorySheetColumns();
  const sheet = getOrCreateSheet(CATEGORIES_SHEET, cols);

  // CAT-NEW-6: compute slugs once and reuse in both the duplicate-check loop and the setCol calls.
  const majKey = slugify(String(body.major_category_label).trim());
  const minKey = slugify(String(body.minor_category_label).trim());
  // CAT-NEW-H-2: defence-in-depth — validation should have caught an empty slug, but guard
  // here too to prevent sheet corruption if createCategory is called directly.
  if (majKey === '' || minKey === '') return { ok: false, error: 'invalid_category_label' };

  // Duplicate guard — reject if (tx_type_key, major_category_key, minor_category_key) already exists
  const ciType  = catColIndex('tx_type_key');
  const ciMajor = catColIndex('major_category_key');
  const ciMinor = catColIndex('minor_category_key');
  const existingRows = sheet.getDataRange().getValues();
  for (let i = 1; i < existingRows.length; i++) {
    if (
      String(existingRows[i][ciType])  === String(body.tx_type_key).trim() &&
      String(existingRows[i][ciMajor]) === majKey &&
      String(existingRows[i][ciMinor]) === minKey
    ) {
      return { ok: false, error: 'duplicate_category' };
    }
  }

  const row = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getCategorySchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('tx_type_key',              String(body.tx_type_key).trim());
  setCol('tx_type_label',            TX_TYPE_LABEL_MAP[String(body.tx_type_key).trim()]);
  setCol('major_category_label',     String(body.major_category_label).trim());
  setCol('major_category_key',       majKey);
  setCol('minor_category_label',     String(body.minor_category_label).trim());
  setCol('minor_category_key',       minKey);
  setCol('description',              strField(body.description));
  setCol('record_status',            'active');
  setCol('tag_keywords',             normaliseKeywords(strField(body.tag_keywords)));
  setCol('counterparty_examples',    normaliseCandidates(strField(body.counterparty_examples)));
  setCol('source_account_types',     normaliseAccountTypes(strField(body.source_account_types)));
  setCol('target_account_types',     normaliseAccountTypes(strField(body.target_account_types)));
  setCol('source_account_mandatory', body.source_account_mandatory === true || body.source_account_mandatory === 'true');
  setCol('target_account_mandatory', body.target_account_mandatory === true || body.target_account_mandatory === 'true');
  setCol('is_subscription_eligible', body.is_subscription_eligible === true || body.is_subscription_eligible === 'true');
  setCol('sync_status',    SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date', '');
  setCol('sync_notes',     '');
  const now = new Date().toISOString();
  setCol('created_at', now);
  setCol('updated_at', now);
  const id = (body.id !== undefined && body.id !== null && String(body.id).trim() !== '')
    ? String(body.id).trim()
    : Utilities.getUuid();
  setCol('id', id);

  sheet.appendRow(row);
  return { ok: true, id: id };
}

function updateCategory(body) {
  const validation = validateCategoryUpdate(body);
  if (!validation.ok) return validation;

  const cols    = getCategorySheetColumns();
  const sheet   = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  // CAT-NEW-L-3: guard against NaN row_num — NaN < 2 is false, so the bounds check silently passes without this.
  if (!Number.isFinite(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const ciType  = catColIndex('tx_type_key');
  const ciMajor = catColIndex('major_category_key');
  const ciMinor = catColIndex('minor_category_key');
  const allRows = sheet.getDataRange().getValues();

  // CAT-NEW-H-4: locked-row guard fires immediately after bounds check, before the
  // duplicate scan and FK scan — avoids wasted sheet reads on locked rows.
  const ciRstat = catColIndex('record_status');
  if (String(allRows[rowNum - 1][ciRstat]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const newTxTypeKey   = String(body.tx_type_key).trim();
  const newMajorKey    = slugify(String(body.major_category_label).trim());
  const newMinorKey    = slugify(String(body.minor_category_label).trim());
  // CAT-NEW-H-2: defence-in-depth — validation should have caught an empty slug, but guard
  // here too to prevent sheet corruption if updateCategory is called directly.
  if (newMajorKey === '' || newMinorKey === '') return { ok: false, error: 'invalid_category_label' };

  // Duplicate guard — reject if (tx_type_key, major_category_key, minor_category_key) already exists on a different row
  for (let i = 1; i < allRows.length; i++) {
    if (i + 1 === rowNum) continue;
    if (
      String(allRows[i][ciType])  === newTxTypeKey &&
      String(allRows[i][ciMajor]) === newMajorKey &&
      String(allRows[i][ciMinor]) === newMinorKey
    ) {
      return { ok: false, error: 'duplicate_category' };
    }
  }

  // C-C1: FK check — if any composite key field is changing, verify no transactions or
  // subscriptions reference the old (tx_type_key, major_category_key, minor_category_key).
  const oldTxTypeKey   = String(allRows[rowNum - 1][ciType]);
  const oldMajorKey    = String(allRows[rowNum - 1][ciMajor]);
  const oldMinorKey    = String(allRows[rowNum - 1][ciMinor]);
  const keyChanging = oldTxTypeKey !== newTxTypeKey || oldMajorKey !== newMajorKey || oldMinorKey !== newMinorKey;

  if (keyChanging && body.force !== true) {
    try {
      const txSheet  = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
      const txValues = txSheet.getDataRange().getValues();
      const txCiType  = txColIndex('tx_type');
      const txCiMajor = txColIndex('major_category');
      const txCiMinor = txColIndex('minor_category');
      let count = 0;
      for (let r = 1; r < txValues.length; r++) {
        if (
          String(txValues[r][txCiType])  === oldTxTypeKey &&
          String(txValues[r][txCiMajor]) === oldMajorKey &&
          String(txValues[r][txCiMinor]) === oldMinorKey
        ) count++;
      }
      const subSheet  = getOrCreateSheet(SUBSCRIPTIONS_SHEET, getSubscriptionSheetColumns());
      const subValues = subSheet.getDataRange().getValues();
      const subCiType  = subColIndex('tx_type');
      const subCiMajor = subColIndex('major_category');
      const subCiMinor = subColIndex('minor_category');
      for (let r = 1; r < subValues.length; r++) {
        if (
          String(subValues[r][subCiType])  === oldTxTypeKey &&
          String(subValues[r][subCiMajor]) === oldMajorKey &&
          String(subValues[r][subCiMinor]) === oldMinorKey
        ) count++;
      }
      if (count > 0)
        return { ok: false, error: 'category_key_change_has_dependents', count: count };
    } catch (e) {
      console.error('[category-core] FK scan error:', e.message);
      return { ok: false, error: 'fk_scan_error' };
    }
  }

  // CAT-M-1: build an updated copy of the current row and write back in a single setValues call.
  const totalCols   = cols.length;
  const updatedRow  = allRows[rowNum - 1].slice();

  // Helper to update a field by schema key only if it is editable.
  function setUpdatedField(key, value) {
    const field = getCategorySchemaField(key);
    if (!field || !field.editable) return;
    updatedRow[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setUpdatedField('tx_type_key',              newTxTypeKey);
  // tx_type_label is derived — not editable per schema; write directly by index
  updatedRow[getCategorySchemaField('tx_type_label').sheet_column_position - 1] = TX_TYPE_LABEL_MAP[newTxTypeKey];
  setUpdatedField('major_category_label',     String(body.major_category_label).trim());
  // major_category_key is derived — write directly by index
  updatedRow[getCategorySchemaField('major_category_key').sheet_column_position - 1] = newMajorKey;
  setUpdatedField('minor_category_label',     String(body.minor_category_label).trim());
  // minor_category_key is derived — write directly by index
  updatedRow[getCategorySchemaField('minor_category_key').sheet_column_position - 1] = newMinorKey;
  setUpdatedField('description',              strField(body.description));
  if (body.record_status !== undefined && body.record_status !== null) {
    setUpdatedField('record_status', body.record_status);
  }
  setUpdatedField('tag_keywords',             normaliseKeywords(strField(body.tag_keywords)));
  setUpdatedField('counterparty_examples',    normaliseCandidates(strField(body.counterparty_examples)));
  setUpdatedField('source_account_types',     normaliseAccountTypes(strField(body.source_account_types)));
  setUpdatedField('target_account_types',     normaliseAccountTypes(strField(body.target_account_types)));
  setUpdatedField('source_account_mandatory', body.source_account_mandatory === true || body.source_account_mandatory === 'true');
  setUpdatedField('target_account_mandatory', body.target_account_mandatory === true || body.target_account_mandatory === 'true');
  setUpdatedField('is_subscription_eligible', body.is_subscription_eligible === true || body.is_subscription_eligible === 'true');
  // sync_status: preserve create-pending if not yet synced; clear sync_notes either way
  const syncStatusIdx = getCategorySchemaField('sync_status').sheet_column_position - 1;
  const syncNotesIdx  = getCategorySchemaField('sync_notes').sheet_column_position - 1;
  const updatedAtIdx  = getCategorySchemaField('updated_at').sheet_column_position - 1;
  const currentSyncStatus = String(allRows[rowNum - 1][syncStatusIdx]);
  // computeSyncStatus is defined in app-utils.gs (shared GAS global scope)
  updatedRow[syncStatusIdx] = computeSyncStatus(currentSyncStatus);
  updatedRow[syncNotesIdx]  = '';
  updatedRow[updatedAtIdx]  = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, totalCols).setValues([updatedRow]);

  return { ok: true };
}

function deleteCategory(body) {
  if (body.row_num === undefined || body.row_num === null) return { ok: false, error: 'missing_row_num' };
  const cols    = getCategorySheetColumns();
  const sheet   = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  // CAT-NEW-L-3: guard against NaN row_num — NaN < 2 is false, so the bounds check silently passes without this.
  if (!Number.isFinite(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // CAT-M-2 + CAT-NEW-7: read the full data once; update the target row in-memory; write back in a single setValues call.
  const allRows  = sheet.getDataRange().getValues();
  const targetRow = allRows[rowNum - 1].slice();

  const statusColIdx     = getCategorySchemaField('record_status').sheet_column_position - 1;
  const syncStatusColIdx = getCategorySchemaField('sync_status').sheet_column_position - 1;
  const syncNotesColIdx  = getCategorySchemaField('sync_notes').sheet_column_position - 1;
  const updatedAtColIdx  = getCategorySchemaField('updated_at').sheet_column_position - 1;

  if (String(targetRow[statusColIdx]) === 'locked')
    return { ok: false, error: 'record_locked' };

  const currentSyncStatus = String(targetRow[syncStatusColIdx]);
  targetRow[statusColIdx]     = 'deleted';
  targetRow[syncStatusColIdx] = computeSyncStatus(currentSyncStatus);
  targetRow[syncNotesColIdx]  = '';
  targetRow[updatedAtColIdx]  = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, cols.length).setValues([targetRow]);

  return { ok: true };
}

function createCategoriesBulk(body) {
  if (!Array.isArray(body.categories) || body.categories.length === 0)
    return { ok: false, error: 'missing_categories' };

  const cols   = getCategorySheetColumns();
  const sheet  = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const values = sheet.getDataRange().getValues();

  const ciType  = catColIndex('tx_type_key');
  const ciMajor = catColIndex('major_category_key');
  const ciMinor = catColIndex('minor_category_key');

  // Map key → sheet row number (1-indexed) so we can update existing rows
  const existing = {};
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][ciType]) + '|' + String(values[i][ciMajor]) + '|' + String(values[i][ciMinor]);
    existing[key] = i + 1;
  }

  const results = [];
  body.categories.forEach(function(cat) {
    // CAT-NEW-C-1: always run through slugify — even when caller supplies an explicit key —
    // so the lookup into existing[] (which was built from actual sheet slugs) always matches.
    const majKey = (cat.major_category_key !== undefined && cat.major_category_key !== null && String(cat.major_category_key).trim() !== '')
      ? slugify(String(cat.major_category_key).trim())
      : slugify(strField(cat.major_category_label));
    const minKey = (cat.minor_category_key !== undefined && cat.minor_category_key !== null && String(cat.minor_category_key).trim() !== '')
      ? slugify(String(cat.minor_category_key).trim())
      : slugify(strField(cat.minor_category_label));
    const key = strField(cat.tx_type_key) + '|' + majKey + '|' + minKey;

    const catBody = {};
    Object.keys(cat).forEach(function(k) { catBody[k] = cat[k]; });
    catBody.pin = body.pin;

    if (existing[key] !== undefined) {
      if (typeof existing[key] === 'number') {
        // Category exists in sheet — update in-place so the CSV can override the seed
        catBody.row_num = existing[key];
        let r = updateCategory(catBody);
        // CAT-NEW-1: if a key-changing rename was blocked by dependents, retry with force:true
        if (!r.ok && r.error === 'category_key_change_has_dependents') {
          catBody.force = true;
          r = updateCategory(catBody);
        }
        const updateEntry = { name: key, ok: r.ok, updated: true };
        if (r.error !== undefined) updateEntry.error = r.error;
        results.push(updateEntry);
        if (r.ok) existing[key] = true; // prevent second update of same row in this batch
      } else {
        // existing[key] === true: row was just created earlier in this batch — block as duplicate
        results.push({ name: key, ok: false, updated: false, error: 'duplicate_category' });
      }
    } else {
      const r = createCategory(catBody);
      const createEntry = { name: key, ok: r.ok, updated: false };
      if (r.error !== undefined) createEntry.error = r.error;
      results.push(createEntry);
      if (r.ok) existing[key] = true; // block within-batch duplicates
    }
  });

  const failed  = results.filter(function(r) { return !r.ok; });
  const updated = results.filter(function(r) { return r.ok && r.updated; });
  const created = results.filter(function(r) { return r.ok && !r.updated; });
  return {
    ok:      failed.length === 0,
    created: created.length,
    updated: updated.length,
    failed:  failed.length,
    results: results,
  };
}

// onEdit cascade — rebuilds category dropdowns in the transactions sheet when
// the user edits transaction_type or major_category directly in the sheet.
function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== TRANSACTIONS_SHEET) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row <= 1) return;

  // Derive column positions from transaction schema — never hardcode column numbers.
  const TYPE_COL  = TRANSACTION_SCHEMA['tx_type'].sheet_column_position;
  const MAJOR_COL = TRANSACTION_SCHEMA['major_category'].sheet_column_position;
  const MINOR_COL = TRANSACTION_SCHEMA['minor_category'].sheet_column_position;

  // onEdit trigger — using getSheetByName intentionally; getOrCreateSheet is inappropriate for trigger context
  const catSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CATEGORIES_SHEET);
  if (!catSheet) return;
  const catData = catSheet.getDataRange().getValues().slice(1);

  // Column indices into catData (0-based) — use catColIndex to avoid hardcoding.
  // NOTE: dropdowns show keys (major_category_key / minor_category_key) so that the stored
  // value in the transactions sheet matches what _buildCategoryMap keys on.
  // Labels are shown via Sheets column-header context; storing keys keeps API and sheet-edit
  // paths consistent.
  const CI_TYPE   = catColIndex('tx_type_key');
  const CI_MAJ    = catColIndex('major_category_key');
  const CI_MIN    = catColIndex('minor_category_key');
  const CI_RSTAT  = catColIndex('record_status');

  if (col === TYPE_COL) {
    const txType = sheet.getRange(row, TYPE_COL).getValue();
    const majors = [];
    const seen   = {};
    catData.filter(function(r) { return r[CI_TYPE] === txType && r[CI_RSTAT] === 'active'; }).forEach(function(r) {
      if (!seen[r[CI_MAJ]]) { majors.push(r[CI_MAJ]); seen[r[CI_MAJ]] = true; }
    });

    sheet.getRange(row, MAJOR_COL).clearContent();
    sheet.getRange(row, MINOR_COL).clearContent();

    if (majors.length > 0) {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(majors, true).setAllowInvalid(false).build();
      sheet.getRange(row, MAJOR_COL).setDataValidation(rule);
    }
    sheet.getRange(row, MINOR_COL).clearDataValidations();
  }

  if (col === MAJOR_COL) {
    const txType2 = sheet.getRange(row, TYPE_COL).getValue();
    const major   = sheet.getRange(row, MAJOR_COL).getValue();
    const minors  = catData
      .filter(function(r) { return r[CI_TYPE] === txType2 && r[CI_MAJ] === major && r[CI_RSTAT] === 'active'; })
      .map(function(r) { return r[CI_MIN]; });

    sheet.getRange(row, MINOR_COL).clearContent();

    if (minors.length > 0) {
      const rule2 = SpreadsheetApp.newDataValidation()
        .requireValueInList(minors, true).setAllowInvalid(false).build();
      sheet.getRange(row, MINOR_COL).setDataValidation(rule2);
    }
  }
}
