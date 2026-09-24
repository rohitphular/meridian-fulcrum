// =============================================================================
// FULCRUM FORGE — Subscription Utils: stateless identity/date/schedule helpers
// =============================================================================

function generateSubscriptionId() { return Utilities.getUuid(); }

function subscriptionUuid(value) {
  if (typeof value !== 'string') return null;
  const identity = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity) ? identity : null;
}

function subscriptionText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function subscriptionLocalDateTimeKey(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (parts === null) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
  const calendar = _subscriptionCalendarDate(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return parts.slice(1, 4).join('-') + ' ' + parts.slice(4, 7).join(':') + '.'
    + (parts[7] === undefined ? '' : parts[7]).padEnd(6, '0');
}

function _subscriptionCalendarDate(year, month, day) {
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month, day);
  return calendar;
}

function _subscriptionDateFormatter(timezone) {
  // Intl also accepts raw numeric offsets; those are not IANA zone keys in ETL.
  if (/^[+-]/.test(timezone)) throw new Error('invalid_subscription_timezone_local');
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function _subscriptionZonedParts(instant, formatter) {
  const parts = {};
  formatter.formatToParts(instant).forEach(function(part) { parts[part.type] = part.value; });
  return parts;
}

function _subscriptionLocalDate(instant, timezone) {
  const parts = _subscriptionZonedParts(instant, _subscriptionDateFormatter(timezone));
  return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
}

// Reject wall times with zero or two possible instants, matching ledger-extract.
// Sample offsets around the local day so both sides of a DST change are considered.
function subscriptionWallTimeError(key, timezone) {
  const formatter = _subscriptionDateFormatter(timezone);
  const wall = _subscriptionCalendarDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  wall.setUTCHours(Number(key.slice(11, 13)), Number(key.slice(14, 16)), Number(key.slice(17, 19)), 0);
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = new Date(wall.getTime() + hours * 3600000);
    const parts = _subscriptionZonedParts(instant, formatter);
    const local = _subscriptionCalendarDate(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    local.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    offsets.add(local.getTime() - instant.getTime());
  }
  const matches = new Set();
  offsets.forEach(function(offset) {
    const instant = new Date(wall.getTime() - offset);
    const parts = _subscriptionZonedParts(instant, formatter);
    const local = parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second;
    if (local === key.slice(0, 19)) matches.add(instant.getTime());
  });
  if (matches.size === 0) return 'nonexistent_local_time';
  if (matches.size > 1) return 'ambiguous_local_time';
  return null;
}

// Scheduling is date-based in the row's timezone. Boundaries are inclusive;
// quarter/year cadence is anchored to the start month and cannot drift per read.
function computeNextPaymentDate(frequency, dayOfMonth, dayOfWeek, startDate, endDate, timezone, now) {
  frequency = subscriptionText(frequency);
  const start = subscriptionText(startDate);
  const end = subscriptionText(endDate);
  const zone = subscriptionText(timezone) === '' ? 'Europe/London' : subscriptionText(timezone);
  const today = _subscriptionLocalDate(now === undefined ? new Date() : now, zone);
  const startKey = start === '' ? null : subscriptionLocalDateTimeKey(start);
  const endKey = end === '' ? null : subscriptionLocalDateTimeKey(end);
  if ((start !== '' && startKey === null) || (end !== '' && endKey === null)) return '';
  if (startKey !== null && endKey !== null && endKey < startKey) return '';
  const lower = startKey !== null && startKey.slice(0, 10) > today ? startKey.slice(0, 10) : today;
  const upper = endKey === null ? '' : endKey.slice(0, 10);
  if (upper !== '' && lower > upper) return '';
  const year = Number(lower.slice(0, 4)), month = Number(lower.slice(5, 7)) - 1, day = Number(lower.slice(8, 10));
  let candidate;
  if (frequency === 'weekly') {
    const target = Number(dayOfWeek);
    if (!Number.isInteger(target) || target < 1 || target > 7) return '';
    candidate = _subscriptionCalendarDate(year, month, day);
    candidate.setUTCDate(day + ((target % 7 - candidate.getUTCDay() + 7) % 7));
  } else {
    const target = Number(dayOfMonth);
    if (!Number.isInteger(target) || target < 1 || target > 31) return '';
    const step = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : frequency === 'annual' ? 12 : 0;
    if (step === 0 || (step > 1 && startKey === null)) return '';
    let monthIndex = year * 12 + month;
    if (step > 1) {
      const anchor = Number(startKey.slice(0, 4)) * 12 + Number(startKey.slice(5, 7)) - 1;
      monthIndex = anchor + Math.max(0, Math.ceil((monthIndex - anchor) / step)) * step;
    }
    function clamped(monthNumber) {
      const candidateYear = Math.floor(monthNumber / 12), candidateMonth = monthNumber % 12;
      const last = _subscriptionCalendarDate(candidateYear, candidateMonth + 1, 0).getUTCDate();
      return _subscriptionCalendarDate(candidateYear, candidateMonth, Math.min(target, last));
    }
    candidate = clamped(monthIndex);
    if (candidate < _subscriptionCalendarDate(year, month, day)) candidate = clamped(monthIndex + step);
  }
  if (candidate.getUTCFullYear() > 9999) return '';
  const next = candidate.toISOString().slice(0, 10);
  return upper !== '' && next > upper ? '' : next;
}
