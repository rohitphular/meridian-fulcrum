// =============================================================================
// FULCRUM FORGE — Category Core: CRUD + seed + onEdit sheet cascade
// =============================================================================

function listCategories() {
  const cols  = getCategorySheetColumns();
  const sheet = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const rows  = sheetToObjectsWithRow(sheet);
  // Coerce boolean fields (sheet may store TRUE/FALSE as boolean or string)
  return rows.map(function(r) {
    const toBool = function(v) { return v === true || String(v).toLowerCase() === 'true'; };
    r.is_active                = toBool(r.is_active);
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

  // Duplicate guard — reject if (tx_type, major_category, minor_category) already exists
  const ciType  = catColIndex('tx_type');
  const ciMajor = catColIndex('major_category');
  const ciMinor = catColIndex('minor_category');
  const existingRows = sheet.getDataRange().getValues();
  for (let i = 1; i < existingRows.length; i++) {
    if (
      String(existingRows[i][ciType])  === String(body.tx_type || '').trim() &&
      String(existingRows[i][ciMajor]) === String(body.major_category   || '').trim() &&
      String(existingRows[i][ciMinor]) === String(body.minor_category   || '').trim()
    ) {
      return { ok: false, error: 'duplicate_category' };
    }
  }

  const row   = new Array(cols.length).fill('');

  function setCol(key, value) {
    const field = getCategorySchemaField(key);
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }

  setCol('tx_type',                 String(body.tx_type).trim());
  setCol('major_category',          String(body.major_category).trim());
  setCol('minor_category',          String(body.minor_category).trim());
  setCol('description',             String(body.description             || '').trim());
  setCol('is_active',               body.is_active !== false);
  setCol('tag_keywords',            normaliseKeywords(body.tag_keywords || ''));
  setCol('counterparty_examples',   normaliseCandidates(body.counterparty_examples   || ''));
  setCol('source_account_types',      normaliseAccountTypes(body.source_account_types      || ''));
  setCol('target_account_types', normaliseAccountTypes(body.target_account_types || ''));
  setCol('source_account_mandatory',  body.source_account_mandatory === true || body.source_account_mandatory === 'true');
  setCol('target_account_mandatory',  body.target_account_mandatory === true || body.target_account_mandatory === 'true');
  setCol('workflow_type',             String(body.workflow_type || '').trim());
  setCol('is_subscription_eligible', body.is_subscription_eligible === true || body.is_subscription_eligible === 'true');

  sheet.appendRow(row);
  // Categories have no auto-generated id — the composite (tx_type, major_category, minor_category) is the key.
  return { ok: true };
}

function updateCategory(body) {
  const validation = validateCategoryUpdate(body);
  if (!validation.ok) return validation;

  const cols    = getCategorySheetColumns();
  const sheet   = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  function writeField(key, value) {
    const field = getCategorySchemaField(key);
    if (!field || !field.editable) return;
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('tx_type',                 String(body.tx_type).trim());
  writeField('major_category',          String(body.major_category).trim());
  writeField('minor_category',          String(body.minor_category).trim());
  writeField('description',             String(body.description             || '').trim());
  writeField('is_active',               body.is_active !== false);
  writeField('tag_keywords',            normaliseKeywords(body.tag_keywords || ''));
  writeField('counterparty_examples',   normaliseCandidates(body.counterparty_examples   || ''));
  writeField('source_account_types',      normaliseAccountTypes(body.source_account_types      || ''));
  writeField('target_account_types', normaliseAccountTypes(body.target_account_types || ''));
  writeField('source_account_mandatory',  body.source_account_mandatory === true || body.source_account_mandatory === 'true');
  writeField('target_account_mandatory',  body.target_account_mandatory === true || body.target_account_mandatory === 'true');
  writeField('workflow_type',             String(body.workflow_type || '').trim());
  writeField('is_subscription_eligible', body.is_subscription_eligible === true || body.is_subscription_eligible === 'true');

  return { ok: true };
}

function deleteCategory(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const cols    = getCategorySheetColumns();
  const sheet   = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };
  sheet.deleteRow(rowNum);
  return { ok: true };
}

function createCategoriesBulk(body) {
  if (!Array.isArray(body.categories) || body.categories.length === 0)
    return { ok: false, error: 'missing_categories' };

  const cols   = getCategorySheetColumns();
  const sheet  = getOrCreateSheet(CATEGORIES_SHEET, cols);
  const values = sheet.getDataRange().getValues();

  const ciType  = catColIndex('tx_type');
  const ciMajor = catColIndex('major_category');
  const ciMinor = catColIndex('minor_category');

  // Map key → sheet row number (1-indexed) so we can update existing rows
  const existing = {};
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][ciType]) + '|' + String(values[i][ciMajor]) + '|' + String(values[i][ciMinor]);
    existing[key] = i + 1;
  }

  const results = [];
  body.categories.forEach(function(cat) {
    const key = String(cat.tx_type || '') + '|' + String(cat.major_category || '') + '|' + String(cat.minor_category || '');

    const catBody = {};
    Object.keys(cat).forEach(function(k) { catBody[k] = cat[k]; });
    catBody.pin = body.pin;

    if (typeof existing[key] === 'number') {
      // Category exists — update in-place so the CSV can override the seed
      catBody.row_num = existing[key];
      const r = updateCategory(catBody);
      results.push({ name: key, ok: r.ok, updated: true, error: r.error || null });
    } else {
      const r = createCategory(catBody);
      results.push({ name: key, ok: r.ok, updated: false, error: r.error || null });
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

  const TYPE_COL  = 3; // transaction_type
  const MAJOR_COL = 8; // major_category
  const MINOR_COL = 9; // minor_category

  const catSheet = e.source.getSheetByName(CATEGORIES_SHEET);
  if (!catSheet) return;
  const catData = catSheet.getDataRange().getValues().slice(1);

  if (col === TYPE_COL) {
    const txType = sheet.getRange(row, TYPE_COL).getValue();
    const majors = [];
    const seen   = {};
    catData.filter(function(r) { return r[0] === txType; }).forEach(function(r) {
      if (!seen[r[1]]) { majors.push(r[1]); seen[r[1]] = true; }
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
      .filter(function(r) { return r[0] === txType2 && r[1] === major; })
      .map(function(r) { return r[2]; });

    sheet.getRange(row, MINOR_COL).clearContent();

    if (minors.length > 0) {
      const rule2 = SpreadsheetApp.newDataValidation()
        .requireValueInList(minors, true).setAllowInvalid(false).build();
      sheet.getRange(row, MINOR_COL).setDataValidation(rule2);
    }
  }
}
