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
  if (headers.length > columns.length)
    throw new Error('sheet_header_mismatch: migrate sheet ' + name + ' unexpected trailing columns');
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
  const stored = PropertiesService.getScriptProperties().getProperty('MERIDIAN_FULCRUM_PIN');
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

// A browser snapshot can outlive a CSV rewrite or a manual row reorder. Never
// apply an identified edit to whichever unrelated record now occupies that row.
function matchesExpectedRecord(body, storedId, storedUpdatedAt) {
  if (body.expected_id !== undefined && (typeof body.expected_id !== 'string' || body.expected_id.trim() === ''
      || body.expected_id.trim().toLowerCase() !== String(storedId).trim().toLowerCase())) return false;
  if (body.expected_updated_at === undefined) return true; // legacy API callers
  function auditText(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return Number.isFinite(value.getTime()) ? value.toISOString() : '';
    return value === undefined || value === null ? '' : String(value).trim();
  }
  return auditText(body.expected_updated_at) === auditText(storedUpdatedAt);
}

function isFiniteDecimal(value) {
  return (typeof value === 'number' || typeof value === 'string')
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value).trim())
    && Number.isFinite(Number(value));
}

function decimalValueKey(value) {
  if (isFiniteDecimal(value) === false) return null;
  const parts = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value).trim());
  const fraction = parts[3] === undefined ? '' : parts[3];
  let digits = (parts[2] + fraction).replace(/^0+/, '');
  if (digits === '') return '0';
  let exponent = (parts[4] === undefined ? 0 : Number(parts[4])) - fraction.length;
  const trailing = /0+$/.exec(digits);
  if (trailing !== null) { exponent += trailing[0].length; digits = digits.slice(0, -trailing[0].length); }
  return (parts[1] === '-' ? '-' : '') + digits + 'e' + exponent;
}

// Shared with all local-wall-time source contracts. Offset-bearing timestamps
// must not be confused with local time and DST gaps/folds cannot be guessed.
function localDateTimeKey(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (parts === null) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
  const calendar = localCalendarDate(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return parts.slice(1, 4).join('-') + ' ' + parts.slice(4, 7).join(':') + '.'
    + (parts[7] === undefined ? '' : parts[7]).padEnd(6, '0');
}

function localCalendarDate(year, month, day) {
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month, day);
  return calendar;
}

function ianaDateFormatter(timezone) {
  if (typeof timezone !== 'string' || /^[+-]/.test(timezone)) throw new Error('invalid_timezone');
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function zonedDateParts(instant, formatter) {
  const parts = {};
  formatter.formatToParts(instant).forEach(function(part) { parts[part.type] = part.value; });
  return parts;
}

function localWallTimeCandidates(key, timezone) {
  const formatter = ianaDateFormatter(timezone);
  const wall = localCalendarDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  wall.setUTCHours(Number(key.slice(11, 13)), Number(key.slice(14, 16)), Number(key.slice(17, 19)), 0);
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = new Date(wall.getTime() + hours * 3600000);
    const parts = zonedDateParts(instant, formatter);
    const local = localCalendarDate(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    local.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    offsets.add(local.getTime() - instant.getTime());
  }
  const matches = new Set();
  offsets.forEach(function(offset) {
    const instant = new Date(wall.getTime() - offset);
    const parts = zonedDateParts(instant, formatter);
    const local = parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second;
    if (local === key.slice(0, 19)) matches.add(instant.getTime());
  });
  return Array.from(matches);
}

function localWallTimeError(key, timezone) {
  const matches = localWallTimeCandidates(key, timezone);
  if (matches.length === 0) return 'nonexistent_local_time';
  if (matches.length > 1) return 'ambiguous_local_time';
  return null;
}

function localDateTimeUtcKey(key, timezone) {
  try {
    const matches = localWallTimeCandidates(key, timezone);
    if (matches.length !== 1) return null;
    // Preserve all six fractional digits when comparing snapshot cutoffs.
    return new Date(matches[0]).toISOString().slice(0, 19).replace('T', ' ') + '.' + key.slice(20);
  } catch (_) { return null; }
}

function sheetLocalDateTimeText(value) {
  if (Object.prototype.toString.call(value) !== '[object Date]') return value;
  if (!Number.isFinite(value.getTime())) return '';
  return Utilities.formatDate(value, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss.SSS');
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
