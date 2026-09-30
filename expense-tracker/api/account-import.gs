// =============================================================================
// FULCRUM FORGE — Account CSV import: account_master and the six detail tabs
//
// Action: import_account_data
// Body:   { action:'import_account_data', pin, file_type, csv, dry_run? }
//
// The browser uploads the raw file text; this endpoint parses it, runs the
// row-level format checks, and hands the trimmed text rows (keyed by header,
// exactly as the old browser parser sent them) to importAccountData, which owns
// every Sheet-dependent check and the id-based upsert.
//
// dry_run: parse + format checks only — never reads or writes a Sheet.
// Response: importAccountData's { ok, file_type, created, updated, failed, results }
//           with each results[i].line set to its CSV line, plus rows.
//           Invalid files: { ok:false, error:'invalid_csv_rows', errors:['Row N: …'] }.
// =============================================================================

function importAccountDataCsv(body) {
  const fileType = (body.file_type !== undefined && body.file_type !== null) ? String(body.file_type).trim() : '';
  if (fileType === '') return { ok: false, error: 'missing_file_type' };
  const spec = getImportSpec(fileType);
  if (spec === null) return { ok: false, error: 'unknown_file_type' };

  const parsed = parseCsvImport(body);
  if (parsed.ok === false) return parsed;

  const errors = _accountCsvFormatErrors(fileType, spec, parsed.rows);
  if (errors.length > 0) {
    console.log('importAccountDataCsv: file_type=' + fileType + ' rows=' + parsed.rows.length + ' format_errors=' + errors.length);
    return csvRowErrors(errors);
  }
  if (isDryRun(body)) return { ok: true, dry_run: true, file_type: fileType, rows: parsed.rows.length };

  const lines = parsed.rows.map(function(row) { return row._line; });
  const rows = parsed.rows.map(function(row) {
    const shaped = Object.assign({}, row);
    delete shaped._line;
    return shaped;
  });
  const result = importAccountData({ file_type: fileType, rows: rows });
  // Bulk results are in input order on every path, so the index maps to the CSV line.
  if (Array.isArray(result.results)) {
    result.results = result.results.map(function(entry, index) { return Object.assign({ line: lines[index] }, entry); });
  }
  console.log('importAccountDataCsv: file_type=' + fileType + ' rows=' + rows.length + ' ok=' + (result.ok === true));
  return Object.assign({ rows: rows.length }, result);
}

// Sheet-free format checks. Detail rows reuse the importer's own pure row
// preparation; account rows use validateAccountFormat, the Sheet-free part of validateAccountCreate
// (its account-type and currency lookups read Sheets and run in the real import).
function _accountCsvFormatErrors(fileType, spec, rows) {
  const errors = [];
  const seenIds = Object.create(null);
  rows.forEach(function(row) {
    const failure = fileType === 'account_master' ? validateAccountFormat(row) : _prepareImportDetailRow(spec, row);
    if (failure !== null && failure.ok === false) {
      errors.push('Row ' + row._line + ': ' + failure.error + (failure.field !== undefined ? ' (' + failure.field + ')' : ''));
      return;
    }
    const id = row.id === undefined ? '' : row.id.toLowerCase();
    if (id === '') return;
    if (seenIds[id] !== undefined) errors.push('Row ' + row._line + ': duplicate_id (also on row ' + seenIds[id] + ')');
    else seenIds[id] = row._line;
  });
  return errors;
}

