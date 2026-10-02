// =============================================================================
// FULCRUM FORGE — Sync Utils: shared sync status helpers across all entities
// =============================================================================

const SYNC_STATUS_CREATE_PENDING = 'create-pending';
const SYNC_STATUS_UPDATE_PENDING = 'update-pending';
const SYNC_STATUS_IN_SYNC        = 'in-sync';
const SYNC_STATUS_CREATE_FAILED  = 'create-failed';
const SYNC_STATUS_UPDATE_FAILED  = 'update-failed';

const VALID_RECORD_STATUSES = ['active', 'inactive', 'deleted', 'locked'];

// Computes the sync_status for an entity being updated.
// create-pending and create-failed both reset to create-pending — the sync job must
// still CREATE the record in the target; setting update-pending would issue an UPDATE
// on a non-existent row.  All other states (update-pending, update-failed, in-sync)
// become update-pending.  sync_notes must be cleared by the caller.
function computeSyncStatus(currentStatus) {
  const createStates = new Set([SYNC_STATUS_CREATE_PENDING, SYNC_STATUS_CREATE_FAILED, '']);
  return createStates.has(currentStatus)
    ? SYNC_STATUS_CREATE_PENDING
    : SYNC_STATUS_UPDATE_PENDING;
}

// ── Unchanged re-imports ──────────────────────────────────────────────────────
// A re-imported row whose business values equal the stored row is left exactly as
// it is (no write), so sync_status stays (in-sync stays in-sync) and the ledger
// extractor only sees rows that really changed. Import-owned columns are ignored.
const IMPORT_COMPARE_IGNORED = ['sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];

const _IMPORT_DATETIME = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;

function _importText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _importDateTimeKey(text) {
  const match = _IMPORT_DATETIME.exec(text);
  if (match === null) return null;
  const fraction = match[5] === undefined ? '' : match[5].replace(/0+$/, '');
  return match[1] + ' ' + (match[2] || '00') + ':' + (match[3] || '00') + ':' + (match[4] || '00') + (fraction === '' ? '' : '.' + fraction);
}

// Whether a stored Sheet cell and an incoming import value are the same value.
// Sheets turns some text into typed cells, so a typed stored cell is compared by
// type: a Date as its displayed local wall time, a number by value (1475 = "1475.00"),
// a boolean case-insensitively. Otherwise both compare as trimmed text, so an
// unsure match counts as a change (the row is re-queued, as before).
function importCellsEqual(stored, incoming) {
  if (Object.prototype.toString.call(stored) === '[object Date]') {
    if (!Number.isFinite(stored.getTime())) return _importText(incoming) === '';
    const storedKey = _importDateTimeKey(sheetLocalDateTimeText(stored));
    return storedKey !== null && storedKey === _importDateTimeKey(_importText(incoming));
  }
  if (typeof stored === 'number') {
    const text = _importText(incoming);
    return text !== '' && Number.isFinite(Number(text)) && Number(text) === stored;
  }
  if (typeof stored === 'boolean') return _importText(incoming).toLowerCase() === String(stored);
  return _importText(stored) === _importText(incoming);
}

// True when every non-ignored column of the two rows is equal.
// columns: the sheet's column keys, in order; rows are positional arrays.
function importRowUnchanged(columns, storedRow, incomingRow) {
  if (storedRow === undefined || storedRow === null) return false;
  for (let index = 0; index < columns.length; index++) {
    if (IMPORT_COMPARE_IGNORED.indexOf(columns[index]) !== -1) continue;
    if (!importCellsEqual(storedRow[index], incomingRow[index])) return false;
  }
  return true;
}
