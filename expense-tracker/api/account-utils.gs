// =============================================================================
// FULCRUM FORGE — Account Utils: stateless helpers
// No sheet I/O. All functions are pure computations.
// =============================================================================

function isAccountUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function isAccountDecimal(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) === false) return false;
  return Number.isFinite(Number(value));
}

// Preserve decimal text from CSV/API callers; liability sign handling does not
// need a lossy Number conversion before the Python minor-unit conversion.
function accountOpeningValue(value, type) {
  if (typeof value === 'number') return isLiabilityType(type) ? -Math.abs(value) : value;
  const amount = value.trim();
  return isLiabilityType(type) ? '-' + amount.replace(/^[+-]/, '') : amount;
}

// Validates local wall-clock syntax and calendar components without the server's
// timezone or JavaScript's permissive rollover parsing. Key supports ordering at
// the six fractional-second digits accepted by ledger-sheet-extract.
function accountLocalDateTimeKey(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/.exec(value.trim());
  if (parts === null) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const hour = parts[4] === undefined ? 0 : Number(parts[4]);
  const minute = parts[5] === undefined ? 0 : Number(parts[5]);
  const second = parts[6] === undefined ? 0 : Number(parts[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return parts[1] + '-' + parts[2] + '-' + parts[3] + ' '
    + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':' + String(second).padStart(2, '0')
    + '.' + (parts[7] === undefined ? '' : parts[7]).padEnd(6, '0');
}

function accountTimezone(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return ianaDateFormatter(String(value).trim()).resolvedOptions().timeZone;
}
