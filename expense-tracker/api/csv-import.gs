// =============================================================================
// FULCRUM FORGE — CSV import: shared parsing for every entity import endpoint
// Import endpoints receive the raw file text ({ csv, dry_run }) and own all
// parsing and validation; the browser only uploads the file and shows results.
// =============================================================================

// RFC-style CSV with quoted fields, embedded newlines and escaped quotes.
// Returns physical line numbers so row errors point at the line in the file.
// Values stay text: IDs and decimal amounts are never reinterpreted.
function parseCsvRecords(source) {
  const text = String(source).replace(/^\uFEFF/, '');
  const records = [];
  let values = [], value = '', quoted = false, closed = false, line = 1, rowLine = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else { value += char; if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) line++; }
    } else if (char === '"' && value === '' && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      values.push(value); value = ''; closed = false;
      if (char !== ',') {
        if (values.some(function(cell) { return cell.trim() !== ''; })) records.push({ values: values, line: rowLine });
        values = []; line++; rowLine = line;
        if (char === '\r' && text[index + 1] === '\n') index++;
      }
    } else if (closed || char === '"') return { records: [], errors: ['Row ' + line + ': invalid characters after a quoted CSV field.'] };
    else value += char;
  }
  if (quoted) return { records: [], errors: ['Row ' + rowLine + ': a quoted CSV field is not closed.'] };
  values.push(value);
  if (values.some(function(cell) { return cell.trim() !== ''; })) records.push({ values: values, line: rowLine });
  return { records: records, errors: [] };
}

// Parses an upload into trimmed text rows keyed by normalised header
// (trim, lowercase, spaces → underscores). Each row carries its CSV line as _line.
// Failures: { ok: false, error: 'missing_csv' | 'invalid_csv' | 'csv_has_no_rows' | 'invalid_csv_headers' | 'invalid_csv_rows', errors? }.
function parseCsvImport(body) {
  if (body === undefined || body === null || typeof body.csv !== 'string' || body.csv.trim() === '') return { ok: false, error: 'missing_csv' };
  const decoded = parseCsvRecords(body.csv);
  if (decoded.errors.length > 0) return { ok: false, error: 'invalid_csv', errors: decoded.errors };
  if (decoded.records.length < 2) return { ok: false, error: 'csv_has_no_rows' };
  const headers = decoded.records[0].values.map(function(header) { return header.trim().toLowerCase().replace(/\s+/g, '_'); });
  if (headers.indexOf('') !== -1 || new Set(headers).size !== headers.length)
    return { ok: false, error: 'invalid_csv_headers', errors: ['CSV has blank or duplicate column headers.'] };
  const rows = [], errors = [];
  decoded.records.slice(1).forEach(function(record) {
    if (record.values.length !== headers.length) {
      errors.push('Row ' + record.line + ': expected ' + headers.length + ' columns, found ' + record.values.length + '.');
      return;
    }
    const row = { _line: record.line };
    headers.forEach(function(header, column) { row[header] = record.values[column].trim(); });
    rows.push(row);
  });
  if (errors.length > 0) return { ok: false, error: 'invalid_csv_rows', errors: errors };
  return { ok: true, headers: headers, rows: rows };
}

// Shared response for a file that failed row-level validation: nothing is written.
function csvRowErrors(errors) {
  return { ok: false, error: 'invalid_csv_rows', errors: errors };
}

function isDryRun(body) {
  return body !== undefined && body !== null && body.dry_run === true;
}

// ── Fill missing ids ──────────────────────────────────────────────────────────

// Minimal quoting (comma, quote or line break), matching how the local CSVs are
// written, so unchanged rows keep their exact text.
function _csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// body: { csv } → { ok, csv, filled, rows }. Gives every data row with a blank
// or missing `id` cell a new lowercase UUID and returns the file text; nothing is written
// to any Sheet. A file with no blank ids (or no id column) comes back untouched.
function fillCsvIds(body) {
  if (body === undefined || body === null || typeof body.csv !== 'string' || body.csv.trim() === '') return { ok: false, error: 'missing_csv' };
  const source = body.csv;
  const decoded = parseCsvRecords(source);
  if (decoded.errors.length > 0) return { ok: false, error: 'invalid_csv', errors: decoded.errors };
  if (decoded.records.length === 0) return { ok: false, error: 'csv_has_no_rows' };
  const headers = decoded.records[0].values.map(function(header) { return header.trim().toLowerCase(); });
  const idColumn = headers.indexOf('id');
  const rows = decoded.records.length - 1;
  if (idColumn === -1) return { ok: true, csv: source, filled: 0, rows: rows, id_column: false };
  let filled = 0;
  decoded.records.slice(1).forEach(function(record) {
    // A short row (its cells stop before the id column) has a blank id too: pad it
    // with empty cells up to the id, or it would get a new id on every import.
    if (record.values.length > idColumn && record.values[idColumn].trim() !== '') return;
    while (record.values.length <= idColumn) record.values.push('');
    record.values[idColumn] = Utilities.getUuid().toLowerCase();
    filled++;
  });
  if (filled === 0) return { ok: true, csv: source, filled: 0, rows: rows, id_column: true };
  const text = source.replace(/^\uFEFF/, '');
  const newline = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const lines = decoded.records.map(function(record) { return record.values.map(_csvCell).join(','); });
  const trailing = /\r?\n$/.test(text) ? newline : '';
  const bom = source.charAt(0) === '\uFEFF' ? '\uFEFF' : '';
  console.log('fillCsvIds: rows=' + rows + ' filled=' + filled);
  return { ok: true, csv: bom + lines.join(newline) + trailing, filled: filled, rows: rows, id_column: true };
}
