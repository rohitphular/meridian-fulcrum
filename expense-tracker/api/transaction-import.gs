// =============================================================================
// FULCRUM FORGE — Transaction CSV import: parse, validate and resolve accounts
// The browser uploads the raw file ({ csv, dry_run }). Every row is checked
// before anything is written; a transfer is one compact row (both accounts and
// amounts) that createTransactionsBulk expands into its two legs.
// =============================================================================

const TRANSACTION_IMPORT_REQUIRED_HEADERS = ['tx_date_local', 'tx_type', 'major_category', 'minor_category'];
const TRANSACTION_IMPORT_NUMERIC_FIELDS = ['source_amount_local', 'target_amount_local', 'user_location_latitude', 'user_location_longitude'];
const TRANSACTION_IMPORT_TEXT_FIELDS = ['tx_timezone_local', 'user_location_area', 'user_location_city', 'user_location_country',
  'description', 'counterparty_name', 'tx_tags', 'beneficiaries'];

// body: { csv, dry_run? }. dry_run runs the format checks only and reads no Sheet;
// account names are resolved (from Sheet data) only on a real import.
function importTransactionsCsv(body) {
  const parsed = parseCsvImport(body);
  if (parsed.ok === false) return parsed;
  const missing = TRANSACTION_IMPORT_REQUIRED_HEADERS.filter(function(header) { return parsed.headers.indexOf(header) === -1; });
  if (parsed.headers.indexOf('source_amount_local') === -1 && parsed.headers.indexOf('target_amount_local') === -1)
    missing.push('source_amount_local or target_amount_local');
  if (missing.length > 0) return { ok: false, error: 'invalid_csv_headers', errors: ['Missing required headers: ' + missing.join(', ')] };

  const dryRun = isDryRun(body);
  const shaped = _shapeTransactionImportRows(parsed.rows, dryRun);
  if (shaped.errors.length > 0) {
    console.warn('importTransactionsCsv: rows=' + parsed.rows.length + ' invalid_rows=' + shaped.errors.length + ' dry_run=' + dryRun);
    return csvRowErrors(shaped.errors);
  }
  const withoutId = shaped.transactions.filter(function(tx) { return tx.id === ''; }).length;
  if (dryRun) return { ok: true, dry_run: true, rows: shaped.transactions.length, without_id: withoutId };

  // One bulk call for the whole file, so a repeated id is seen across every row.
  const result = createTransactionsBulk({ transactions: shaped.transactions });
  // Bulk results are one per input row, in input order.
  if (Array.isArray(result.results)) {
    result.results.forEach(function(entry, index) { entry.line = shaped.lines[index]; });
  }
  console.log('importTransactionsCsv: rows=' + shaped.transactions.length + ' without_id=' + withoutId + ' ok=' + (result.ok === true));
  return Object.assign(result, { rows: shaped.transactions.length, without_id: withoutId });
}

function _shapeTransactionImportRows(rows, dryRun) {
  const errors = [], transactions = [], lines = [];
  const idLines = Object.create(null);
  const recordStatuses = TRANSACTION_SCHEMA.record_status.enum_values;
  // Accounts include inactive/locked (historical rows use closed accounts) but not deleted ones.
  const accounts = dryRun ? [] : listAccounts().filter(function(account) { return String(account.record_status) !== 'deleted'; });
  const categories = dryRun ? [] : listCategories();

  rows.forEach(function(row) {
    const rowErrors = [];
    // Syntax only: calendar/timezone meaning (DST gaps and folds) is checked by the bulk writer.
    if (_txImportText(row.tx_date_local) === '') rowErrors.push('missing tx_date_local');
    else if (localDateTimeKey(row.tx_date_local) === null) rowErrors.push('invalid tx_date_local: expected YYYY-MM-DD HH:MM:SS');
    if (_txImportText(row.tx_type) === '') rowErrors.push('missing tx_type');
    else if (VALID_TRANSACTION_TYPES.indexOf(row.tx_type) === -1)
      rowErrors.push('invalid tx_type: "' + row.tx_type + '" (expected ' + VALID_TRANSACTION_TYPES.join(', ') + ')');
    if (_txImportText(row.source_amount_local) === '' && _txImportText(row.target_amount_local) === '')
      rowErrors.push('missing amount (source_amount_local or target_amount_local)');
    const id = _txImportText(row.id);
    if (id !== '') {
      const idKey = id.toLowerCase();
      if (_transactionUuid(id) === null) rowErrors.push('invalid id: expected a UUID');
      else if (idLines[idKey] !== undefined) rowErrors.push('duplicate id: already used on row ' + idLines[idKey]);
      else idLines[idKey] = row._line;
    }
    if (_txImportText(row.major_category) === '') rowErrors.push('missing major_category');
    if (_txImportText(row.minor_category) === '') rowErrors.push('missing minor_category');

    // Amounts keep their exact decimal text; coordinates become Numbers.
    const numeric = {};
    TRANSACTION_IMPORT_NUMERIC_FIELDS.forEach(function(field) {
      const value = _txImportText(row[field]);
      numeric[field] = '';
      if (value === '') return;
      if (isFiniteDecimal(value) === false) {
        rowErrors.push('invalid ' + field + ': expected a finite decimal number without grouping separators');
        return;
      }
      numeric[field] = field.slice(-13) === '_amount_local' ? value : Number(value);
    });

    const recordStatus = _txImportText(row.record_status);
    if (recordStatus !== '' && recordStatuses.indexOf(recordStatus) === -1)
      rowErrors.push('invalid record_status: "' + recordStatus + '" (expected ' + recordStatuses.join(', ') + ')');

    let sourceId = '', targetId = '';
    if (!dryRun) {
      // Category hints are used only when exactly one active category has the full key.
      const matching = categories.filter(function(category) {
        return category.record_status === 'active' && category.tx_type_key === row.tx_type
          && category.major_category_key === row.major_category && category.minor_category_key === row.minor_category;
      });
      const category = matching.length === 1 ? matching[0] : null;
      sourceId = _resolveTransactionImportAccount(accounts, row.source_account, 'source_account', category, rowErrors);
      targetId = _resolveTransactionImportAccount(accounts, row.target_account, 'target_account', category, rowErrors);
    }

    if (rowErrors.length > 0) { errors.push('Row ' + row._line + ': ' + rowErrors.join('; ')); return; }

    const tx = {
      id:                      id,
      tx_date_local:           row.tx_date_local.replace('T', ' '),
      tx_type:                 row.tx_type,
      source_account:          sourceId,
      target_account:          targetId,
      source_amount_local:     numeric.source_amount_local,
      target_amount_local:     numeric.target_amount_local,
      user_location_latitude:  numeric.user_location_latitude,
      user_location_longitude: numeric.user_location_longitude,
      major_category:          row.major_category,
      minor_category:          row.minor_category,
    };
    TRANSACTION_IMPORT_TEXT_FIELDS.forEach(function(field) { tx[field] = _txImportText(row[field]); });
    // A blank lifecycle is omitted so an existing row keeps its status.
    if (recordStatus !== '') tx.record_status = recordStatus;
    transactions.push(tx);
    lines.push(row._line);
  });
  return { transactions: transactions, lines: lines, errors: errors };
}

// UUID first, then trimmed case-insensitive name. Category hints only break a tie
// between identically named accounts; they never redirect an explicit UUID.
function _resolveTransactionImportAccount(accounts, value, field, category, rowErrors) {
  const text = _txImportText(value);
  if (text === '') return '';
  const key = text.toLowerCase();
  let matches = accounts.filter(function(account) { return String(account.id).toLowerCase() === key; });
  if (matches.length === 0) {
    matches = accounts.filter(function(account) { return String(account.account_name).trim().toLowerCase() === key; });
    if (matches.length > 1 && category !== null) {
      const eligible = _filterTransactionImportAccounts(matches, category[field + '_types']);
      if (eligible.length === 1) return eligible[0].id;
    }
  }
  if (matches.length !== 1) {
    const guidance = matches.length > 1 ? '; category rules do not identify one account. Use an account UUID to choose explicitly.' : '';
    rowErrors.push((matches.length === 0 ? 'unknown' : 'ambiguous') + ' account: "' + text + '" (' + field + ')' + guidance);
    return '';
  }
  return matches[0].id;
}

// A hint matches the account's type or sub_type. Blank hints keep every candidate,
// so they can never pick one of several same-named accounts.
function _filterTransactionImportAccounts(accounts, allowedTypes) {
  const allowed = splitToList(allowedTypes).map(function(token) { return token.toLowerCase(); });
  if (allowed.length === 0) return accounts;
  return accounts.filter(function(account) {
    return [account.type, account.sub_type].some(function(key) { return allowed.indexOf(_txImportText(key).toLowerCase()) !== -1; });
  });
}

function _txImportText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}
