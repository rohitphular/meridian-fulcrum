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
  const suppliedId = strField(body.id).toLowerCase();
  if (suppliedId !== '' && existingRows.slice(1).some(function(existing) {
    return strField(existing[catColIndex('id')]).toLowerCase() === suppliedId;
  })) return { ok: false, error: 'category_id_exists' };
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
  setCol('source_account_mandatory', toBool(strField(body.source_account_mandatory)));
  setCol('target_account_mandatory', toBool(strField(body.target_account_mandatory)));
  setCol('is_subscription_eligible', toBool(strField(body.is_subscription_eligible)));
  setCol('sync_status',    SYNC_STATUS_CREATE_PENDING);
  setCol('sync_date', '');
  setCol('sync_notes',     '');
  const now = new Date().toISOString();
  setCol('created_at', now);
  setCol('updated_at', now);
  const id = (body.id !== undefined && body.id !== null && String(body.id).trim() !== '')
    ? String(body.id).trim().toLowerCase()
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
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const ciType  = catColIndex('tx_type_key');
  const ciMajor = catColIndex('major_category_key');
  const ciMinor = catColIndex('minor_category_key');
  const allRows = sheet.getDataRange().getValues();
  if (matchesExpectedRecord(body, allRows[rowNum - 1][catColIndex('id')], allRows[rowNum - 1][catColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };

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

  if (keyChanging) {
    try {
      const count = _countCategoryKeyReferences(allRows[rowNum - 1]);
      if (count > 0)
        return { ok: false, error: 'category_key_change_has_dependents', count: count };
    } catch (e) {
      console.error('updateCategory: error=fk_scan_error');
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
  setUpdatedField('source_account_mandatory', toBool(strField(body.source_account_mandatory)));
  setUpdatedField('target_account_mandatory', toBool(strField(body.target_account_mandatory)));
  setUpdatedField('is_subscription_eligible', toBool(strField(body.is_subscription_eligible)));
  // sync_status: preserve create-pending if not yet synced; clear sync_notes either way
  const syncStatusIdx = getCategorySchemaField('sync_status').sheet_column_position - 1;
  const syncNotesIdx  = getCategorySchemaField('sync_notes').sheet_column_position - 1;
  const updatedAtIdx  = getCategorySchemaField('updated_at').sheet_column_position - 1;
  const currentSyncStatus = String(allRows[rowNum - 1][syncStatusIdx]);
  // computeSyncStatus is defined in app-utils.gs (shared GAS global scope)
  updatedRow[syncStatusIdx] = computeSyncStatus(currentSyncStatus);
  updatedRow[catColIndex('sync_date')] = '';
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
  if (!Number.isInteger(rowNum) || rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // CAT-M-2 + CAT-NEW-7: read the full data once; update the target row in-memory; write back in a single setValues call.
  const allRows  = sheet.getDataRange().getValues();
  const targetRow = allRows[rowNum - 1].slice();
  if (matchesExpectedRecord(body, targetRow[catColIndex('id')], targetRow[catColIndex('updated_at')]) === false) return { ok: false, error: 'stale_record' };

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
  targetRow[catColIndex('sync_date')] = '';
  targetRow[updatedAtColIdx]  = new Date().toISOString();

  sheet.getRange(rowNum, 1, 1, cols.length).setValues([targetRow]);

  return { ok: true };
}

// CSV import is an ID-based upsert. Preflight all rows before starting writes;
// individual validation failures remain in results while valid rows can import.
function createCategoriesBulk(body) {
  if (!Array.isArray(body.categories) || body.categories.length === 0)
    return { ok: false, error: 'missing_categories' };
  const incoming = body.categories;
  const usesHints = incoming.some(function(cat) {
    return cat !== null && typeof cat === 'object' &&
      (splitToList(cat.source_account_types).length > 0 || splitToList(cat.target_account_types).length > 0);
  });
  const context = usesHints ? _categoryHintContext() : { ok: true, valid: new Set() };
  if (!context.ok) return Object.assign({ created: 0, updated: 0, skipped: 0, failed: 0, results: [] }, context);

  const cols = getCategorySheetColumns();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet;
  let values;
  try {
    _assertMasterSheetNameReady(spreadsheet, CATEGORIES_SHEET);
    sheet = spreadsheet.getSheets().find(function(candidate) { return candidate.getName() === CATEGORIES_SHEET; });
    values = sheet === undefined || sheet.getLastRow() === 0 ? [cols] : sheet.getDataRange().getValues();
    if (values[0].length !== cols.length || values[0].some(function(column, index) { return column !== cols[index]; }))
      return { ok: false, error: 'sheet_header_mismatch', field: 'category_master' };
  } catch (error) {
    const allowed = ['legacy_master_sheet_name', 'master_sheet_name_collision'];
    return { ok: false, error: allowed.includes(error.message) ? error.message : 'category_sheet_unavailable', field: 'category_master' };
  }
  const rowNumById = new Map();
  const keyOwner = new Map();
  function naturalKey(row) {
    return ['tx_type_key', 'major_category_key', 'minor_category_key'].map(function(field) { return strField(row[catColIndex(field)]); }).join('|');
  }
  for (let index = 1; index < values.length; index++) {
    if (values[index].every(function(value) { return strField(value) === ''; })) continue;
    const id = strField(values[index][catColIndex('id')]).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || rowNumById.has(id))
      return { ok: false, error: 'invalid_existing_category_id', field: 'id', row_num: index + 1 };
    rowNumById.set(id, index + 1);
    const key = naturalKey(values[index]);
    if (keyOwner.has(key)) return { ok: false, error: 'duplicate_existing_category_key', field: 'category_key', row_num: index + 1 };
    keyOwner.set(key, id);
  }
  const inputIds = new Map();
  incoming.forEach(function(cat) {
    if (cat === null || typeof cat !== 'object') return;
    const id = strField(cat.id).toLowerCase();
    if (id !== '') inputIds.set(id, (inputIds.get(id) === undefined ? 0 : inputIds.get(id)) + 1);
  });
  const results = new Array(incoming.length);
  const plans = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const generatedIds = new Set();
  incoming.forEach(function(cat, index) {
    const fail = function(error) { results[index] = _categoryImportResult(cat, index, error); };
    const validation = validateCategoryImport(cat, context);
    if (!validation.ok) { fail(validation); return; }
    const suppliedId = strField(cat.id).toLowerCase();
    if (suppliedId !== '' && inputIds.get(suppliedId) > 1) {
      fail({ ok: false, error: 'duplicate_id_in_import', field: 'id', invalid_values: [suppliedId] }); return;
    }
    const id = suppliedId === '' ? Utilities.getUuid().toLowerCase() : suppliedId;
    if (suppliedId === '' && (rowNumById.has(id) || inputIds.has(id) || generatedIds.has(id))) {
      fail({ ok: false, error: 'duplicate_generated_category_id', field: 'id' }); return;
    }
    generatedIds.add(id);
    const rowNum = rowNumById.get(id);
    const previous = rowNum === undefined ? null : values[rowNum - 1];
    const row = new Array(cols.length).fill('');
    function setCol(key, value) { row[catColIndex(key)] = value; }
    setCol('id', id);
    setCol('tx_type_key', strField(cat.tx_type_key));
    setCol('tx_type_label', TX_TYPE_LABEL_MAP[strField(cat.tx_type_key)]);
    for (const field of ['major_category_label', 'minor_category_label', 'description']) setCol(field, strField(cat[field]));
    setCol('major_category_key', slugify(strField(cat.major_category_label)));
    setCol('minor_category_key', slugify(strField(cat.minor_category_label)));
    setCol('tag_keywords', normaliseKeywords(strField(cat.tag_keywords)));
    setCol('counterparty_examples', normaliseCandidates(strField(cat.counterparty_examples)));
    for (const field of ['source_account_types', 'target_account_types']) setCol(field, normaliseAccountTypes(strField(cat[field]), context));
    for (const field of ['source_account_mandatory', 'target_account_mandatory', 'is_subscription_eligible'])
      setCol(field, toBool(strField(cat[field])));
    const key = naturalKey(row);
    if (keyOwner.has(key) && keyOwner.get(key) !== id) {
      fail({ ok: false, error: 'duplicate_category', field: 'category_key' }); return;
    }
    const suppliedStatus = strField(cat.record_status);
    setCol('record_status', suppliedStatus === '' ? (previous === null ? 'active' : previous[catColIndex('record_status')]) : suppliedStatus);
    if (previous !== null && strField(previous[catColIndex('record_status')]) === 'locked') {
      const same = cols.slice(0, catColIndex('sync_status')).every(function(field) {
        if (field === 'id') return strField(previous[catColIndex(field)]).toLowerCase() === id;
        if (CATEGORY_SCHEMA[field].type === 'boolean') return toBool(previous[catColIndex(field)]) === row[catColIndex(field)];
        return strField(previous[catColIndex(field)]) === row[catColIndex(field)];
      });
      if (!same) { fail({ ok: false, error: 'record_locked', field: 'record_status' }); return; }
      results[index] = _categoryImportResult(cat, index, { ok: true, key: id, action: 'unchanged' });
      skipped++; return;
    }
    if (previous !== null && ['tx_type_key', 'major_category_key', 'minor_category_key'].some(function(field) { return previous[catColIndex(field)] !== row[catColIndex(field)]; })) {
      try {
        const count = _countCategoryKeyReferences(previous);
        if (count > 0) { fail({ ok: false, error: 'category_key_change_has_dependents', field: 'category_key', count: count }); return; }
      } catch (_) { fail({ ok: false, error: 'fk_scan_error', field: 'category_key' }); return; }
    }
    const now = new Date().toISOString();
    setCol('created_at', previous === null ? now : previous[catColIndex('created_at')]);
    setCol('updated_at', now);
    setCol('sync_status', previous === null ? SYNC_STATUS_CREATE_PENDING : computeSyncStatus(strField(previous[catColIndex('sync_status')])));
    setCol('sync_date', '');
    setCol('sync_notes', '');
    plans.push({ index: index, cat: cat, row: row, row_num: rowNum, id: id });
    keyOwner.set(key, id);
  });
  for (const plan of plans) {
    try {
      if (sheet === undefined || sheet.getLastRow() === 0) sheet = getOrCreateSheet(CATEGORIES_SHEET, cols);
      if (plan.row_num === undefined) {
        sheet.appendRow(plan.row); created++;
      } else {
        if (plan.row_num < 2 || plan.row_num > sheet.getLastRow() ||
            strField(sheet.getRange(plan.row_num, catColIndex('id') + 1).getValues()[0][0]).toLowerCase() !== plan.id) {
          results[plan.index] = _categoryImportResult(plan.cat, plan.index, { ok: false, error: 'stale_row', field: 'id' }); continue;
        }
        sheet.getRange(plan.row_num, 1, 1, cols.length).setValues([plan.row]); updated++;
      }
      results[plan.index] = _categoryImportResult(plan.cat, plan.index, { ok: true, key: plan.id, action: plan.row_num === undefined ? 'created' : 'updated' });
    } catch (_) {
      console.error('createCategoriesBulk: index=' + plan.index + ' error=category_write_failed');
      results[plan.index] = _categoryImportResult(plan.cat, plan.index, { ok: false, error: 'category_write_failed', field: 'row' });
    }
  }
  const failed = results.filter(function(result) { return !result.ok; }).length;
  console.log('createCategoriesBulk: input=' + incoming.length + ' created=' + created + ' updated=' + updated + ' skipped=' + skipped + ' failed=' + failed);
  return { ok: failed === 0, created: created, updated: updated, skipped: skipped, failed: failed, results: results };
}

// onEdit cascade — rebuilds category dropdowns in transaction_master when
// the user edits transaction_type or major_category directly in the sheet.
function onEdit(e) {
  // Any direct Sheet edit invalidates cached views (view-cache.gs). Isolated so a
  // Properties failure never blocks the edit cascade below.
  try {
    if (typeof vcOnSheetEdit === 'function') vcOnSheetEdit();
  } catch (_) {
    console.error('onEdit: error=data_version_bump_failed');
  }
  if (markCategoryEditPending(e)) return;
  if (markAccountTypeEditPending(e)) return;
  if (markAccountDetailEditPending(e)) return;
  if (markAccountMasterEditPending(e)) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== TRANSACTIONS_SHEET) {
    markSubscriptionEditPending(e);
    return;
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  _assertMasterSheetNameReady(spreadsheet, TRANSACTIONS_SHEET);
  _assertMasterSheetNameReady(spreadsheet, CATEGORIES_SHEET);
  markTransactionEditPending(e);

  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row <= 1) return;
  // A pasted block already contains its chosen categories. Queue all its rows,
  // but do not clear pasted category values with the single-cell dropdown flow.
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

  // Derive column positions from transaction schema — never hardcode column numbers.
  const TYPE_COL  = TRANSACTION_SCHEMA['tx_type'].sheet_column_position;
  const MAJOR_COL = TRANSACTION_SCHEMA['major_category'].sheet_column_position;
  const MINOR_COL = TRANSACTION_SCHEMA['minor_category'].sheet_column_position;

  // Read an existing category tab only; refuse stale or conflicting master names.
  const catSheet = spreadsheet.getSheets().find(function(candidate) { return candidate.getName() === CATEGORIES_SHEET; });
  if (catSheet === undefined) return;
  const catData = catSheet.getDataRange().getValues().slice(1);

  // Column indices into catData (0-based) — use catColIndex to avoid hardcoding.
  // NOTE: dropdowns show keys (major_category_key / minor_category_key) so that the stored
  // value in transaction_master matches what _buildCategoryMap keys on.
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

// Category edits must participate in normal sync and optimistic concurrency,
// just like every other master. Only metadata cells are rewritten by the trigger.
function markCategoryEditPending(event) {
  const sheet = event.range.getSheet();
  if (sheet.getName() !== CATEGORIES_SHEET) return false;
  _assertMasterSheetNameReady(SpreadsheetApp.getActiveSpreadsheet(), CATEGORIES_SHEET);
  const firstColumn = event.range.getColumn(), lastColumn = firstColumn + event.range.getNumColumns() - 1;
  const businessEdit = Object.keys(CATEGORY_SCHEMA).some(function(key) {
    const position = CATEGORY_SCHEMA[key].sheet_column_position;
    return position < CATEGORY_SCHEMA.sync_status.sheet_column_position && position >= firstColumn && position <= lastColumn;
  });
  if (!businessEdit) return true;
  const firstRow = Math.max(2, event.range.getRow());
  const lastRow = Math.min(sheet.getLastRow(), event.range.getRow() + event.range.getNumRows() - 1);
  if (firstRow > lastRow) return true;
  const columns = getCategorySheetColumns();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.length !== columns.length || headers.some(function(header, index) { return header !== columns[index]; }))
    throw new Error('sheet_header_mismatch');
  const rows = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, columns.length).getValues();
  const now = new Date().toISOString();
  const sync = rows.map(function(row) {
    return strField(row[catColIndex('id')]) === ''
      ? row.slice(catColIndex('sync_status'), catColIndex('sync_status') + 3)
      : [computeSyncStatus(strField(row[catColIndex('sync_status')])), '', ''];
  });
  const updated = rows.map(function(row) { return [strField(row[catColIndex('id')]) === '' ? row[catColIndex('updated_at')] : now]; });
  sheet.getRange(firstRow, catColIndex('sync_status') + 1, rows.length, 3).setValues(sync);
  sheet.getRange(firstRow, catColIndex('updated_at') + 1, rows.length, 1).setValues(updated);
  return true;
}
