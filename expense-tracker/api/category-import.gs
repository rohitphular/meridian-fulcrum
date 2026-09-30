// =============================================================================
// FULCRUM FORGE — Category CSV import (create_categories_bulk)
// The browser uploads the raw category_master.csv text; this endpoint parses,
// validates and shapes the rows, then hands them to createCategoriesBulk.
// =============================================================================

const CATEGORY_IMPORT_REQUIRED_HEADERS = ['tx_type_key', 'major_category_label', 'minor_category_label'];
const CATEGORY_IMPORT_BOOLEAN_FIELDS = ['source_account_mandatory', 'target_account_mandatory', 'is_subscription_eligible'];
// Only these columns are forwarded. Key, label-derived and audit columns in an
// exported CSV are ignored: keys derive from labels and the server owns audit.
const CATEGORY_IMPORT_TEXT_FIELDS = ['id', 'tx_type_key', 'major_category_label', 'minor_category_label', 'description',
  'record_status', 'tag_keywords', 'counterparty_examples', 'source_account_types', 'target_account_types'];

// Row-level format checks only — validateCategoryFormat never reads a Sheet (safe for dry runs).
function _categoryCsvRowErrors(row) {
  const validation = validateCategoryFormat(row);
  if (validation.ok) return [];
  const values = validation.invalid_values === undefined ? [] : validation.invalid_values.filter(function(value) { return value !== ''; });
  const detail = values.length > 0 ? ': ' + values.join(', ') : '';
  return [validation.error + (validation.field !== undefined ? ' (' + validation.field + detail + ')' : '')];
}

function _shapeCategoryCsvRow(row) {
  const category = { csv_row_num: row._line };
  CATEGORY_IMPORT_TEXT_FIELDS.forEach(function(field) {
    // Blank record_status is omitted so the server default (or retained state) applies.
    if (row[field] !== undefined && (row[field] !== '' || field !== 'record_status')) category[field] = row[field];
  });
  if (category.id !== undefined) category.id = category.id.toLowerCase();
  CATEGORY_IMPORT_BOOLEAN_FIELDS.forEach(function(field) {
    if (row[field] !== undefined && row[field] !== '') category[field] = row[field].toLowerCase() === 'true';
  });
  return category;
}

function importCategoriesCsv(body) {
  const parsed = parseCsvImport(body);
  if (!parsed.ok) return parsed;
  const missing = CATEGORY_IMPORT_REQUIRED_HEADERS.filter(function(header) { return parsed.headers.indexOf(header) === -1; });
  if (missing.length > 0)
    return { ok: false, error: 'invalid_csv_headers', errors: ['Missing required headers: ' + missing.join(', ') + '.'] };

  const errors = [];
  const firstLineById = {};
  parsed.rows.forEach(function(row) {
    const rowErrors = _categoryCsvRowErrors(row);
    if (rowErrors.length === 0 && row.id !== undefined && row.id !== '') {
      const id = row.id.toLowerCase();
      if (firstLineById[id] !== undefined) rowErrors.push('id repeats row ' + firstLineById[id]);
      else firstLineById[id] = row._line;
    }
    if (rowErrors.length > 0) errors.push('Row ' + row._line + ': ' + rowErrors.join('; ') + '.');
  });
  if (errors.length > 0) {
    console.log('importCategoriesCsv: rows=' + parsed.rows.length + ' error=invalid_csv_rows count=' + errors.length);
    return csvRowErrors(errors);
  }
  if (isDryRun(body)) return { ok: true, dry_run: true, rows: parsed.rows.length };

  const categories = parsed.rows.map(_shapeCategoryCsvRow);
  const result = createCategoriesBulk({ categories: categories });
  if (Array.isArray(result.results)) {
    result.results.forEach(function(item, position) {
      const index = Number.isInteger(item.index) ? item.index : position;
      const row = parsed.rows[index];
      if (row === undefined) return;
      item.line = row._line;
      item.label = [row.major_category_label, row.minor_category_label].filter(function(value) { return value !== ''; }).join(' → ');
    });
  }
  result.rows = parsed.rows.length;
  return result;
}
