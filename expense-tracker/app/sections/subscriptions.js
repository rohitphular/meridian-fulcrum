import { state } from '../core/state.js';
import { el, esc, getSymbol, toBase, exportSubscriptions, openContextMenu, closeContextMenu, syncStatusIcon, recordStatusIcon, parseCsvRow } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const FREQUENCIES = [
  { value: 'weekly',    label: 'Weekly'    },
  { value: 'monthly',   label: 'Monthly'   },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual',    label: 'Annual'    },
];

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
  const types = state.transactionSchema?.types;
  if (types === undefined || types === null || types.length === 0) return `<option value="">— select —</option>`;
  return `<option value="">— select —</option>` +
    types.map(t => {
      const v = typeof t === 'string' ? t : t.value;
      return `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`;
    }).join('');
}

function _majorOpts(txType, selectedVal = '') {
  if (txType === undefined || txType === null || txType === '') return `<option value="">— select type first —</option>`;
  const cats = state.categories.filter(c =>
    c.is_subscription_eligible === true && c.tx_type_key === txType
  );
  const seen = new Map();
  cats.forEach(c => {
    if (!seen.has(c.major_category_key)) {
      const active = cats.some(x => x.major_category_key === c.major_category_key && x.record_status === 'active');
      seen.set(c.major_category_key, { active, label: c.major_category_label });
    }
  });
  return `<option value="">— select —</option>` +
    [...seen.entries()].map(([key, { active, label }]) => {
      const sel = selectedVal === key ? 'selected' : '';
      return active
        ? `<option value="${esc(key)}" ${sel}>${esc(label)}</option>`
        : `<option value="${esc(key)}" ${sel} disabled style="color:var(--muted)">${esc(label)} (archived)</option>`;
    }).join('');
}

function _minorOpts(txType, major, selectedVal = '') {
  if (major === undefined || major === null || major === '') return `<option value="">— select major first —</option>`;
  const cats = state.categories.filter(c =>
    c.is_subscription_eligible === true && c.tx_type_key === txType && c.major_category_key === major
  );
  return `<option value="">— select —</option>` +
    cats.map(c => {
      const sel = selectedVal === c.minor_category_key ? 'selected' : '';
      return c.record_status === 'active'
        ? `<option value="${esc(c.minor_category_key)}" ${sel}>${esc(c.minor_category_label)}</option>`
        : `<option value="${esc(c.minor_category_key)}" ${sel} disabled style="color:var(--muted)">${esc(c.minor_category_label)} (archived)</option>`;
    }).join('');
}

// ── Monthly-cost estimate ─────────────────────────────────────────────────────

function _toMonthly(amount, frequency) {
  const n = parseFloat(amount);
  if (frequency === 'weekly')    return n * 4.33;
  if (frequency === 'monthly')   return n;
  if (frequency === 'quarterly') return n / 3;
  if (frequency === 'annual')    return n / 12;
  return n;
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

  const nameVal        = isEdit ? sub.name             : (p !== null && p !== undefined && p.name !== undefined && p.name !== null ? p.name : '');
  const cpVal          = isEdit ? sub.counterparty_name : (p !== null && p !== undefined && p.counterparty_name !== undefined && p.counterparty_name !== null ? p.counterparty_name : '');
  const amountVal      = isEdit ? sub.subscription_amount_local : (p !== null && p !== undefined && p.amount !== undefined && p.amount !== null ? p.amount : '');
  const freqVal        = isEdit ? sub.frequency         : (p !== null && p !== undefined && p.frequency !== undefined && p.frequency !== null && p.frequency !== '' ? p.frequency : 'monthly');
  const srcAccVal      = isEdit ? sub.source_account    : (p !== null && p !== undefined && p.source_account !== undefined && p.source_account !== null ? p.source_account : '');
  const txTypeVal      = isEdit ? sub.tx_type           : (p !== null && p !== undefined && p.tx_type !== undefined && p.tx_type !== null ? p.tx_type : '');
  const majorVal       = isEdit ? sub.major_category    : (p !== null && p !== undefined && p.major_category !== undefined && p.major_category !== null ? p.major_category : '');
  const minorVal       = isEdit ? sub.minor_category    : (p !== null && p !== undefined && p.minor_category !== undefined && p.minor_category !== null ? p.minor_category : '');
  const tagsVal        = isEdit ? String(sub.tags).replace(/;/g, ', ') : (p !== null && p !== undefined && p.tx_tags !== undefined && p.tx_tags !== null ? String(p.tx_tags).replace(/;/g, ', ') : '');
  const descriptionVal = isEdit ? sub.description       : '';
  const dayVal         = isEdit ? (sub.frequency === 'weekly' ? sub.day_of_week : sub.day_of_month) : '';
  const startDateVal   = isEdit ? sub.subscription_start_date : '';
  const endDateVal     = isEdit ? sub.subscription_end_date   : '';

  const freqOpts = FREQUENCIES.map(f =>
    `<option value="${esc(f.value)}" ${freqVal === f.value ? 'selected' : ''}>${esc(f.label)}</option>`
  ).join('');

  // Active accounts for source account dropdown
  const activeAccounts = state.accounts.filter(a => a.record_status === 'active');
  const accOpts = `<option value="">— select —</option>` +
    activeAccounts.map(a =>
      `<option value="${esc(a.id)}" ${a.id === srcAccVal ? 'selected' : ''}>${esc(a.account_name)} (${esc(a.local_currency)})</option>`
    ).join('');

  const header = isEdit ? `Editing: ${esc(sub.name)}` : 'New subscription';

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
        <input type="number" id="subAmount" min="0.01" step="0.01" placeholder="0.00" value="${esc(String(amountVal))}">
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
        <input type="date" id="subStartDate" value="${esc(String(startDateVal))}">
      </div>
      <div class="field form-grid-span-2">
        <label for="subEndDate">End date</label>
        <input type="date" id="subEndDate" value="${esc(String(endDateVal))}">
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
        <label for="subTags">Tags</label>
        <input type="text" id="subTags" value="${esc(tagsVal)}" placeholder="streaming, entertainment">
      </div>
      <div class="field form-grid-span-4">
        <label for="subDescription">Notes</label>
        <input type="text" id="subDescription" value="${esc(descriptionVal)}" placeholder="Optional note">
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
  if (f.recordStatuses.length < 4) n++;
  if (f.majorCategory !== 'all') n++;
  if (f.frequency !== 'all') n++;
  if (f.search !== undefined && f.search !== null && f.search !== '') n++;
  return n;
}

function _applySubFilters(subs) {
  const f = state.subFilters;
  return subs.filter(s => {
    if (f.recordStatuses.length < 4 && !f.recordStatuses.includes(s.record_status)) return false;
    if (f.majorCategory !== 'all' && s.major_category !== f.majorCategory) return false;
    if (f.frequency !== 'all' && s.frequency !== f.frequency) return false;
    if (f.search !== undefined && f.search !== null && f.search !== '') {
      const q   = f.search.toLowerCase();
      const hay = (s.name + ' ' + (s.counterparty_name !== undefined && s.counterparty_name !== null ? s.counterparty_name : '') + ' ' + (s.description !== undefined && s.description !== null ? s.description : '')).toLowerCase();
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
      const aCcy = (state.accountMap[a.source_account] !== undefined && state.accountMap[a.source_account] !== null) ? state.accountMap[a.source_account].local_currency : '';
      const bCcy = (state.accountMap[b.source_account] !== undefined && state.accountMap[b.source_account] !== null) ? state.accountMap[b.source_account].local_currency : '';
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
          ${['active','inactive','deleted','locked'].map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-sub-filter-rstat="${esc(s)}"${rs.has(s) ? ' checked' : ''}> ${s.charAt(0).toUpperCase() + s.slice(1)}</label>`
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
          ${FREQUENCIES.map(fr => `<option value="${esc(fr.value)}"${f.frequency === fr.value ? ' selected' : ''}>${esc(fr.label)}</option>`).join('')}
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
        <span class="confirm-text">Delete <strong>${esc(sub.name)}</strong>?</span>
        <span style="display:inline-flex;gap:8px;margin-left:16px">
          <button class="btn-link danger" data-action="sub-confirm-delete" data-row="${row}">Yes, delete</button>
          <button class="btn-link" data-action="sub-cancel-delete">Cancel</button>
        </span>
      </td>
    </tr>`;
  }

  const isActive    = sub.record_status === 'active';
  const dotCls      = isActive ? 'sub-status-active' : 'sub-status-paused';
  const subCcy      = (state.accountMap[sub.source_account] !== undefined && state.accountMap[sub.source_account] !== null) ? state.accountMap[sub.source_account].local_currency : '';
  const amtFmt      = `${getSymbol(subCcy)}${parseFloat(sub.subscription_amount_local).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/${_freqShort(sub.frequency)}`;
  const isForeign   = subCcy !== '' && subCcy !== state.quoteCurrency;
  const _baseVal    = isForeign ? toBase(_toMonthly(parseFloat(sub.subscription_amount_local), sub.frequency), subCcy, null) : 0;
  const baseAmt     = isForeign
    ? `<span class="td-base-amt">${!Number.isFinite(_baseVal) ? '—' : `${sym}${_baseVal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo`}</span>`
    : '';

  let nextCell = '—';
  if (isActive && sub.next_payment_date !== undefined && sub.next_payment_date !== null && sub.next_payment_date !== '') {
    const [ny, nm, nd] = sub.next_payment_date.split('-').map(Number);
    const nextDate = new Date(ny, nm - 1, nd);
    const nextFmt  = nextDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((nextDate - today) / 86400000);
    const duePart  = diffDays === 0 ? 'today'
                   : diffDays === 1 ? 'tomorrow'
                   : diffDays  >  0 ? `in ${diffDays}d`
                   : `${Math.abs(diffDays)}d overdue`;
    nextCell = `${esc(nextFmt)} <span class="sub-card-due">(${esc(duePart)})</span>`;
  }

  const _accEntry = state.accountMap[sub.source_account];
  const accName   = (_accEntry !== undefined && _accEntry !== null && _accEntry.account_name !== undefined && _accEntry.account_name !== null) ? _accEntry.account_name : '—';

  return `<tr${isActive ? '' : ' style="opacity:0.6"'}>
    <td><span class="sub-status-dot ${dotCls}">●</span> ${esc(sub.name)}</td>
    <td class="td-truncate" title="${esc(accName)}">${esc(accName)}</td>
    <td class="td-nowrap">${nextCell}</td>
    <td class="td-mono td-nowrap">${esc(amtFmt)}${baseAmt}</td>
    <td style="text-align:right;white-space:nowrap">
      ${recordStatusIcon(sub.record_status)}
      ${syncStatusIcon(sub.sync_status)}
      <button class="tx-menu-trigger" data-action="sub-menu" data-row="${row}" title="Actions">⋮</button>
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

  const total   = state.subscriptions.length;
  const active  = state.subscriptions.filter(s => s.record_status === 'active').length;
  const estMonthly = state.subscriptions
    .filter(s => s.record_status === 'active')
    .reduce((sum, s) => {
      const sCcy = (state.accountMap[s.source_account] !== undefined && state.accountMap[s.source_account] !== null) ? state.accountMap[s.source_account].local_currency : '';
      const v = toBase(_toMonthly(s.subscription_amount_local, s.frequency), sCcy, null);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

  return `
    <div class="summary-grid" style="margin-bottom:20px">
      <div class="summary-card">
        <div class="summary-card-label">Active / Total</div>
        <div class="summary-card-value">${active} / ${total}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Est. monthly cost</div>
        <div class="summary-card-value">${sym}${estMonthly.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      </div>
    </div>
    <p class="field-hint" style="margin-bottom:12px">Amounts converted to ${esc(state.quoteCurrency)}. Quarterly ÷ 3, Annual ÷ 12, Weekly × 4.33.</p>
    <div class="table-wrap acc-table-wrap${state.subDeleteRow !== null ? ' acc-has-active' : ''}">
      <table class="acc-table">
        <thead><tr>
          ${thSort('name', 'Name')}
          <th>Account</th>
          ${thSort('next_payment_date', 'Next payment')}
          ${thSort('amount_base', 'Amount')}
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${subs.map(s => _renderSubRow(s, sym)).join('')}</tbody>
      </table>
    </div>`;
}

let _importParsed    = null;
let _subMenuKey      = null;
let _subImportResult = null;

// ── CSV import ────────────────────────────────────────────────────────────────

function _renderImportPanel() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import subscriptions from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="subImportFile">CSV file</label>
        <input type="file" id="subImportFile" accept=".csv">
        <div class="field-hint">Columns: subscription_name, counterparty_name, subscription_amount_local, frequency, day_of_month, day_of_week, source_account, tx_type, major_category, minor_category, tags, description, subscription_start_date, subscription_end_date</div>
      </div>
    </div>
    <div id="subImportStatus">${_subImportResult !== null ? _subImportResult : ''}</div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="subImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="subImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="subImportError"></div>
  </div>`;
}

function _parseSubscriptionsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { subscriptions: [], errors: ['File is empty.'] };

  const headers = parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const subscriptions = [];
  const errors        = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] !== undefined ? vals[idx] : '').trim(); });

    if (String(row.subscription_name).trim() === '')               { errors.push(`Row ${i + 1}: missing name`);                        continue; }
    if (String(row.subscription_amount_local).trim() === '') { errors.push(`Row ${i + 1}: missing subscription_amount_local`); continue; }
    if (String(row.frequency).trim() === '')                       { errors.push(`Row ${i + 1}: missing frequency`);                     continue; }

    const subscription_amount_local = parseFloat(row.subscription_amount_local);
    if (!Number.isFinite(subscription_amount_local) || subscription_amount_local <= 0) {
      errors.push(`Row ${i + 1}: invalid subscription_amount_local "${row.subscription_amount_local}"`);
      continue;
    }

    subscriptions.push({
      name:              row.subscription_name,
      counterparty_name: row.counterparty_name,
      subscription_amount_local,
      frequency:         row.frequency,
      day_of_month:      row.day_of_month,
      day_of_week:       row.day_of_week,
      source_account:    row.source_account,
      tx_type:           row.tx_type,
      major_category:    row.major_category,
      minor_category:    row.minor_category,
      tags:                    row.tags,
      description:             row.description,
      subscription_start_date: row.subscription_start_date,
      subscription_end_date:   row.subscription_end_date,
    });
  }

  return { subscriptions, errors };
}

function _renderImportStatus(parsed) {
  const { subscriptions, errors } = parsed;
  const errHtml = errors.length
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (subscriptions.length === 0) return errHtml + '<p class="placeholder">No valid rows found.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${subscriptions.length} subscription${subscriptions.length !== 1 ? 's' : ''} ready to import</p>`;
}

async function _submitImport(subscriptions) {
  const btn   = el('subImportConfirm');
  const errEl = el('subImportError');
  if (btn)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl) errEl.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createSubscriptionsBulk({ subscriptions });

    if (!res.ok && (res.results === undefined || res.results === null)) {
      console.warn('[subscriptions] _submitImport failed:', res?.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error !== undefined && res.error !== null ? res.error : '[no error code]');
      if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }

    const created = res.created;
    const skipped = res.skipped;
    const failed  = res.failed;

    if (failed === 0) {
      _importParsed = null;
      state.subImportOpen = false;
      const parts = [];
      if (created) parts.push(`${created} subscription${created !== 1 ? 's' : ''} imported`);
      if (skipped) parts.push(`${skipped} already existed`);
      const msg = parts.length > 0 ? parts.join(' · ') : 'Nothing to import.';
      showMsg(msg);
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      const resultRows = (res.results !== undefined && res.results !== null ? res.results : []).map(r => `
        <tr>
          <td>${esc(r.name)}</td>
          <td>${r.ok
            ? `<span class="badge badge-et-in">created</span>`
            : r.error === 'duplicate_subscription'
              ? `<span class="badge" style="color:var(--muted)">already exists</span>`
              : `<span class="badge badge-et-out">${esc(r.error !== undefined && r.error !== null ? r.error : '[no error code]')}</span>`}
          </td>
        </tr>`).join('');
      _subImportResult = `
        <div style="margin-bottom:8px;font-size:13px">${created} created${skipped ? ` · ${skipped} already existed` : ''} · <span style="color:var(--ember)">${failed} failed</span></div>
        <div class="table-wrap" style="margin-bottom:8px">
          <table class="acc-table">
            <thead><tr><th>Name</th><th>Result</th></tr></thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>`;
      const status = el('subImportStatus');
      if (status) status.innerHTML = _subImportResult;
      _importParsed = null;
      if (btn) { btn.disabled = true; btn.textContent = 'Import'; }
      if (created > 0) { document.dispatchEvent(new CustomEvent('et:reload')); }
      showMsg(`${created} imported · ${skipped} skipped · ${failed} failed`, 'warn');
    }
  } catch (err) {
    console.error('[subscriptions] _submitImport failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
    if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderSubscriptions() {
  _subMenuKey = null;
  const content      = el('subscriptionsContent');
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
    ${_renderTable(filtered)}
  `;

  _attachEvents();
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
    if (state.subImportOpen) {
      state.subImportOpen = false;
      _importParsed = null;
      _subImportResult = null;
    } else {
      state.subImportOpen = true;
      state.subAddOpen    = false;
      state.subEditRow    = null;
      state.subPrefill    = null;
    }
    renderSubscriptions();
  }, { signal });

  el('subImportFile')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file === undefined || file === null) return;
    _subImportResult = null;
    const reader = new FileReader();
    reader.onload = ev => {
      const parsed = _parseSubscriptionsCsv(ev.target.result);
      _importParsed = parsed.subscriptions.length ? parsed.subscriptions : null;
      const status = el('subImportStatus');
      if (status) status.innerHTML = _renderImportStatus(parsed);
      const btn = el('subImportConfirm');
      if (btn) btn.disabled = !_importParsed;
    };
    reader.readAsText(file);
  }, { signal });

  el('subImportConfirm')?.addEventListener('click', () => {
    if (_importParsed) _submitImport(_importParsed);
  }, { signal });

  el('subImportCancel')?.addEventListener('click', () => {
    state.subImportOpen = false;
    _importParsed = null;
    _subImportResult = null;
    renderSubscriptions();
  }, { signal });

  el('subAddBtn')?.addEventListener('click', () => {
    if (state.subAddOpen || state.subEditRow !== null) {
      state.subAddOpen  = false;
      state.subEditRow  = null;
      state.subPrefill  = null;
    } else {
      state.subAddOpen    = true;
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
        if (key === 'edit')   { state.subEditRow = row; state.subAddOpen = false; state.subPrefill = null; renderSubscriptions(); }
        if (key === 'toggle') { _toggle(row); }
        if (key === 'delete') { state.subDeleteRow = row; renderSubscriptions(); }
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
            ? (sub.counterparty_name !== undefined && sub.counterparty_name !== null && String(sub.counterparty_name).trim() !== '' ? sub.counterparty_name : sub.name)
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
    ], key => exportSubscriptions(key, state.subscriptions));
  }, { signal });

  content.querySelectorAll('th[data-sub-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.subSort;
      if (state.subSort.col === col) {
        state.subSort.dir = state.subSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.subSort.col = col;
        state.subSort.dir = col === 'next_payment_date' ? 'asc' : 'desc';
      }
      renderSubscriptions();
    }, { signal });
  });

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
    renderSubscriptions();
  }, { signal });

  el('subFilterClear')?.addEventListener('click', () => {
    state.subFilters = { recordStatuses: ['active','inactive','deleted','locked'], majorCategory: 'all', frequency: 'all', search: '' };
    renderSubscriptions();
  }, { signal });
}

// ── Form collection helper ────────────────────────────────────────────────────

function _collectForm() {
  const freq       = el('subFrequency').value;
  const dayOfWeek  = freq === 'weekly' ? el('subDayOfWeek').value  : '';
  const dayOfMonth = freq !== 'weekly' ? el('subDayOfMonth').value : '';

  return {
    name:              el('subName').value.trim(),
    counterparty_name: el('subCounterparty').value.trim(),
    subscription_amount_local: parseFloat(el('subAmount').value),
    frequency:         freq,
    day_of_week:       dayOfWeek,
    day_of_month:      dayOfMonth,
    source_account:    el('subSourceAccount').value,
    tx_type:           el('subTxType').value,
    major_category:    el('subMajor').value,
    minor_category:    el('subMinor').value,
    tags:                    el('subTags').value.trim(),
    description:             el('subDescription').value.trim(),
    subscription_start_date: el('subStartDate').value,
    subscription_end_date:   el('subEndDate').value,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function _saveAdd() {
  const errEl = el('subFormError');
  if (errEl) errEl.textContent = '';

  const body = _collectForm();

  if (body.name === undefined || body.name === null || String(body.name).trim() === '') {
    if (errEl) errEl.textContent = 'Name is required.';
    return;
  }
  if (!Number.isFinite(body.subscription_amount_local) || body.subscription_amount_local <= 0) {
    if (errEl) errEl.textContent = 'Enter a positive amount.';
    return;
  }
  if (body.source_account === undefined || body.source_account === null || String(body.source_account).trim() === '') {
    if (errEl) errEl.textContent = 'Source account is required.';
    return;
  }

  // FE duplicate check by name
  const norm = body.name.toLowerCase();
  const nameDupe = state.subscriptions.find(s => s.name.toLowerCase() === norm);
  if (nameDupe) {
    if (errEl) errEl.textContent = `A subscription named "${nameDupe.name}" already exists.`;
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

  if (body.name === undefined || body.name === null || String(body.name).trim() === '') {
    if (errEl) errEl.textContent = 'Name is required.';
    return;
  }
  if (!Number.isFinite(body.subscription_amount_local) || body.subscription_amount_local <= 0) {
    if (errEl) errEl.textContent = 'Enter a positive amount.';
    return;
  }
  if (body.source_account === undefined || body.source_account === null || String(body.source_account).trim() === '') {
    if (errEl) errEl.textContent = 'Source account is required.';
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
      row_num:                 row,
      name:                    sub.name,
      counterparty_name:       sub.counterparty_name,
      subscription_amount_local: sub.subscription_amount_local,
      frequency:               sub.frequency,
      day_of_month:            sub.day_of_month,
      day_of_week:             sub.day_of_week,
      source_account:          sub.source_account,
      tx_type:                 sub.tx_type,
      major_category:          sub.major_category,
      minor_category:          sub.minor_category,
      tags:                    sub.tags,
      description:             sub.description,
      subscription_start_date: sub.subscription_start_date,
      subscription_end_date:   sub.subscription_end_date,
      record_status:           newStatus,
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
