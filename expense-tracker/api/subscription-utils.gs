// =============================================================================
// FULCRUM FORGE — Subscription Utils: stateless helpers
// No sheet I/O. All functions are pure computations.
// =============================================================================

function generateSubscriptionId(sheet) {
  const now     = new Date();
  const year    = now.getUTCFullYear();
  const month   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day     = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = year + '' + month + '' + day;
  const prefix  = 'SUB-' + dateStr + '-';
  const values  = sheet.getDataRange().getValues();
  let max     = 0;
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][0]);
    if (id.indexOf(prefix) === 0) {
      const n = parseInt(id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// computeNextPaymentDate
// Returns an ISO date string (YYYY-MM-DD) for the next scheduled payment.
//
// frequency    — one of VALID_FREQUENCIES
// dayOfMonth   — integer 1–31; used for monthly / quarterly / annual
// dayOfWeek    — integer 1–7 (1=Mon, 7=Sun); used for weekly
//
// All calculations are based on today's local date (not UTC) so that the result
// matches what the user would see on a calendar.
// ─────────────────────────────────────────────────────────────────────────────

function computeNextPaymentDate(frequency, dayOfMonth, dayOfWeek) {
  const today = new Date();
  // Work with year/month/day in local time throughout.
  const todayYear  = today.getFullYear();
  const todayMonth = today.getMonth();   // 0-based
  const todayDay   = today.getDate();    // 1-based

  // Default to day 1 when day_of_month is missing or invalid (0, NaN, empty).
  const dom = Number(dayOfMonth) || 1;

  if (frequency === 'weekly') {
    return _nextWeeklyDate(todayYear, todayMonth, todayDay, Number(dayOfWeek));
  }

  if (frequency === 'monthly') {
    return _nextCycleDate(todayYear, todayMonth, todayDay, dom, 1);
  }

  if (frequency === 'quarterly') {
    return _nextCycleDate(todayYear, todayMonth, todayDay, dom, 3);
  }

  if (frequency === 'annual') {
    return _nextCycleDate(todayYear, todayMonth, todayDay, dom, 12);
  }

  return '';
}

// Returns the ISO date string for the next occurrence of dayOfWeek (1=Mon…7=Sun)
// from today inclusive.
function _nextWeeklyDate(year, month, day, dayOfWeek) {
  // JS getDay(): 0=Sun, 1=Mon … 6=Sat  →  map to 1=Mon…7=Sun
  const d = new Date(year, month, day);
  const jsDay  = d.getDay();                       // 0=Sun
  const target = dayOfWeek === 7 ? 0 : dayOfWeek; // convert 7(Sun)→0
  const diff   = (target - jsDay + 7) % 7;        // days until next occurrence
  d.setDate(day + diff);
  return _isoDate(d);
}

// Returns the ISO date string for the next occurrence of dayOfMonth in a
// recurring cycle of stepMonths (1 = monthly, 3 = quarterly, 12 = annual).
// "Current" month is eligible if today's day <= effective target day.
// Clamps target day to the last day of any shorter month.
function _nextCycleDate(year, month, day, dayOfMonth, stepMonths) {
  // Compare all candidates against today — not against today's day in the walk month.
  const todayRef  = new Date(year, month, day);
  let candidate = _clampedDate(year, month, dayOfMonth);
  if (candidate >= todayRef) return _isoDate(candidate);
  // Walk forward in stepMonths increments until we find a future-or-today occurrence.
  for (let i = 0; i < 100; i++) {
    month += stepMonths;
    if (month > 11) {
      year  += Math.floor(month / 12);
      month  = month % 12;
    }
    candidate = _clampedDate(year, month, dayOfMonth);
    if (candidate >= todayRef) return _isoDate(candidate);
  }
  return '';
}

// Returns a Date clamped to the last day of the month when dayOfMonth exceeds
// the month's length (e.g. day 31 in April → April 30).
function _clampedDate(year, month, dayOfMonth) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(dayOfMonth, lastDay));
}

// YYYY-MM-DD from a local Date object.
function _isoDate(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}
