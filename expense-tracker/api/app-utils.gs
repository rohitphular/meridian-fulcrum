// =============================================================================
// FULCRUM FORGE — Utils: shared helpers used across multiple modules
// =============================================================================

function getOrCreateSheet(name, columns) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  _assertMasterSheetNameReady(ss, name);
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  // Positional schemas cannot safely read/write reordered or renamed legacy headers.
  // Require an explicit sheet migration instead of appending duplicate replacements.
  for (let i = 0; i < Math.min(headers.length, columns.length); i++) {
    if (headers[i] !== columns[i])
      throw new Error('sheet_header_mismatch: migrate sheet ' + name + ' column ' + (i + 1));
  }
  let added = 0;
  columns.forEach(col => {
    if (!headers.includes(col)) sheet.getRange(1, lastCol + ++added).setValue(col);
  });
  return sheet;
}

// Read-only guard shared by regular access and the edit trigger. This runs before
// getOrCreateSheet can create a replacement tab or append headers to a collision.
function _assertMasterSheetNameReady(spreadsheet, name) {
  const rename = MASTER_SHEET_RENAMES.find(function(candidate) { return candidate.sheet_name === name; });
  if (rename === undefined) return;
  const names = spreadsheet.getSheets().map(function(sheet) { return sheet.getName(); });
  if (names.indexOf(rename.legacy_name) === -1) return;
  if (names.indexOf(rename.sheet_name) !== -1) throw new Error('master_sheet_name_collision');
  throw new Error('legacy_master_sheet_name');
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] !== null && row[i] !== undefined) ? row[i] : ''; });
    return obj;
  });
}

function sheetToObjectsWithRow(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 }; // 1-based sheet row; +1 for header row
    headers.forEach((h, j) => { obj[h] = (row[j] !== null && row[j] !== undefined) ? row[j] : ''; });
    return obj;
  });
}

function extractMeta(source) {
  return {
    ip:      (source.ip      !== undefined && source.ip      !== null && String(source.ip).trim()      !== '') ? String(source.ip)      : 'unknown',
    city:    (source.city    !== undefined && source.city    !== null) ? String(source.city)    : '',
    country: (source.country !== undefined && source.country !== null) ? String(source.country) : '',
    ua:      (source.ua      !== undefined && source.ua      !== null) ? String(source.ua)      : '',
  };
}

// Constant-time PIN comparison. Belt-and-braces against timing-based PIN
// inference — for a 6-digit PIN with IP lockout after MAX_FAILURES this is
// already non-exploitable in practice, but the cost is one tight loop.
function checkPin(pin) {
  const stored = PropertiesService.getScriptProperties().getProperty('PIN_SECRET');
  if (stored === null || stored === undefined || String(stored).trim() === '') return false;
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
  if (str === undefined || str === null || String(str).trim() === '') return [];
  return String(str).split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s !== ''; });
}

function normaliseTags(tags) {
  if (tags === undefined || tags === null || String(tags).trim() === '') return '';
  return String(tags).split(/[,;]+/).map(function(t) { return t.trim(); }).filter(function(s) { return s !== ''; }).join(';');
}

// Shared column-index helper used by every *ColIndex wrapper.
// Returns the 0-based array index for a schema field's sheet column position.
function getColIndex(schema, name) {
  const f = schema[name];
  if (!f) throw new Error('Unknown column: ' + name);
  return f.sheet_column_position - 1;
}

// Coerces a value that may be a native boolean or the string 'true'/'false'
// (as Sheets returns for boolean columns) into a JS boolean.
function toBool(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

// Converts a sheet datetime string ('YYYY-MM-DD HH:MM:SS') to a Date object.
// Returns null if the value is blank, null, undefined, or unparseable.
function sheetDateTimeToDate(str) {
  if (str === undefined || str === null || String(str).trim() === '') return null;
  if (Object.prototype.toString.call(str) === '[object Date]')
    return Number.isFinite(str.getTime()) ? new Date(str.getTime()) : null;
  const d = new Date(String(str).trim().replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

// Converts a Date object to a sheet datetime string ('YYYY-MM-DD HH:MM:SS').
function dateToSheetDateTime(date) {
  const pad = function(n) { return String(n).padStart(2, '0'); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}
