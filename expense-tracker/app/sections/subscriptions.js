import { state } from '../core/state.js';
import { el, esc, getSymbol, toBase, exportSubscriptions, openContextMenu, syncStatusIcon, recordStatusIcon } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// ── Constants ─────────────────────────────────────────────────────────────────

function _schemaReady() {
  return ['frequencies', 'tx_types', 'record_statuses'].every(key =>
    Array.isArray(state.subscriptionSchema?.[key]) && state.subscriptionSchema[key].length > 0
  );
}

function _frequencies() {
  return state.subscriptionSchema.frequencies.map(value => ({
    value, label: value.charAt(0).toUpperCase() + value.slice(1),
  }));
}

function _recordStatuses() { return state.subscriptionSchema.record_statuses; }

function _decimalNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return NaN;
  return Number(text);
}

function _dateValid(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function _localTimestamp(value) {
  const text = String(value ?? '').trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + ' 00:00:00';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text + ':00';
  return text;
}

function _timestampValid(value) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?$/.exec(value);
  return match !== null && _dateValid(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60;
}

function _timestampOrder(value) {
  return value.slice(0, 19) + '.' + (value.split('.')[1] ?? '').padEnd(6, '0');
}

function _isScheduled(sub) {
  return sub.record_status === 'active' && ['current', 'upcoming'].includes(sub.schedule_status);
}

function _dueDays(nextDate, timezone, now = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (!_dateValid(nextDate) || !_dateValid(today)) return null;
    return Math.round((Date.parse(nextDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  } catch (_) { return null; }
}

function _dateInputValue(value) {
  // Native datetime inputs support milliseconds; preserve any finer source
  // precision in _collectLocalTimestamp when the displayed value is unchanged.
  return String(value ?? '').replace(' ', 'T').slice(0, 23);
}

function _collectLocalTimestamp(id, key) {
  const value = _localTimestamp(el(id).value);
  const existing = state.subEditRow === null ? undefined : state.subscriptions.find(sub => sub._row === state.subEditRow);
  const original = existing?.[key];
  if (original !== undefined && _timestampOrder(value) === _timestampOrder(_localTimestamp(_dateInputValue(original)))) return _localTimestamp(original);
  return value;
}

function _subscriptionErrors(row) {
  const errors = [];
  const value = key => String(row[key] ?? '').trim();
  for (const field of ['subscription_name', 'subscription_amount_local', 'frequency', 'source_account']) {
    if (value(field) === '') errors.push(`${field} is required`);
  }
  const amount = _decimalNumber(row.subscription_amount_local);
  if (value('subscription_amount_local') !== '' && (!Number.isFinite(amount) || amount <= 0)) {
    errors.push('subscription_amount_local must be a positive finite decimal number');
  }
  if (!state.subscriptionSchema.frequencies.includes(value('frequency'))) errors.push('invalid frequency');
  const dayField = value('frequency') === 'weekly' ? 'day_of_week' : 'day_of_month';
  const day = Number(value(dayField));
  const maxDay = dayField === 'day_of_week' ? 7 : 31;
  if (!/^\d+$/.test(value(dayField)) || !Number.isInteger(day) || day < 1 || day > maxDay) {
    errors.push(`${dayField} must be a whole number from 1 to ${maxDay}`);
  }
  const optionalDay = dayField === 'day_of_week' ? 'day_of_month' : 'day_of_week';
  const optionalMax = optionalDay === 'day_of_week' ? 7 : 31;
  if (value(optionalDay) !== '' && (!/^\d+$/.test(value(optionalDay)) || Number(value(optionalDay)) < 1 || Number(value(optionalDay)) > optionalMax)) {
    errors.push(`${optionalDay} must be a whole number from 1 to ${optionalMax}`);
  }
  if (value('tx_type') !== '' && !state.subscriptionSchema.tx_types.includes(value('tx_type'))) errors.push('invalid tx_type');
  if (value('record_status') !== '' && !_recordStatuses().includes(value('record_status'))) errors.push('invalid record_status');
  const start = value('subscription_start_date_local'), end = value('subscription_end_date_local');
  for (const field of ['subscription_start_date_local', 'subscription_end_date_local']) {
    if (value(field) !== '' && !_timestampValid(value(field))) errors.push(`${field} must be a real local date and time (YYYY-MM-DD HH:MM:SS)`);
  }
  if (start !== '' && end !== '' && _timestampValid(start) && _timestampValid(end) && _timestampOrder(end) < _timestampOrder(start)) errors.push('end date must not precede start date');
  if (['quarterly', 'annual'].includes(value('frequency')) && start === '') errors.push('start date is required to anchor quarterly or annual payments');
  const timezone = value('subscription_timezone_local');
  if ((start !== '' || end !== '') && timezone === '') errors.push('subscription_timezone_local is required when dates are supplied');
  if (timezone !== '') {
    try {
      if (/^[+-]/.test(timezone)) throw new Error('invalid_timezone');
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    }
    catch (_) { errors.push('invalid subscription_timezone_local'); }
  }
  return errors;
}

const DOW_LABELS = [
  { value: '1', label: 'Monday'    },
  { value: '2', label: 'Tuesday'   },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday'  },
  { value: '5', label: 'Friday'    },
  { value: '6', label: 'Saturday'  },
  { value: '7', label: 'Sunday'    },
];

// ── Category helpers ──────────────────────────────────────────────────────────

function _txTypeOpts(selected = '') {
  const types = state.subscriptionSchema?.tx_types;
  if (types === undefined || types === null || types.length === 0) return `<option value="">— select —</option>`;
  return `<option value="">— select —</option>` +
    types.map(t => {
      const v = typeof t === 'string' ? t : t.value;
      return `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`;
    }).join('');
}

function _storedCategoryOption(selectedVal) {
  return selectedVal === undefined || selectedVal === null || selectedVal === '' ? '' :
    `<option value="${esc(selectedVal)}" selected disabled>${esc(selectedVal)} (stored)</option>`;
}

function _majorOpts(txType, selectedVal = '') {
  if (txType === undefined || txType === null || txType === '') {
    return `<option value="">— select type first —</option>` + _storedCategoryOption(selectedVal);
  }
  const cats = state.categories.filter(c =>
    (c.is_subscription_eligible === true || c.major_category_key === selectedVal) && c.tx_type_key === txType
  );
  const seen = new Map();
  cats.forEach(c => {
    if (!seen.has(c.major_category_key)) {
      const active = cats.some(x => x.major_category_key === c.major_category_key && x.record_status === 'active' && x.is_subscription_eligible === true);
      seen.set(c.major_category_key, { active, label: c.major_category_label });
    }
  });
  return `<option value="">— select —</option>` +
    [...seen.entries()].map(([key, { active, label }]) => {
      const sel = selectedVal === key ? 'selected' : '';
      return active
        ? `<option value="${esc(key)}" ${sel}>${esc(label)}</option>`
        : `<option value="${esc(key)}" ${sel} disabled style="color:var(--muted)">${esc(label)} (archived)</option>`;
    }).join('') + (seen.has(selectedVal) ? '' : _storedCategoryOption(selectedVal));
}

function _minorOpts(txType, major, selectedVal = '') {
  if (txType === undefined || txType === null || txType === '' || major === undefined || major === null || major === '') {
    return `<option value="">— select type and major first —</option>` + _storedCategoryOption(selectedVal);
  }
  const cats = state.categories.filter(c =>
    (c.is_subscription_eligible === true || c.minor_category_key === selectedVal) && c.tx_type_key === txType && c.major_category_key === major
  );
  return `<option value="">— select —</option>` +
    cats.map(c => {
      const sel = selectedVal === c.minor_category_key ? 'selected' : '';
      return c.record_status === 'active' && c.is_subscription_eligible === true
        ? `<option value="${esc(c.minor_category_key)}" ${sel}>${esc(c.minor_category_label)}</option>`
        : `<option value="${esc(c.minor_category_key)}" ${sel} disabled style="color:var(--muted)">${esc(c.minor_category_label)} (archived)</option>`;
    }).join('') + (cats.some(c => c.minor_category_key === selectedVal) ? '' : _storedCategoryOption(selectedVal));
}

// ── Monthly-cost estimate ─────────────────────────────────────────────────────

function _toMonthly(amount, frequency) {
  const n = _decimalNumber(amount);
  if (frequency === 'weekly')    return n * 52 / 12;
  if (frequency === 'monthly')   return n;
  if (frequency === 'quarterly') return n / 3;
  if (frequency === 'annual')    return n / 12;
  return NaN;
}

// ── Day field HTML ─────────────────────────────────────────────────────────────

function _dayFieldHtml(frequency, dayVal = '') {
  if (frequency === 'weekly') {
    const opts = DOW_LABELS.map(d =>
      `<option value="${esc(d.value)}" ${String(dayVal) === d.value ? 'selected' : ''}>${esc(d.label)}</option>`
    ).join('');
    return `<label for="subDayOfWeek">Day of week</label><select id="subDayOfWeek">${opts}</select>`;
  }
  return `<label for="subDayOfMonth">Day of month</label>
    <input type="number" id="subDayOfMonth" min="1" max="31" step="1"${dayVal !== '' && dayVal !== null && dayVal !== undefined ? ` value="${esc(String(dayVal))}"` : ''}>`;
}

// ── Form HTML ─────────────────────────────────────────────────────────────────

function _renderForm(sub = null) {
  const p      = state.subPrefill;   // null when opening a fresh form; non-null when subscribing from a tx
  const isEdit = sub !== null;

  const nameVal        = isEdit ? sub.subscription_name : (p !== null && p !== undefined && p.name !== undefined && p.name !== null ? p.name : '');
  const cpVal          = isEdit ? sub.counterparty_name : (p !== null && p !== undefined && p.counterparty_name !== undefined && p.counterparty_name !== null ? p.counterparty_name : '');
  const amountVal      = isEdit ? sub.subscription_amount_local : (p !== null && p !== undefined && p.amount !== undefined && p.amount !== null ? p.amount : '');
  const freqVal        = isEdit ? sub.frequency         : (p !== null && p !== undefined && p.frequency !== undefined && p.frequency !== null && p.frequency !== '' ? p.frequency : 'monthly');
  const srcAccVal      = isEdit ? sub.source_account    : (p !== null && p !== undefined && p.source_account !== undefined && p.source_account !== null ? p.source_account : '');
  const txTypeVal      = isEdit ? sub.tx_type           : (p !== null && p !== undefined && p.tx_type !== undefined && p.tx_type !== null ? p.tx_type : '');
  const majorVal       = isEdit ? sub.major_category    : (p !== null && p !== undefined && p.major_category !== undefined && p.major_category !== null ? p.major_category : '');
  const minorVal       = isEdit ? sub.minor_category    : (p !== null && p !== undefined && p.minor_category !== undefined && p.minor_category !== null ? p.minor_category : '');
  const descriptionVal = isEdit ? sub.description       : '';
  const dayVal         = isEdit ? (sub.frequency === 'weekly' ? sub.day_of_week : sub.day_of_month) : '';
  const startDateVal   = isEdit ? sub.subscription_start_date_local : '';
  const endDateVal     = isEdit ? sub.subscription_end_date_local   : '';
  const timezoneVal    = isEdit ? sub.subscription_timezone_local : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const freqOpts = _frequencies().map(f =>
    `<option value="${esc(f.value)}" ${freqVal === f.value ? 'selected' : ''}>${esc(f.label)}</option>`
  ).join('');

  // Active accounts for source account dropdown
  const activeAccounts = state.accounts.filter(a => a.record_status === 'active' || a.id === srcAccVal);
  const accOpts = `<option value="">— select —</option>` +
    activeAccounts.map(a =>
      `<option value="${esc(a.id)}" ${a.id === srcAccVal ? 'selected' : ''}>${esc(a.account_name)} (${esc(a.account_currency_local)})${a.record_status === 'active' ? '' : ' — ' + esc(a.record_status)}</option>`
    ).join('');

  const header = isEdit ? `Editing: ${esc(sub.subscription_name)}` : 'New subscription';

  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">${header}</div>
    <div class="form-grid form-grid-4">
      <div class="field form-grid-span-4">
        <label for="subName">Name *</label>
        <input type="text" id="subName" value="${esc(nameVal)}" placeholder="Netflix, Spotify, …">
      </div>
      <div class="field form-grid-span-4">
        <label for="subCounterparty">Counterparty name</label>
        <input type="text" id="subCounterparty" value="${esc(cpVal)}" placeholder="Netflix Inc.">
      </div>
      <div class="field form-grid-span-2">
        <label for="subAmount">Amount *</label>
        <input type="number" id="subAmount" min="0" step="any" placeholder="0.00" value="${esc(String(amountVal))}">
      </div>
      <div class="field form-grid-span-2">
        <label for="subFrequency">Frequency *</label>
        <select id="subFrequency">${freqOpts}</select>
      </div>
      <div class="field form-grid-span-2" id="subDayWrap">
        ${_dayFieldHtml(freqVal, dayVal)}
      </div>
      <div class="field form-grid-span-2">
        <label for="subStartDate">Start date</label>
        <input type="datetime-local" step="any" id="subStartDate" value="${esc(_dateInputValue(startDateVal))}">
        <div class="field-hint">Required for quarterly and annual payments; its month anchors the schedule.</div>
      </div>
      <div class="field form-grid-span-2">
        <label for="subEndDate">End date</label>
        <input type="datetime-local" step="any" id="subEndDate" value="${esc(_dateInputValue(endDateVal))}">
      </div>
      <div class="field form-grid-span-2">
        <label for="subTimezone">Timezone</label>
        <input type="text" id="subTimezone" value="${esc(timezoneVal ?? '')}" placeholder="${esc(state.subscriptionSchema.default_timezone ?? '')}">
        <div class="field-hint">Payments follow this timezone. Required when start or end dates are supplied.</div>
      </div>
      <div class="field form-grid-span-2">
        <label for="subSourceAccount">Source account *</label>
        <select id="subSourceAccount">${accOpts}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subTxType">Transaction type</label>
        <select id="subTxType">${_txTypeOpts(txTypeVal)}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subMajor">Major category</label>
        <select id="subMajor">${_majorOpts(txTypeVal, majorVal)}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subMinor">Minor category</label>
        <select id="subMinor">${_minorOpts(txTypeVal, majorVal, minorVal)}</select>
      </div>
      <div class="field form-grid-span-4">
        <label for="subDescription">Notes</label>
        <textarea id="subDescription" placeholder="Optional note">${esc(descriptionVal)}</textarea>
      </div>
    </div>
    <div class="form-actions">
      <button id="subSaveBtn" class="btn btn-primary btn-sm" data-action="sub-save">Save</button>
      <button class="btn btn-secondary btn-sm" data-action="sub-cancel">Cancel</button>
    </div>
    <div class="pin-error" id="subFormError"></div>
  </div>`;
}

// ── Card list ─────────────────────────────────────────────────────────────────

const _FREQ_SHORT = { weekly: 'wk', monthly: 'mo', quarterly: 'qtr', annual: 'yr' };
function _freqShort(f) {
  if (_FREQ_SHORT[f] !== undefined) return _FREQ_SHORT[f];
  if (f !== undefined && f !== null && f !== '') return f;
  return '—';
}

function _subFilterCount() {
  const f = state.subFilters;
  let n = 0;
  if (f.recordStatuses.length < _recordStatuses().length) n++;
  if (f.majorCategory !== 'all') n++;
  if (f.frequency !== 'all') n++;
  if (f.search !== undefined && f.search !== null && f.search !== '') n++;
  return n;
}

function _applySubFilters(subs) {
  const f = state.subFilters;
  return subs.filter(s => {
    if (!f.recordStatuses.includes(s.record_status)) return false;
    if (f.majorCategory !== 'all' && s.major_category !== f.majorCategory) return false;
    if (f.frequency !== 'all' && s.frequency !== f.frequency) return false;
    if (f.search !== undefined && f.search !== null && f.search !== '') {
      const q   = f.search.toLowerCase();
      const hay = ((s.subscription_name !== undefined && s.subscription_name !== null ? s.subscription_name : '') + ' ' + (s.counterparty_name !== undefined && s.counterparty_name !== null ? s.counterparty_name : '') + ' ' + (s.description !== undefined && s.description !== null ? s.description : '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function _sortSubs(subs) {
  const { col, dir } = state.subSort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...subs].sort((a, b) => {
    let va, vb;
    if (col === 'amount_base') {
      const aCcy = (state.accountMap[a.source_account] !== undefined && state.accountMap[a.source_account] !== null) ? state.accountMap[a.source_account].account_currency_local : '';
      const bCcy = (state.accountMap[b.source_account] !== undefined && state.accountMap[b.source_account] !== null) ? state.accountMap[b.source_account].account_currency_local : '';
      va = toBase(_toMonthly(parseFloat(a.subscription_amount_local), a.frequency), aCcy, null);
      vb = toBase(_toMonthly(parseFloat(b.subscription_amount_local), b.frequency), bCcy, null);
      const aIsNaN = !Number.isFinite(va);
      const bIsNaN = !Number.isFinite(vb);
      if (aIsNaN && bIsNaN) return 0;
      if (aIsNaN) return 1;
      if (bIsNaN) return -1;
      return (va - vb) * sign;
    } else if (col === 'next_payment_date') {
      va = (a.next_payment_date !== undefined && a.next_payment_date !== null && a.next_payment_date !== '') ? a.next_payment_date : '9999-12-31';
      vb = (b.next_payment_date !== undefined && b.next_payment_date !== null && b.next_payment_date !== '') ? b.next_payment_date : '9999-12-31';
    } else {
      va = (a[col] !== undefined && a[col] !== null ? String(a[col]) : '').toLowerCase();
      vb = (b[col] !== undefined && b[col] !== null ? String(b[col]) : '').toLowerCase();
    }
    return va < vb ? -sign : va > vb ? sign : 0;
  });
}

function _renderSubFilterBar() {
  const activeCount = _subFilterCount();
  const f = state.subFilters;

  const majors = [...new Set(state.subscriptions.map(s => s.major_category).filter(m => m !== undefined && m !== null && m !== ''))].sort();

  const rs = new Set(f.recordStatuses);
  const optStyle = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="subFilterToggle">
      Filters${activeCount ? ` (${activeCount})` : ''} <span class="filter-arrow">${state.subFilterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${state.subFilterOpen ? '' : 'hidden'}" id="subFilterBody">
      <div class="filter-row">
        <label>Status</label>
        <div style="display:flex;flex-wrap:wrap;gap:12px">
          ${_recordStatuses().map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-sub-filter-rstat="${esc(s)}"${rs.has(s) ? ' checked' : ''}> ${esc(s.charAt(0).toUpperCase() + s.slice(1))}</label>`
          ).join('')}
        </div>
      </div>
      <div class="filter-row">
        <label>Category</label>
        <select id="subFMajor" style="flex:1">
          <option value="all">All categories</option>
          ${majors.map(m => `<option value="${esc(m)}"${f.majorCategory === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
      </div>
      <div class="filter-row">
        <label>Frequency</label>
        <select id="subFFrequency" style="flex:1">
          <option value="all">All</option>
          ${_frequencies().map(fr => `<option value="${esc(fr.value)}"${f.frequency === fr.value ? ' selected' : ''}>${esc(fr.label)}</option>`).join('')}
        </select>
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="subFSearch" placeholder="name, counterparty, notes…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-actions">
        <button class="btn btn-secondary btn-sm" id="subFilterClear">Clear</button>
      </div>
    </div>
  </div>`;
}

function _renderSubRow(sub, sym) {
  const row = sub._row;

  if (state.subDeleteRow === row) {
    return `<tr>
      <td colspan="5">
        <span class="confirm-text">Delete <strong>${esc(sub.subscription_name)}</strong>?</span>
        <span style="display:inline-flex;gap:8px;margin-left:16px">
          <button class="btn-link danger" data-action="sub-confirm-delete" data-row="${esc(row)}">Yes, delete</button>
          <button class="btn-link" data-action="sub-cancel-delete">Cancel</button>
        </span>
      </td>
    </tr>`;
  }

  const isActive    = _isScheduled(sub);
  const subCcy      = (state.accountMap[sub.source_account] !== undefined && state.accountMap[sub.source_account] !== null) ? state.accountMap[sub.source_account].account_currency_local : '';
  const amtFmt      = `${getSymbol(subCcy)}${parseFloat(sub.subscription_amount_local).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/${_freqShort(sub.frequency)}`;
  const isForeign   = subCcy !== '' && subCcy !== state.quoteCurrency;
  const _baseVal    = isForeign ? toBase(_toMonthly(parseFloat(sub.subscription_amount_local), sub.frequency), subCcy, null) : 0;
  const baseAmt     = isForeign
    ? `<span class="td-base-amt">${!Number.isFinite(_baseVal) ? '—' : `${esc(sym)}${esc(_baseVal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}/mo`}</span>`
    : '';

  let nextCell = sub.schedule_status === 'expired' ? 'Expired' : sub.schedule_status === 'invalid' ? 'Invalid schedule' : '—';
  if (isActive && sub.next_payment_date !== undefined && sub.next_payment_date !== null && sub.next_payment_date !== '') {
    const [ny, nm, nd] = sub.next_payment_date.split('-').map(Number);
    const nextDate = new Date(ny, nm - 1, nd);
    const nextFmt  = nextDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const timezone = sub.subscription_timezone_local !== undefined && sub.subscription_timezone_local !== null && sub.subscription_timezone_local !== '' ? sub.subscription_timezone_local : state.subscriptionSchema.default_timezone;
    const diffDays = _dueDays(sub.next_payment_date, timezone);
    const duePart  = diffDays === 0 ? 'today'
                   : diffDays === 1 ? 'tomorrow'
                   : diffDays  >  0 ? `in ${diffDays}d`
                   : `${Math.abs(diffDays)}d overdue`;
    nextCell = esc(nextFmt) + (diffDays === null ? '' : ` <span class="sub-card-due">(${esc(duePart)})</span>`);
  }

  const _accEntry = state.accountMap[sub.source_account];
  const accName   = (_accEntry !== undefined && _accEntry !== null && _accEntry.account_name !== undefined && _accEntry.account_name !== null) ? _accEntry.account_name : '—';

  return `<tr${isActive ? '' : ' style="opacity:0.6"'}>
    <td>${esc(sub.subscription_name)}</td>
    <td class="td-truncate" title="${esc(accName)}">${esc(accName)}</td>
    <td class="td-nowrap">${nextCell}</td>
    <td class="td-mono td-nowrap">${esc(amtFmt)}${baseAmt}</td>
    <td style="text-align:right;white-space:nowrap">
      ${recordStatusIcon(sub.record_status)}
      ${syncStatusIcon(sub.sync_status)}
      <button class="tx-menu-trigger" data-action="sub-menu" data-row="${esc(row)}" title="Actions">⋮</button>
    </td>
  </tr>`;
}

function _renderTable(subs) {
  const sym = getSymbol(state.quoteCurrency);

  const thSort = (col, label, style = '') => {
    const active = state.subSort.col === col;
    const cls    = active ? `sort-${state.subSort.dir}` : '';
    return `<th class="${cls}" data-sub-sort="${esc(col)}"${style ? ` style="${style}"` : ''}>${esc(label)}</th>`;
  };

  if (subs.length === 0) {
    return `<p class="placeholder">No subscriptions match the current filters.</p>`;
  }

  const total = state.subscriptions.length;
  const scheduled = state.subscriptions.filter(_isScheduled);
  let missingRates = 0;
  const estMonthly = scheduled.reduce((sum, sub) => {
    const currency = state.accountMap[sub.source_account]?.account_currency_local ?? '';
    const amount = toBase(_toMonthly(sub.subscription_amount_local, sub.frequency), currency, null);
    if (!Number.isFinite(amount)) { missingRates++; return sum; }
    return sum + amount;
  }, 0);

  return `
    <div class="summary-grid" style="margin-bottom:20px">
      <div class="summary-card">
        <div class="summary-card-label">Scheduled / Total</div>
        <div class="summary-card-value">${scheduled.length} / ${total}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Est. monthly amount</div>
        <div class="summary-card-value">${esc(sym)}${esc(estMonthly.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}${missingRates > 0 ? ' (partial)' : ''}</div>
      </div>
    </div>
    <p class="field-hint" style="margin-bottom:12px">Amounts converted to ${esc(state.quoteCurrency)}. Quarterly ÷ 3, Annual ÷ 12, Weekly × 52 ÷ 12. Includes incoming and outgoing scheduled amounts.${missingRates > 0 ? ` ${missingRates} subscription(s) could not be converted; check account currencies and rates.` : ''}</p>
    <div class="table-wrap acc-table-wrap${state.subDeleteRow !== null ? ' acc-has-active' : ''}">
      <table class="acc-table">
        <thead><tr>
          ${thSort('subscription_name', 'Name')}
          <th>Account</th>
          ${thSort('next_payment_date', 'Next payment')}
          ${thSort('amount_base', 'Amount')}
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${subs.map(s => _renderSubRow(s, sym)).join('')}</tbody>
      </table>
    </div>`;
}

let _importParsed = null;
let _subMenuKey = null;
let _subImportResult = null;
let _subImportBusy = false;
let _subImportRetry = false;
let _subImportRead = 0;

// ── CSV import ────────────────────────────────────────────────────────────────

function _renderImportPanel() {
  return `
  <div class="card">
    <div class="cat-form-header">Import subscriptions from CSV</div>
    <div class="form-grid">
      <div class="field form-grid-span-2">
        <label for="subImportFile">CSV file</label>
        <input type="file" id="subImportFile" accept=".csv"${_subImportBusy ? ' disabled' : ''}>
        <div class="field-hint">Required: subscription_name, subscription_amount_local, frequency, source_account, and the applicable day_of_week or day_of_month. Optional: id, counterparty_name, tx_type, major_category, minor_category, description, record_status, subscription_start_date_local, subscription_end_date_local, subscription_timezone_local. Start date is required for quarterly and annual schedules. Dates require a timezone. Sync and audit columns are accepted; the server manages their values.</div>
      </div>
    </div>
    <div id="subImportStatus">${_subImportResult ?? ''}</div>
    <div class="form-actions">
      <button class="btn btn-primary" id="subImportConfirm"${_subImportBusy || _importParsed === null ? ' disabled' : ''}>${_subImportBusy ? 'Importing…' : _subImportRetry ? 'Retry failed rows' : 'Import'}</button>
      <button class="btn btn-secondary" id="subImportCancel"${_subImportBusy ? ' disabled' : ''}>Close</button>
    </div>
    <div class="pin-error" id="subImportError" role="alert"></div>
  </div>`;
}

// Preserve quoted newlines and physical CSV line numbers in import diagnostics.
function _subscriptionCsvRecords(source) {
  const text = source.replace(/^\uFEFF/, '');
  const records = [];
  let values = [], value = '', quoted = false, closed = false, line = 1, rowLine = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else { value += char; if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) line++; }
    } else if (char === '"' && value === '' && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      values.push(value); value = ''; closed = false;
      if (char !== ',') {
        if (values.some(cell => cell.trim() !== '')) records.push({ values, line: rowLine });
        values = []; line++; rowLine = line;
        if (char === '\r' && text[index + 1] === '\n') index++;
      }
    } else if (closed || char === '"') return { records: [], errors: [`Row ${line}: invalid characters after a quoted CSV field.`] };
    else value += char;
  }
  if (quoted) return { records: [], errors: [`Row ${rowLine}: a quoted CSV field is not closed.`] };
  values.push(value);
  if (values.some(cell => cell.trim() !== '')) records.push({ values, line: rowLine });
  return { records, errors: [] };
}

function _parseSubscriptionsCsv(text) {
  if (!_schemaReady()) return { subscriptions: [], errors: ['Subscription configuration is unavailable. Reload after deploying the updated backend.'] };
  const parsed = _subscriptionCsvRecords(text);
  if (parsed.errors.length > 0) return { subscriptions: [], errors: parsed.errors };
  if (parsed.records.length === 0) return { subscriptions: [], errors: ['File is empty.'] };
  const headers = parsed.records.shift().values.map(header => header.trim().toLowerCase().replace(/\s+/g, '_'));
  if (new Set(headers).size !== headers.length) return { subscriptions: [], errors: ['CSV contains duplicate column headers.'] };
  const required = ['subscription_name', 'subscription_amount_local', 'frequency', 'source_account'];
  const missing = required.filter(header => !headers.includes(header));
  if (missing.length > 0) return { subscriptions: [], errors: [`Missing required headers: ${missing.join(', ')}.`] };
  const subscriptions = [], errors = [], seenIds = new Set();
  const fields = ['id', ...required, 'record_status', 'subscription_timezone_local', 'counterparty_name', 'day_of_month', 'day_of_week',
    'tx_type', 'major_category', 'minor_category', 'description', 'subscription_start_date_local', 'subscription_end_date_local'];
  const acceptedHeaders = new Set([...fields, 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at']);
  const unknown = headers.filter(header => !acceptedHeaders.has(header));
  if (unknown.length > 0) return { subscriptions: [], errors: [`Unknown CSV headers: ${unknown.map(header => header === '' ? '[blank]' : header).join(', ')}.`] };
  for (const record of parsed.records) {
    if (record.values.length !== headers.length) {
      errors.push(`Row ${record.line}: expected ${headers.length} columns, found ${record.values.length}.`);
      continue;
    }
    const row = Object.fromEntries(headers.map((header, index) => [header, record.values[index].trim()]));
    for (const field of ['subscription_start_date_local', 'subscription_end_date_local']) {
      if (row[field] !== undefined) row[field] = _localTimestamp(row[field]);
    }
    const rowErrors = _subscriptionErrors(row);
    for (const field of ['id', 'source_account']) {
      if (row[field] !== undefined && row[field] !== '' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row[field])) rowErrors.push(`${field} must be a UUID`);
    }
    if (row.id !== undefined && row.id !== '') {
      row.id = row.id.toLowerCase();
      if (seenIds.has(row.id)) rowErrors.push('duplicate id in CSV');
      seenIds.add(row.id);
    }
    if (rowErrors.length > 0) {
      errors.push(`Row ${record.line}: ${rowErrors.join('; ')}.`);
      continue;
    }
    const subscription = { csv_row_num: record.line };
    fields.forEach(field => {
      if (row[field] !== undefined && !(row[field] === '' && ['id', 'record_status'].includes(field))) subscription[field] = row[field];
    });
    subscription.source_account = subscription.source_account.toLowerCase();
    subscription.subscription_amount_local = row.subscription_amount_local;
    subscriptions.push(subscription);
  }
  return { subscriptions, errors };
}

function _renderImportStatus({ subscriptions, errors }) {
  if (errors.length > 0) return `<div class="pin-error" role="alert">${errors.map(error => esc(error)).join('<br>')}</div><p class="field-hint">Correct the CSV errors and select the file again before importing.</p>`;
  if (subscriptions.length === 0) return '<p class="placeholder">No rows ready to import.</p>';
  return `<p class="field-hint">${subscriptions.length} subscription${subscriptions.length !== 1 ? 's' : ''} ready to import</p>`;
}

function _refreshImportPanel() {
  const status = el('subImportStatus');
  if (status !== null) status.innerHTML = _subImportResult ?? '';
  const button = el('subImportConfirm');
  if (button !== null) {
    button.disabled = _subImportBusy || _importParsed === null;
    button.textContent = _subImportBusy ? 'Importing…' : _subImportRetry ? 'Retry failed rows' : 'Import';
  }
  for (const id of ['subImportFile', 'subImportCancel', 'subImportBtn', 'subAddBtn']) {
    const node = el(id);
    if (node !== null) node.disabled = _subImportBusy;
  }
}

async function _readSubscriptionImport(file) {
  if (_subImportBusy) return;
  const read = ++_subImportRead;
  _importParsed = null;
  _subImportRetry = false;
  _subImportResult = '<p class="field-hint">Reading CSV…</p>';
  const error = el('subImportError');
  if (error !== null) error.textContent = '';
  _refreshImportPanel();
  try {
    const parsed = _parseSubscriptionsCsv(await file.text());
    if (read !== _subImportRead || !state.subImportOpen) return;
    _importParsed = parsed.errors.length === 0 && parsed.subscriptions.length > 0 ? parsed.subscriptions : null;
    _subImportResult = `<p class="field-hint">${esc(file.name)}</p>` + _renderImportStatus(parsed);
  } catch (_) {
    if (read !== _subImportRead) return;
    _subImportResult = '<p class="pin-error">Unable to read the CSV. Select the file again.</p>';
  }
  _refreshImportPanel();
}

async function _submitImport(subscriptions) {
  if (_subImportBusy || !Array.isArray(subscriptions) || subscriptions.length === 0) return;
  _subImportBusy = true;
  _refreshImportPanel();
  const error = el('subImportError');
  if (error !== null) error.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createSubscriptionsBulk({ subscriptions });
    if (res?.ok === false && typeof res.error === 'string' && (!Array.isArray(res.results) || res.results.length === 0)) {
      const uncertain = res.error === 'request_failed';
      if (uncertain) {
        _importParsed = null;
        document.dispatchEvent(new CustomEvent('et:reload'));
      }
      _subImportResult = `<p class="pin-error" role="alert">Import failed: ${esc(res.error)}${uncertain ? '. Some rows may have been saved. Reload and check before importing again.' : ''}</p>`;
      showMsg('Import failed: ' + res.error, 'warn');
      return;
    }
    const results = res?.results;
    const indexed = Array.isArray(results) ? results.map((result, position) => ({ result, index: result?.index ?? position })) : [];
    if (indexed.length !== subscriptions.length || new Set(indexed.map(item => item.index)).size !== subscriptions.length ||
      indexed.some(({ result, index }) => !Number.isInteger(index) || subscriptions[index] === undefined || typeof result?.ok !== 'boolean')) {
      _importParsed = null;
      _subImportResult = '<p class="pin-error" role="alert">The server returned an incomplete import result. Some rows may have been saved. Reload and check before importing again.</p>';
      document.dispatchEvent(new CustomEvent('et:reload'));
      return;
    }
    const failed = indexed.filter(({ result }) => !result.ok);
    const created = indexed.filter(({ result }) => result.ok && result.action === 'created').length;
    const updated = indexed.filter(({ result }) => result.ok && result.action === 'updated').length;
    const unchanged = indexed.filter(({ result }) => result.ok && result.action === 'unchanged').length;
    const summary = `${created} created · ${updated} updated · ${unchanged} unchanged · ${failed.length} failed`;
    const rows = failed.map(({ result, index }) => {
      const row = subscriptions[index];
      return `<tr><td>${esc(row.csv_row_num ?? index + 2)}</td><td>${esc(row.subscription_name)}</td><td>${esc(result.error ?? 'unknown_error')}</td></tr>`;
    }).join('');
    _subImportResult = `<p class="field-hint">${esc(summary)}</p>` + (rows === '' ? '' :
      `<div class="table-wrap"><table class="acc-table"><thead><tr><th>CSV row</th><th>Name</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    _importParsed = failed.length > 0 ? failed.map(({ index }) => subscriptions[index]) : null;
    _subImportRetry = failed.length > 0;
    state.subImportOpen = true;
    showMsg(summary, failed.length > 0 ? 'warn' : 'success');
    if (created + updated > 0) document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (_) {
    _importParsed = null;
    _subImportRetry = false;
    _subImportResult = '<p class="pin-error" role="alert">Connection error. Some rows may have been saved. Reload and check before importing again.</p>';
    console.warn('[subscriptions] _submitImport: error=connection_error');
    document.dispatchEvent(new CustomEvent('et:reload'));
  } finally {
    _subImportBusy = false;
    _refreshImportPanel();
    hideLoading();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderSubscriptions() {
  _subMenuKey = null;
  const content      = el('subscriptionsContent');
  if (content === null) return;
  if (!_schemaReady()) {
    content.innerHTML = '<p class="pin-error" role="alert">Subscription configuration is unavailable. Reload after deploying the updated backend.</p>';
    return;
  }
  const anyFormOpen  = state.subAddOpen || state.subEditRow !== null;
  const addBtnText   = anyFormOpen ? '× Close' : '+ Add';
  const impBtnText   = state.subImportOpen ? '× Close' : '↑ Import';

  const filtered = _sortSubs(_applySubFilters(state.subscriptions));

  content.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="subImportBtn">${impBtnText}</button>
        <button class="btn btn-secondary btn-sm" id="subExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="subAddBtn">${addBtnText}</button>
      </div>
    </div>
    ${state.subImportOpen ? _renderImportPanel() : ''}
    ${anyFormOpen ? _renderForm(state.subEditRow !== null
      ? (state.subscriptions.find(s => s._row === state.subEditRow) !== undefined ? state.subscriptions.find(s => s._row === state.subEditRow) : null)
      : null) : ''}
    ${_renderSubFilterBar()}
    <div id="subTableResults">${_renderTable(filtered)}</div>
  `;

  _attachEvents();
  _refreshImportPanel();
}

// ── Event attachment ──────────────────────────────────────────────────────────

let _eventsAbort = null;

function _attachEvents() {
  if (_eventsAbort) _eventsAbort.abort();
  _eventsAbort = new AbortController();
  const { signal } = _eventsAbort;

  const content = el('subscriptionsContent');
  if (content === null) return;

  el('subImportBtn')?.addEventListener('click', () => {
    if (_subImportBusy) return;
    _subImportRead++;
    if (state.subImportOpen) {
      state.subImportOpen = false;
      _importParsed = null;
      _subImportResult = null;
    } else {
      state.subImportOpen = true;
      state.subDeleteRow = null;
      state.subAddOpen    = false;
      state.subEditRow    = null;
      state.subPrefill    = null;
    }
    renderSubscriptions();
  }, { signal });

  el('subImportFile')?.addEventListener('change', event => {
    const file = event.target.files[0];
    if (file !== undefined) _readSubscriptionImport(file);
  }, { signal });

  el('subImportConfirm')?.addEventListener('click', () => {
    if (_importParsed !== null) _submitImport(_importParsed);
  }, { signal });

  el('subImportCancel')?.addEventListener('click', () => {
    if (_subImportBusy) return;
    _subImportRead++;
    state.subImportOpen = false;
    _importParsed = null;
    _subImportResult = null;
    renderSubscriptions();
  }, { signal });

  el('subAddBtn')?.addEventListener('click', () => {
    if (_subImportBusy) return;
    _subImportRead++;
    if (state.subAddOpen || state.subEditRow !== null) {
      state.subAddOpen  = false;
      state.subEditRow  = null;
      state.subPrefill  = null;
    } else {
      state.subAddOpen    = true;
      state.subDeleteRow  = null;
      state.subImportOpen = false;
      _importParsed       = null;
    }
    renderSubscriptions();
  }, { signal });

  // Frequency change → re-render just the day field wrapper
  el('subFrequency')?.addEventListener('change', () => {
    const freq = el('subFrequency').value;
    const wrap = el('subDayWrap');
    if (wrap) wrap.innerHTML = _dayFieldHtml(freq, '');
  }, { signal });

  // Transaction type cascade → major → minor
  el('subTxType')?.addEventListener('change', () => {
    const txType  = el('subTxType').value;
    const majorEl = el('subMajor');
    const minorEl = el('subMinor');
    if (majorEl) majorEl.innerHTML = _majorOpts(txType, '');
    if (minorEl) minorEl.innerHTML = _minorOpts(txType, '', '');
  }, { signal });

  el('subMajor')?.addEventListener('change', () => {
    const txType  = el('subTxType').value;
    const major   = el('subMajor').value;
    const minorEl = el('subMinor');
    if (minorEl) minorEl.innerHTML = _minorOpts(txType, major, '');
  }, { signal });

  content.addEventListener('click', e => {
    if (_subImportBusy) return;
    const sort = e.target.closest('th[data-sub-sort]');
    if (sort !== null) {
      const col = sort.dataset.subSort;
      state.subSort.dir = state.subSort.col === col && state.subSort.dir === 'asc' ? 'desc' : 'asc';
      state.subSort.col = col;
      renderSubscriptions();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (btn === null) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row !== undefined ? Number(btn.dataset.row) : null;

    if (action === 'sub-cancel') {
      state.subAddOpen = false;
      state.subEditRow = null;
      state.subPrefill = null;
      renderSubscriptions();
    }
    if (action === 'sub-save') {
      if (state.subEditRow !== null) _saveEdit(state.subEditRow);
      else _saveAdd();
    }
    if (action === 'sub-menu') {
      _subMenuKey = row;
      const sub       = state.subscriptions.find(s => s._row === row);
      const rstat     = sub ? sub.record_status : null;
      const isLocked  = rstat === 'locked';
      const isDeleted = rstat === 'deleted';
      const pauseLabel = rstat === 'active' ? 'Pause' : 'Resume';
      const menuItems = isLocked
        ? [{ key: 'txs', label: 'Transactions' }]
        : isDeleted
          ? [{ key: 'restore', label: 'Restore' }, { key: 'txs', label: 'Transactions' }]
          : [
              { key: 'edit',   label: 'Edit'              },
              { key: 'toggle', label: pauseLabel           },
              { key: 'txs',    label: 'Transactions'      },
              { key: 'delete', label: 'Delete', cls: 'danger' },
            ];
      openContextMenu(btn, menuItems, async key => {
        _subMenuKey = null;
        if (key === 'edit')   { state.subEditRow = row; state.subAddOpen = false; state.subImportOpen = false; state.subDeleteRow = null; state.subPrefill = null; renderSubscriptions(); }
        if (key === 'toggle') { _toggle(row); }
        if (key === 'delete') { state.subDeleteRow = row; state.subAddOpen = false; state.subEditRow = null; renderSubscriptions(); }
        if (key === 'restore') {
          showLoading();
          try {
            const res = await ExpenseAPI.restoreSubscription({ row_num: row });
            if (!res.ok) {
              console.warn('[subscriptions] restore failed:', res?.error);
              showMsg('Restore failed: ' + (res.error !== undefined && res.error !== null ? res.error : '[no error code]'), 'warn');
              return;
            }
            document.dispatchEvent(new CustomEvent('et:reload'));
          } catch (err) {
            console.error('[subscriptions] restore failed:', err);
            showMsg('Connection error.', 'warn');
          } finally {
            hideLoading();
          }
          return;
        }
        if (key === 'txs') {
          const searchTerm = (sub !== null && sub !== undefined)
            ? (sub.counterparty_name !== undefined && sub.counterparty_name !== null && String(sub.counterparty_name).trim() !== '' ? sub.counterparty_name : sub.subscription_name)
            : '';
          state.filters = {
            types: [], accounts: [], major: [], minor: [],
            user_location_country: '', user_location_city: '', user_location_area: '',
            tag: '', search: searchTerm,
          };
          document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
        }
      });
    }
    if (action === 'sub-cancel-delete')  { state.subDeleteRow = null; renderSubscriptions(); }
    if (action === 'sub-confirm-delete') { _confirmDelete(row); }
  }, { signal });

  el('subExportBtn')?.addEventListener('click', () => {
    openContextMenu(el('subExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => exportSubscriptions(key, _sortSubs(_applySubFilters(state.subscriptions))));
  }, { signal });

  el('subFilterToggle')?.addEventListener('click', () => {
    state.subFilterOpen = !state.subFilterOpen;
    const body  = el('subFilterBody');
    const arrow = el('subFilterToggle')?.querySelector('.filter-arrow');
    if (body)  body.classList.toggle('hidden', !state.subFilterOpen);
    if (arrow) arrow.textContent = state.subFilterOpen ? '▲' : '▼';
  }, { signal });

  el('subFilterBody')?.querySelectorAll('[data-sub-filter-rstat]').forEach(cb => {
    cb.addEventListener('change', () => {
      const all = Array.from(el('subFilterBody').querySelectorAll('[data-sub-filter-rstat]:checked'))
        .map(c => c.dataset.subFilterRstat);
      state.subFilters.recordStatuses = all;
      renderSubscriptions();
    }, { signal });
  });

  el('subFMajor')?.addEventListener('change', e => {
    state.subFilters.majorCategory = e.target.value;
    renderSubscriptions();
  }, { signal });

  el('subFFrequency')?.addEventListener('change', e => {
    state.subFilters.frequency = e.target.value;
    renderSubscriptions();
  }, { signal });

  el('subFSearch')?.addEventListener('input', e => {
    state.subFilters.search = e.target.value;
    const table = el('subTableResults');
    if (table !== null) table.innerHTML = _renderTable(_sortSubs(_applySubFilters(state.subscriptions)));
  }, { signal });

  el('subFilterClear')?.addEventListener('click', () => {
    state.subFilters = { recordStatuses: [..._recordStatuses()], majorCategory: 'all', frequency: 'all', search: '' };
    renderSubscriptions();
  }, { signal });
}

// ── Form collection helper ────────────────────────────────────────────────────

function _collectForm() {
  const freq       = el('subFrequency').value;
  const current = state.subEditRow === null ? undefined : state.subscriptions.find(sub => sub._row === state.subEditRow);
  const sameFrequency = current?.frequency === freq;
  const dayOfWeek  = freq === 'weekly' ? el('subDayOfWeek').value : sameFrequency ? current.day_of_week ?? '' : '';
  const dayOfMonth = freq !== 'weekly' ? el('subDayOfMonth').value : sameFrequency ? current.day_of_month ?? '' : '';

  return {
    subscription_name:             el('subName').value.trim(),
    counterparty_name:             el('subCounterparty').value.trim(),
    subscription_amount_local:     el('subAmount').value.trim(),
    frequency:                     freq,
    day_of_week:                   dayOfWeek,
    day_of_month:                  dayOfMonth,
    source_account:                el('subSourceAccount').value,
    tx_type:                       el('subTxType').value,
    major_category:                el('subMajor').value,
    minor_category:                el('subMinor').value,
    description:                   el('subDescription').value.trim(),
    subscription_timezone_local:  el('subTimezone').value.trim(),
    subscription_start_date_local: _collectLocalTimestamp('subStartDate', 'subscription_start_date_local'),
    subscription_end_date_local:   _collectLocalTimestamp('subEndDate', 'subscription_end_date_local'),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function _saveAdd() {
  const errEl = el('subFormError');
  if (errEl) errEl.textContent = '';

  const body = _collectForm();
  const errors = _subscriptionErrors(body);
  if (errors.length > 0) {
    if (errEl) errEl.textContent = errors.join('; ');
    return;
  }

  // FE duplicate check by name
  const norm = body.subscription_name.toLowerCase();
  const nameDupe = state.subscriptions.find(s => s.subscription_name !== undefined && s.subscription_name !== null && s.subscription_name.toLowerCase() === norm && s.record_status !== 'deleted');
  if (nameDupe) {
    if (errEl) errEl.textContent = `A subscription named "${nameDupe.subscription_name}" already exists.`;
    return;
  }

  showLoading();
  const saveBtn = el('subSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await ExpenseAPI.createSubscription(body);
    if (res.ok) {
      showMsg('Subscription added.');
      state.subAddOpen = false;
      state.subPrefill = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else if (res.error === 'duplicate_subscription') {
      console.warn('[subscriptions] _saveAdd failed:', res?.error);
      if (errEl) errEl.textContent = 'A subscription with this name already exists.';
    } else {
      console.warn('[subscriptions] _saveAdd failed:', res?.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error !== undefined && res.error !== null ? res.error : '[no error code]');
    }
  } catch (err) {
    console.error('[subscriptions] _saveAdd failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    hideLoading();
  }
}

async function _saveEdit(row) {
  const errEl = el('subFormError');
  if (errEl) errEl.textContent = '';

  const body = _collectForm();
  const errors = _subscriptionErrors(body);
  if (errors.length > 0) {
    if (errEl) errEl.textContent = errors.join('; ');
    return;
  }

  showLoading();
  const saveBtn = el('subSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await ExpenseAPI.updateSubscription({ ...body, row_num: row });
    if (res.ok) {
      showMsg('Subscription updated.');
      state.subEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _saveEdit failed:', res?.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error !== undefined && res.error !== null ? res.error : '[no error code]');
    }
  } catch (err) {
    console.error('[subscriptions] _saveEdit failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    hideLoading();
  }
}

async function _toggle(row) {
  const sub = state.subscriptions.find(s => s._row === row);
  if (sub === undefined) return;
  const newStatus = sub.record_status === 'active' ? 'inactive' : 'active';
  showLoading();
  try {
    const res = await ExpenseAPI.updateSubscription({
      row_num:                       row,
      record_status:                 newStatus,
    });
    if (res.ok) {
      showMsg(newStatus === 'active' ? 'Subscription resumed.' : 'Subscription paused.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _toggle failed:', res?.error);
      showMsg('Update failed: ' + (res.error !== undefined && res.error !== null ? res.error : '[no error code]'), 'warn');
    }
  } catch (err) {
    console.error('[subscriptions] _toggle failed:', err);
    showMsg('Connection error.', 'warn');
  } finally {
    hideLoading();
  }
}

async function _confirmDelete(row) {
  showLoading();
  try {
    const res = await ExpenseAPI.deleteSubscription({ row_num: row });
    if (res.ok) {
      showMsg('Subscription deleted.');
      state.subDeleteRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _confirmDelete failed:', res?.error);
      showMsg('Delete failed: ' + (res.error !== undefined && res.error !== null ? res.error : '[no error code]'), 'warn');
      state.subDeleteRow = null;
      renderSubscriptions();
    }
  } catch (err) {
    console.error('[subscriptions] _confirmDelete failed:', err);
    showMsg('Connection error.', 'warn');
    state.subDeleteRow = null;
    renderSubscriptions();
  } finally {
    hideLoading();
  }
}
