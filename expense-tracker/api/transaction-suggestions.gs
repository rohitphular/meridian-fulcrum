// =============================================================================
// FULCRUM FORGE — Transaction Suggestions: heuristic suggestion engine
// Applies 4 signals (recurring_monthly, recurring_weekly, time_of_day,
// recent_frequent) to money-out transactions and returns up to 10
// deduplicated suggestions ranked by confidence descending.
// =============================================================================

const _SUGGESTION_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

function getSuggestedTransactions() {
  const fnName = 'getSuggestedTransactions';
  const today  = new Date();

  const allTx = listTransactions();
  console.log(fnName + ': total_transactions=' + allTx.length);

  // Filter to money-out only — all signals operate on this subset
  const outTx = allTx.filter(function(tx) {
    return String(tx.tx_type) === 'money-out';
  });
  console.log(fnName + ': money_out_count=' + outTx.length);

  // Collect suggestions from each signal; map keyed by "counterparty_name|minor_category"
  const suggestionMap = {};

  _applyRecurringMonthly(outTx, today, suggestionMap);
  _applyRecurringWeekly(outTx, today, suggestionMap);
  _applyTimeOfDay(outTx, today, suggestionMap);
  _applyRecentFrequent(outTx, today, suggestionMap);

  // Sort by confidence descending, return top 10
  const results = Object.values(suggestionMap)
    .sort(function(a, b) { return b.confidence - a.confidence; })
    .slice(0, 10);

  console.log(fnName + ': suggestions_returned=' + results.length);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 1 — recurring_monthly
// Look back 6 calendar months; qualify if ≥ 4 distinct months; surface if no
// matching transaction this calendar month and today >= median_day - 3.
// ─────────────────────────────────────────────────────────────────────────────

function _applyRecurringMonthly(outTx, today, map) {
  const fnName   = '_applyRecurringMonthly';
  const cutoff   = new Date(today);
  cutoff.setMonth(cutoff.getMonth() - 6);
  cutoff.setDate(1);
  cutoff.setHours(0, 0, 0, 0);

  const thisMonth = today.getMonth();
  const thisYear  = today.getFullYear();
  const todayDay  = today.getDate();

  // Group relevant transactions by key
  const groups = {};
  outTx.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (isNaN(d.getTime()) || d < cutoff) return;
    const key = String(tx.counterparty_name || '') + '|' + String(tx.minor_category || '');
    if (!groups[key]) groups[key] = { tx: tx, occurrences: [] };
    groups[key].occurrences.push({ tx: tx, date: d });
  });

  Object.keys(groups).forEach(function(key) {
    const group = groups[key];
    const occs  = group.occurrences;

    // Count distinct calendar months
    const monthSet = {};
    occs.forEach(function(o) {
      const mk = o.date.getFullYear() + '-' + o.date.getMonth();
      monthSet[mk] = true;
    });
    const distinctMonths = Object.keys(monthSet).length;
    if (distinctMonths < 2) return;

    // Check if already transacted this calendar month
    const hasThisMonth = occs.some(function(o) {
      return o.date.getFullYear() === thisYear && o.date.getMonth() === thisMonth;
    });
    if (hasThisMonth) return;

    // Median day-of-month
    const days = occs.map(function(o) { return o.date.getDate(); }).sort(function(a, b) { return a - b; });
    const medianDay = _median(days);

    const confidence = Math.min(distinctMonths / 6, 1);
    const existing   = map[key];
    if (existing && existing.confidence >= confidence) return;

    map[key] = {
      signal:              'recurring_monthly',
      counterparty_name:   String(occs[0].tx.counterparty_name || ''),
      major_category:      _mostFrequent(occs.map(function(o) { return String(o.tx.major_category     || ''); })),
      minor_category:      String(occs[0].tx.minor_category || ''),
      source_account:      _mostFrequent(occs.map(function(o) { return String(o.tx.source_account     || ''); })),
      typical_amount:      _median(occs.map(function(o) { return Number(o.tx.amount) || 0; })),
      currency:            _mostFrequent(occs.map(function(o) { return String(o.tx.currency           || ''); })),
      tx_location_area:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_area   || ''); })),
      tx_location_city:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_city   || ''); })),
      tx_location_country: _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_country|| ''); })),
      tags:                _mostFrequent(occs.map(function(o) { return String(o.tx.tags              || ''); })),
      confidence:          confidence,
      reason:              'monthly \xb7 usually around the ' + _ordinal(medianDay),
    };

    console.log(fnName + ': surfaced key=' + key + ' confidence=' + confidence);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 2 — recurring_weekly
// Look back 8 ISO weeks (56 days); qualify if ≥ 5 distinct ISO weeks; surface
// if today's day-of-week matches the mode AND no matching transaction today.
// ─────────────────────────────────────────────────────────────────────────────

function _applyRecurringWeekly(outTx, today, map) {
  const fnName  = '_applyRecurringWeekly';
  const cutoff  = new Date(today);
  cutoff.setDate(cutoff.getDate() - 56);
  cutoff.setHours(0, 0, 0, 0);

  const todayDow        = today.getDay();
  const todayDateString = _calendarDateStr(today);

  // Group transactions from the past 8 weeks by key
  const groups = {};
  outTx.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (isNaN(d.getTime()) || d < cutoff) return;
    const key = String(tx.counterparty_name || '') + '|' + String(tx.minor_category || '');
    if (!groups[key]) groups[key] = { tx: tx, occurrences: [] };
    groups[key].occurrences.push({ tx: tx, date: d });
  });

  Object.keys(groups).forEach(function(key) {
    const group = groups[key];
    const occs  = group.occurrences;

    // Count distinct ISO weeks
    const weekSet = {};
    occs.forEach(function(o) {
      weekSet[_isoWeekKey(o.date)] = true;
    });
    const distinctWeeks = Object.keys(weekSet).length;
    if (distinctWeeks < 2) return;

    // Mode day-of-week
    const modeDow = _modeDayOfWeek(occs.map(function(o) { return o.date.getDay(); }));

    // Check no matching transaction today
    const hasToday = occs.some(function(o) {
      return _calendarDateStr(o.date) === todayDateString;
    });
    if (hasToday) return;

    const confidence = Math.min(distinctWeeks / 8, 1);
    const existing   = map[key];
    if (existing && existing.confidence >= confidence) return;

    map[key] = {
      signal:              'recurring_weekly',
      counterparty_name:   String(occs[0].tx.counterparty_name || ''),
      major_category:      _mostFrequent(occs.map(function(o) { return String(o.tx.major_category     || ''); })),
      minor_category:      String(occs[0].tx.minor_category || ''),
      source_account:      _mostFrequent(occs.map(function(o) { return String(o.tx.source_account     || ''); })),
      typical_amount:      _median(occs.map(function(o) { return Number(o.tx.amount) || 0; })),
      currency:            _mostFrequent(occs.map(function(o) { return String(o.tx.currency           || ''); })),
      tx_location_area:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_area   || ''); })),
      tx_location_city:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_city   || ''); })),
      tx_location_country: _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_country|| ''); })),
      tags:                _mostFrequent(occs.map(function(o) { return String(o.tx.tags              || ''); })),
      confidence:          confidence,
      reason:              'weekly \xb7 usually on ' + _SUGGESTION_DAY_NAMES[modeDow],
    };

    console.log(fnName + ': surfaced key=' + key + ' confidence=' + confidence);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 3 — time_of_day
// Look back 8 weeks (56 days); group by (counterparty_name|minor_category|dow|hour_bucket);
// qualify if current dow+hour_bucket matches and ≥ 2 distinct days in group;
// filter counterparties already transacted with today; emit at most 5 suggestions.
// ─────────────────────────────────────────────────────────────────────────────

function _applyTimeOfDay(outTx, today, map) {
  const fnName       = '_applyTimeOfDay';
  const cutoff       = new Date(today);
  cutoff.setDate(cutoff.getDate() - 56);
  cutoff.setHours(0, 0, 0, 0);

  const todayDow        = today.getDay();
  const todayHourBucket = Math.floor(today.getHours() / 2);
  const todayDateString = _calendarDateStr(today);

  // Counterparties already transacted with today
  const transactedTodayCounterparties = {};
  outTx.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (!isNaN(d.getTime()) && _calendarDateStr(d) === todayDateString) {
      transactedTodayCounterparties[String(tx.counterparty_name || '')] = true;
    }
  });

  // Group transactions from last 4 weeks by extended key (including dow + hour_bucket)
  const groups = {};
  outTx.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (isNaN(d.getTime()) || d < cutoff) return;
    const dow        = d.getDay();
    const hourBucket = Math.floor(d.getHours() / 2);
    const extKey = String(tx.counterparty_name || '') + '|' + String(tx.minor_category || '') + '|' + dow + '|' + hourBucket;
    if (!groups[extKey]) groups[extKey] = { tx: tx, dateSet: {}, counterparty_name: String(tx.counterparty_name || ''), minor_category: String(tx.minor_category || ''), dow: dow, occurrences: [] };
    const dateStr = _calendarDateStr(d);
    groups[extKey].dateSet[dateStr] = true;
    groups[extKey].occurrences.push({ tx: tx, date: d });
  });

  // Collect candidates for this signal (at most 2)
  const candidates = [];

  Object.keys(groups).forEach(function(extKey) {
    const group = groups[extKey];
    const dow   = group.dow;
    // Only consider groups matching current dow + hour_bucket
    if (dow !== todayDow) return;
    // Derive hour_bucket from the extKey parts
    const parts      = extKey.split('|');
    const hourBucket = Number(parts[3]);
    if (hourBucket !== todayHourBucket) return;

    const distinctDays = Object.keys(group.dateSet).length;
    if (distinctDays < 2) return;

    // Filter if already transacted today with this counterparty
    if (transactedTodayCounterparties[group.counterparty_name]) return;

    const confidence = Math.min((distinctDays / 4) * 0.6, 0.6);
    const dedupeKey  = group.counterparty_name + '|' + group.minor_category;
    const occs       = group.occurrences;

    candidates.push({
      dedupeKey:           dedupeKey,
      signal:              'time_of_day',
      counterparty_name:   group.counterparty_name,
      major_category:      _mostFrequent(occs.map(function(o) { return String(o.tx.major_category     || ''); })),
      minor_category:      group.minor_category,
      source_account:      _mostFrequent(occs.map(function(o) { return String(o.tx.source_account     || ''); })),
      typical_amount:      _median(occs.map(function(o) { return Number(o.tx.amount) || 0; })),
      currency:            _mostFrequent(occs.map(function(o) { return String(o.tx.currency           || ''); })),
      tx_location_area:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_area   || ''); })),
      tx_location_city:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_city   || ''); })),
      tx_location_country: _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_country|| ''); })),
      tags:                _mostFrequent(occs.map(function(o) { return String(o.tx.tags              || ''); })),
      confidence:          confidence,
      reason:              'often at this time on ' + _SUGGESTION_DAY_NAMES[dow],
    });
  });

  // Sort candidates by confidence and emit at most 5
  candidates.sort(function(a, b) { return b.confidence - a.confidence; });
  let emitted = 0;
  candidates.forEach(function(c) {
    if (emitted >= 5) return;
    const existing = map[c.dedupeKey];
    if (existing && existing.confidence >= c.confidence) return;
    map[c.dedupeKey] = {
      signal:            c.signal,
      counterparty_name: c.counterparty_name,
      major_category:    c.major_category,
      minor_category:    c.minor_category,
      source_account:    c.source_account,
      typical_amount:    c.typical_amount,
      currency:          c.currency,
      confidence:        c.confidence,
      reason:            c.reason,
    };
    console.log(fnName + ': surfaced key=' + c.dedupeKey + ' confidence=' + c.confidence);
    emitted++;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 4 — recent_frequent
// Look back 60 days; qualify counterparties seen ≥ 2 times that have not
// already been surfaced by a stronger signal and have not been transacted
// with today. Confidence = min(count / 15, 0.35) — always lower than the
// recurrence signals so it only fills remaining slots.
// ─────────────────────────────────────────────────────────────────────────────

function _applyRecentFrequent(outTx, today, map) {
  const fnName      = '_applyRecentFrequent';
  const cutoff      = new Date(today);
  cutoff.setDate(cutoff.getDate() - 60);
  cutoff.setHours(0, 0, 0, 0);

  const todayDateString = _calendarDateStr(today);

  // Counterparties already transacted with today
  const transactedToday = {};
  outTx.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (!isNaN(d.getTime()) && _calendarDateStr(d) === todayDateString) {
      transactedToday[String(tx.counterparty_name || '')] = true;
    }
  });

  // Group by key over last 60 days
  const groups = {};
  outTx.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (isNaN(d.getTime()) || d < cutoff) return;
    const key = String(tx.counterparty_name || '') + '|' + String(tx.minor_category || '');
    if (!groups[key]) groups[key] = { tx: tx, occurrences: [] };
    groups[key].occurrences.push({ tx: tx, date: d });
  });

  Object.keys(groups).forEach(function(key) {
    // Skip if already surfaced by a stronger signal
    if (map[key]) return;

    const group = groups[key];
    const occs  = group.occurrences;
    if (occs.length < 2) return;

    // Skip if transacted today
    const cpName = String(occs[0].tx.counterparty_name || '');
    if (transactedToday[cpName]) return;

    const confidence = Math.min(occs.length / 15, 0.35);
    map[key] = {
      signal:              'recent_frequent',
      counterparty_name:   cpName,
      major_category:      _mostFrequent(occs.map(function(o) { return String(o.tx.major_category     || ''); })),
      minor_category:      String(occs[0].tx.minor_category || ''),
      source_account:      _mostFrequent(occs.map(function(o) { return String(o.tx.source_account     || ''); })),
      typical_amount:      _median(occs.map(function(o) { return Number(o.tx.amount) || 0; })),
      currency:            _mostFrequent(occs.map(function(o) { return String(o.tx.currency           || ''); })),
      tx_location_area:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_area   || ''); })),
      tx_location_city:    _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_city   || ''); })),
      tx_location_country: _mostFrequent(occs.map(function(o) { return String(o.tx.tx_location_country|| ''); })),
      tags:                _mostFrequent(occs.map(function(o) { return String(o.tx.tags              || ''); })),
      confidence:          confidence,
      reason:              occs.length + ' times in the last 2 months',
    };

    console.log(fnName + ': surfaced key=' + key + ' confidence=' + confidence);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

// Returns the median of a numeric array (must be non-empty).
function _median(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort(function(a, b) { return a - b; });
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Returns the most frequently occurring string value in an array.
// On ties, returns the first encountered winner.
function _mostFrequent(arr) {
  if (!arr.length) return '';
  const counts = {};
  arr.forEach(function(v) { counts[v] = (counts[v] || 0) + 1; });
  let best = '';
  let max  = 0;
  Object.keys(counts).forEach(function(k) {
    if (counts[k] > max) { max = counts[k]; best = k; }
  });
  return best;
}

// Returns the mode of an array of integer day-of-week values (0–6).
function _modeDayOfWeek(dows) {
  return Number(_mostFrequent(dows.map(function(d) { return String(d); })));
}

// Returns "YYYY-Www" ISO week key for deduplication purposes.
function _isoWeekKey(date) {
  // Copy date, set to nearest Thursday (ISO week definition)
  const d    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day  = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum   = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + weekNum;
}

// Returns "YYYY-MM-DD" string in local time for calendar-date comparisons.
function _calendarDateStr(date) {
  return date.getFullYear() + '-'
    + String(date.getMonth() + 1).padStart(2, '0') + '-'
    + String(date.getDate()).padStart(2, '0');
}

// Returns the English ordinal suffix string for a day number (1→"1st", etc.).
function _ordinal(n) {
  const s = String(n);
  if (n >= 11 && n <= 13) return s + 'th';
  switch (n % 10) {
    case 1:  return s + 'st';
    case 2:  return s + 'nd';
    case 3:  return s + 'rd';
    default: return s + 'th';
  }
}
