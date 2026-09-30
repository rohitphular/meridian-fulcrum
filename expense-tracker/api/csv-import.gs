// =============================================================================
// FULCRUM FORGE — CSV import: shared parsing for every entity import endpoint
// Import endpoints receive the raw file text ({ csv, dry_run }) and own all
// parsing and validation; the browser only uploads the file and shows results.
// =============================================================================

// RFC-style CSV with quoted fields, embedded newlines and escaped quotes.
// Returns physical line numbers so row errors point at the line in the file.
// Values stay text: IDs and decimal amounts are never reinterpreted.
function parseCsvRecords(source) {
  const text = String(source).replace(/^﻿/, '');
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
