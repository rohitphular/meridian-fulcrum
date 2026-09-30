// =============================================================================
// FULCRUM FORGE — Subscription Import: CSV upload → validated bulk upsert
// The browser sends the raw file text; parsing, shaping and every format rule
// live here. A file with any format error writes nothing.
// =============================================================================

const SUBSCRIPTION_IMPORT_REQUIRED = ['subscription_name', 'subscription_amount_local', 'frequency', 'source_account'];

// Only these business fields are forwarded to createSubscriptionsBulk.
const SUBSCRIPTION_IMPORT_FIELDS = ['id', 'subscription_name', 'subscription_amount_local', 'frequency', 'source_account', 'record_status',
  'subscription_timezone_local', 'counterparty_name', 'day_of_month', 'day_of_week', 'tx_type', 'major_category', 'minor_category',
  'description', 'subscription_start_date_local', 'subscription_end_date_local'];

// Sync and audit columns are accepted (exports contain them) but never forwarded:
// the server owns those values.
const SUBSCRIPTION_IMPORT_IGNORED = ['sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];

const SUBSCRIPTION_IMPORT_MESSAGES = {
  invalid_row: 'row is not a subscription record',
  missing_name: 'subscription_name is required',
  missing_subscription_amount_local: 'subscription_amount_local is required',
  invalid_subscription_amount_local: 'subscription_amount_local must be a positive finite decimal number',
  missing_source_account: 'source_account is required',
  invalid_source_account: 'source_account must be a UUID',
  invalid_id: 'id must be a UUID',
  duplicate_id_in_file: 'duplicate id in CSV',
  missing_frequency: 'frequency is required',
  invalid_frequency: 'invalid frequency',
  missing_day_of_week: 'day_of_week is required for weekly schedules',
  missing_day_of_month: 'day_of_month is required for this frequency',
  invalid_day_of_week: 'day_of_week must be a whole number from 1 to 7',
  invalid_day_of_month: 'day_of_month must be a whole number from 1 to 31',
  invalid_subscription_timezone_local: 'invalid subscription_timezone_local',
  missing_subscription_timezone_local: 'subscription_timezone_local is required when dates are supplied',
  invalid_subscription_start_date_local: 'subscription_start_date_local must be a real local date and time (YYYY-MM-DD HH:MM:SS)',
  invalid_subscription_end_date_local: 'subscription_end_date_local must be a real local date and time (YYYY-MM-DD HH:MM:SS)',
  nonexistent_local_time: 'local time does not exist in the timezone (DST gap)',
  ambiguous_local_time: 'local time is ambiguous in the timezone (DST overlap)',
  missing_subscription_start_date_local: 'start date is required to anchor quarterly or annual payments',
  end_before_start: 'end date must not precede start date',
  invalid_tx_type: 'invalid tx_type',
  invalid_record_status: 'invalid record_status',
};

// Date-only → midnight, HH:MM → :00, ISO 'T' → space. Anything else is left for
// the schedule validator to reject.
function _subscriptionImportTimestamp(value) {
  const text = String(value).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + ' 00:00:00';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text + ':00';
  return text;
}

function _subscriptionImportError(line, code, field) {
  const message = SUBSCRIPTION_IMPORT_MESSAGES[code] === undefined ? code : SUBSCRIPTION_IMPORT_MESSAGES[code];
  return 'Row ' + line + ': ' + message + (field === undefined ? '' : ' [' + field + ']') + ' (' + code + ').';
}

// Header checks, per-row shaping and format validation. Reads no Sheet.
function _shapeSubscriptionImport(parsed) {
  const headers = parsed.headers;
  const missing = SUBSCRIPTION_IMPORT_REQUIRED.filter(function(header) { return headers.indexOf(header) === -1; });
  if (missing.length > 0) return { ok: false, error: 'invalid_csv_headers', errors: ['Missing required headers: ' + missing.join(', ') + '.'] };
  const unknown = headers.filter(function(header) {
    return SUBSCRIPTION_IMPORT_FIELDS.indexOf(header) === -1 && SUBSCRIPTION_IMPORT_IGNORED.indexOf(header) === -1;
  });
  if (unknown.length > 0) return { ok: false, error: 'invalid_csv_headers', errors: ['Unknown CSV headers: ' + unknown.join(', ') + '.'] };
  const subscriptions = [], errors = [], seenIds = Object.create(null);
  parsed.rows.forEach(function(row) {
    const shaped = { csv_row_num: row._line };
    SUBSCRIPTION_IMPORT_FIELDS.forEach(function(field) {
      if (row[field] === undefined || (row[field] === '' && (field === 'id' || field === 'record_status'))) return;
      shaped[field] = field === 'subscription_start_date_local' || field === 'subscription_end_date_local'
        ? _subscriptionImportTimestamp(row[field]) : row[field];
    });
    const validation = validateSubscriptionCreate(shaped);
    if (validation.ok === false) { errors.push(_subscriptionImportError(row._line, validation.error, validation.field)); return; }
    shaped.source_account = subscriptionUuid(shaped.source_account);
    if (shaped.id !== undefined) {
      shaped.id = subscriptionUuid(shaped.id);
      if (seenIds[shaped.id] !== undefined) { errors.push(_subscriptionImportError(row._line, 'duplicate_id_in_file')); return; }
      seenIds[shaped.id] = row._line;
    }
    subscriptions.push(shaped);
  });
  if (errors.length > 0) return csvRowErrors(errors);
  return { ok: true, subscriptions: subscriptions };
}

// body: { csv, dry_run? }. Real run → createSubscriptionsBulk response with each
// result carrying the CSV line it came from.
function importSubscriptionsCsv(body) {
  const parsed = parseCsvImport(body);
  if (parsed.ok === false) return parsed;
  const shaped = _shapeSubscriptionImport(parsed);
  if (shaped.ok === false) {
    console.warn('importSubscriptionsCsv: error=' + shaped.error + ' rows=' + parsed.rows.length);
    return shaped;
  }
  const count = shaped.subscriptions.length;
  if (isDryRun(body)) return { ok: true, dry_run: true, rows: count };
  const result = createSubscriptionsBulk({ subscriptions: shaped.subscriptions });
  if (Array.isArray(result.results)) {
    result.results.forEach(function(outcome, position) {
      const index = Number.isInteger(outcome.index) ? outcome.index : position;
      const source = shaped.subscriptions[index];
      if (source !== undefined) outcome.line = source.csv_row_num;
    });
  }
  result.rows = count;
  console.log('importSubscriptionsCsv: rows=' + count + ' ok=' + (result.ok === true));
  return result;
}
