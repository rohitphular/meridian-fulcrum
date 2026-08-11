// =============================================================================
// FULCRUM FORGE — Utils: shared helpers used across multiple modules
// =============================================================================

function getOrCreateSheet(name, columns) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  let added = 0;
  columns.forEach(col => {
    if (!headers.includes(col)) sheet.getRange(1, lastCol + ++added).setValue(col);
  });
  return sheet;
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}

function sheetToObjectsWithRow(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 }; // 1-based sheet row; +1 for header row
    headers.forEach((h, j) => { obj[h] = row[j] ?? ''; });
    return obj;
  });
}

function extractMeta(source) {
  return {
    ip:      source.ip      || 'unknown',
    city:    source.city    || '',
    country: source.country || '',
    ua:      source.ua      || ''
  };
}

// Constant-time PIN comparison. Belt-and-braces against timing-based PIN
// inference — for a 6-digit PIN with IP lockout after MAX_FAILURES this is
// already non-exploitable in practice, but the cost is one tight loop.
function checkPin(pin) {
  const stored = PropertiesService.getScriptProperties().getProperty('PIN_SECRET');
  return _constantTimeEqual(pin, stored);
}

function _constantTimeEqual(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  // Always iterate the longer length so a length-mismatch can't be inferred
  // from early-return timing.
  const n  = Math.max(sa.length, sb.length);
  let diff = sa.length === sb.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    const ca = i < sa.length ? sa.charCodeAt(i) : 0;
    const cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Splits a comma-separated string into a trimmed, non-empty array.
function splitToList(str) {
  if (!str) return [];
  return String(str).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function normaliseTags(tags) {
  if (!tags) return '';
  return String(tags).split(/[,;]+/).map(function(t) { return t.trim(); }).filter(Boolean).join(';');
}

// Shared column-index helper used by every *ColIndex wrapper.
// Returns the 0-based array index for a schema field's sheet column position.
function getColIndex(schema, name) {
  const f = schema[name];
  if (!f) throw new Error('Unknown column: ' + name);
  return f.sheet_column_position - 1;
}
