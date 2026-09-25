// Wall timestamps belong to the row's timezone, independently of the device zone.
const _FORMATTERS = new Map();
const _INSTANTS = new Map();
const _CACHE_LIMIT = 2048;

function _parts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/.exec(String(value ?? '').trim());
  if (match === null) { return null; }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)];
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], 0);
  if (parts[0] < 1 || date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 ||
      date.getUTCDate() !== parts[2] || date.getUTCHours() !== parts[3] ||
      date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) { return null; }
  return { parts, time: date.getTime(), fraction: Number('0.' + (match[7] ?? '0')) * 1000 };
}

function _formatter(zone) {
  if (!_FORMATTERS.has(zone)) {
    try {
      if (zone === '' || /^[+-]/.test(zone)) { return null; }
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
      if (_FORMATTERS.size >= _CACHE_LIMIT) { _FORMATTERS.delete(_FORMATTERS.keys().next().value); }
      _FORMATTERS.set(zone, formatter);
    } catch (_) { return null; }
  }
  return _FORMATTERS.get(zone);
}

function _zonedParts(time, formatter) {
  const values = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return [values.year, values.month, values.day, values.hour, values.minute, values.second].map(Number);
}

export function localDateTimeInstant(value, timezone) {
  const zone = String(timezone ?? '').trim();
  const key = zone + '|' + String(value);
  if (_INSTANTS.has(key)) { return _INSTANTS.get(key); }
  const local = _parts(value);
  const formatter = _formatter(zone);
  if (local === null || formatter === null) { return NaN; }
  // Sampling both sides finds both offsets around a DST transition. Only an
  // exact round trip is accepted: a missing/repeated wall time is not guessed.
  const candidates = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = local.time + hours * 3600000;
    const parts = _zonedParts(probe, formatter);
    const represented = new Date(0);
    represented.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
    represented.setUTCHours(parts[3], parts[4], parts[5], 0);
    const candidate = local.time - (represented.getTime() - probe);
    if (_zonedParts(candidate, formatter).every((part, index) => part === local.parts[index])) {
      candidates.add(candidate);
    }
  }
  const result = candidates.size === 1 ? candidates.values().next().value + local.fraction : NaN;
  if (_INSTANTS.size >= _CACHE_LIMIT) { _INSTANTS.delete(_INSTANTS.keys().next().value); }
  _INSTANTS.set(key, result);
  return result;
}

function _legacyWallTime(value) {
  const parsed = _parts(value);
  if (parsed === null) { return NaN; }
  const [year, month, day, hour, minute, second] = parsed.parts;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  return date.getTime() + parsed.fraction;
}

export function accountSnapshotInstant(account) {
  const value = String(account.tracking_start_date_local ?? '').trim();
  if (value === '') { return -Infinity; }
  const zone = String(account.local_timezone ?? '').trim();
  return zone === '' ? _legacyWallTime(value) : localDateTimeInstant(value, zone);
}

export function accountMovementInstant(account, transaction) {
  if (String(account.local_timezone ?? '').trim() === '') { return _legacyWallTime(transaction.tx_date_local); }
  const zone = String(transaction.tx_timezone_local ?? '').trim();
  return localDateTimeInstant(transaction.tx_date_local, zone === '' ? 'Europe/London' : zone);
}

export function balanceMovementAffectsSnapshot(account, transaction) {
  if (String(account.local_timezone ?? '').trim() === '') {
    // Legacy cutoffs compare wall-time components. Converting them through the
    // device zone would normalize a DST gap and can move an earlier row past
    // the cutoff even though its recorded timezone has no gap that day.
    const movement = _parts(transaction.tx_date_local);
    const rawStart = String(account.tracking_start_date_local ?? '').trim();
    const start = rawStart === '' ? null : _parts(rawStart);
    if (movement === null || (rawStart !== '' && start === null)) { return false; }
    return start === null || movement.time + movement.fraction >= start.time + start.fraction;
  }
  const movement = accountMovementInstant(account, transaction);
  return Number.isFinite(movement) && movement >= accountSnapshotInstant(account);
}
