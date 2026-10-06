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

function subscriptionLocalDateTimeKey(value) { return localDateTimeKey(value); }

function _subscriptionCalendarDate(year, month, day) { return localCalendarDate(year, month, day); }

function _subscriptionDateFormatter(timezone) { return ianaDateFormatter(timezone); }

function _subscriptionZonedParts(instant, formatter) { return zonedDateParts(instant, formatter); }

function _subscriptionLocalDate(instant, timezone) {
  const parts = _subscriptionZonedParts(instant, _subscriptionDateFormatter(timezone));
  return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
}

function subscriptionWallTimeError(key, timezone) { return localWallTimeError(key, timezone); }

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
