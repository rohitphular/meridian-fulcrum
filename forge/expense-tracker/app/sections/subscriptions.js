import { state } from '../core/state.js';
import { el, esc, getSymbol, toBase, exportSubscriptions, openContextMenu, closeContextMenu } from '../core/utils.js';
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
  const types = state.transactionSchema?.types ?? ['money-in', 'money-out', 'money-transfer'];
  return `<option value="">— select —</option>` +
    types.map(t => {
      const v = typeof t === 'string' ? t : t.value;
      return `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`;
    }).join('');
}

function _majorOpts(txType, selectedVal = '') {
  if (!txType) return `<option value="">— select type first —</option>`;
  const cats = state.categories.filter(c =>
    c.is_subscription_eligible === true && c.tx_type === txType
  );
  const seen = new Map();
  cats.forEach(c => {
    if (!seen.has(c.major_category)) {
      const active = cats.some(x => x.major_category === c.major_category && x.is_active === true);
      seen.set(c.major_category, active);
    }
  });
  return `<option value="">— select —</option>` +
    [...seen.entries()].map(([label, active]) => {
      const sel = selectedVal === label ? 'selected' : '';
      return active
        ? `<option value="${esc(label)}" ${sel}>${esc(label)}</option>`
        : `<option value="${esc(label)}" ${sel} disabled style="color:var(--muted)">${esc(label)} (archived)</option>`;
    }).join('');
}

function _minorOpts(txType, major, selectedVal = '') {
  if (!major) return `<option value="">— select major first —</option>`;
  const cats = state.categories.filter(c =>
    c.is_subscription_eligible === true && c.tx_type === txType && c.major_category === major
  );
  return `<option value="">— select —</option>` +
    cats.map(c => {
      const sel = selectedVal === c.minor_category ? 'selected' : '';
      return c.is_active === true
        ? `<option value="${esc(c.minor_category)}" ${sel}>${esc(c.minor_category)}</option>`
        : `<option value="${esc(c.minor_category)}" ${sel} disabled style="color:var(--muted)">${esc(c.minor_category)} (archived)</option>`;
    }).join('');
}

// ── Monthly-cost estimate ─────────────────────────────────────────────────────

function _toMonthly(amount, frequency) {
  const n = parseFloat(amount) || 0;
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
    <input type="number" id="subDayOfMonth" min="1" max="31" step="1" value="${esc(String(dayVal || '1'))}">`;
}

// ── Form HTML ─────────────────────────────────────────────────────────────────

function _renderForm(sub = null) {
  const p      = state.subPrefill;   // null when opening a fresh form; non-null when subscribing from a tx
  const isEdit = sub !== null;

  const nameVal        = isEdit ? (sub.name             || '') : (p ? (p.name              ?? 'FAILURE') : '');
  const cpVal          = isEdit ? (sub.counterparty_name || '') : (p ? (p.counterparty_name ?? 'FAILURE') : '');
  const amountVal      = isEdit ? (sub.amount            || '') : (p ? (p.amount            ?? 'FAILURE') : '');
  const currencyVal    = isEdit ? (sub.currency          || '') : (p ? (p.currency          ?? 'FAILURE') : '');
  const freqVal        = isEdit ? (sub.frequency         || 'monthly') : (p ? (p.frequency  ?? 'monthly') : 'monthly');
  const srcAccVal      = isEdit ? (sub.source_account    || '') : (p ? (p.source_account    ?? 'FAILURE') : '');
  const txTypeVal      = isEdit ? (sub.tx_type  || '') : (p ? (p.tx_type  ?? 'FAILURE') : '');
  const majorVal       = isEdit ? (sub.major_category    || '') : (p ? (p.major_category    ?? 'FAILURE') : '');
  const minorVal       = isEdit ? (sub.minor_category    || '') : (p ? (p.minor_category    ?? 'FAILURE') : '');
  const tagsVal        = isEdit ? (String(sub.tags       || '').replace(/;/g, ', ')) : (p ? String(p.tags ?? '').replace(/;/g, ', ') : '');
  const descriptionVal = isEdit ? (sub.description        || '') : '';
  const dayVal         = isEdit ? (sub.day_of_week || sub.day_of_month || '') : '';

  const freqOpts = FREQUENCIES.map(f =>
    `<option value="${esc(f.value)}" ${freqVal === f.value ? 'selected' : ''}>${esc(f.label)}</option>`
  ).join('');

  // Active accounts for source account dropdown
  const activeAccounts = state.accounts.filter(a => a.is_active === true);
  const accOpts = `<option value="">— select —</option>` +
    activeAccounts.map(a =>
      `<option value="${esc(a.id)}" ${a.id === srcAccVal ? 'selected' : ''}>${esc(a.name)} (${esc(a.currency)})</option>`
    ).join('');

  // Currency options — use unique currencies from active accounts plus current value
  const ccySet = new Set(activeAccounts.map(a => a.currency));
  if (currencyVal) ccySet.add(currencyVal);
  const ccyOpts = [...ccySet].map(c =>
    `<option value="${esc(c)}" ${c === currencyVal ? 'selected' : ''}>${esc(c)}</option>`
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
      <div class="field">
        <label for="subAmount">Amount *</label>
        <input type="number" id="subAmount" min="0.01" step="0.01" placeholder="0.00" value="${esc(String(amountVal))}">
      </div>
      <div class="field">
        <label for="subCurrency">Currency *</label>
        <select id="subCurrency">${ccyOpts}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subFrequency">Frequency *</label>
        <select id="subFrequency">${freqOpts}</select>
      </div>
      <div class="field form-grid-span-2" id="subDayWrap">
        ${_dayFieldHtml(freqVal, dayVal)}
      </div>
      <div class="field form-grid-span-2">
        <label for="subSourceAccount">Source account</label>
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
      ${isEdit ? `
      <div class="field form-grid-span-4">
        <label class="field-check">
          <input type="checkbox" id="subIsActive" ${sub.is_active ? 'checked' : ''}> Active
        </label>
      </div>` : ''}
    </div>
    <div class="form-actions">
      <button id="subSaveBtn" class="btn btn-primary btn-sm" data-action="sub-save">Save</button>
      <button class="btn btn-secondary btn-sm" data-action="sub-cancel">Cancel</button>
    </div>
    <div class="pin-error" id="subFormError"></div>
  </div>`;
}

// ── Stats cards ───────────────────────────────────────────────────────────────

function _renderStats() {
  const subs   = state.subscriptions;
  const total  = subs.length;
  const active = subs.filter(s => s.is_active).length;
  const estMonthly = subs
    .filter(s => s.is_active)
    .reduce((sum, s) => {
      const monthly = _toMonthly(s.amount, s.frequency);
      return sum + toBase(monthly, s.currency, null);
    }, 0);

  const sym = getSymbol(state.quoteCurrency);

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
    <p class="field-hint" style="margin-bottom:12px">Amounts converted to ${esc(state.quoteCurrency)}. Quarterly ÷ 3, Annual ÷ 12, Weekly × 4.33.</p>`;
}

// ── Card list ─────────────────────────────────────────────────────────────────

function _freqLabel(f) {
  return FREQUENCIES.find(x => x.value === f)?.label || f || '—';
}

const _FREQ_SHORT = { weekly: 'wk', monthly: 'mo', quarterly: 'qtr', annual: 'yr' };
function _freqShort(f) { return _FREQ_SHORT[f] || f || '—'; }

function _renderSubCard(sub) {
  const row = sub._row;

  if (state.subDeleteRow === row) {
    return `
      <div class="sub-card">
        <span class="confirm-text">Delete <strong>${esc(sub.name)}</strong>?</span>
        <div class="row-actions" style="margin-top:6px">
          <button class="btn-link danger" data-action="sub-confirm-delete" data-row="${row}">Yes, delete</button>
          <button class="btn-link" data-action="sub-cancel-delete">Cancel</button>
        </div>
      </div>`;
  }

  const sym         = getSymbol(sub.currency);
  const amtFmt      = `${sym}${parseFloat(sub.amount || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const freqLabel   = _freqLabel(sub.frequency);
  const dotCls      = sub.is_active ? 'sub-status-active' : 'sub-status-paused';
  const inactiveCls = sub.is_active ? '' : ' sub-card-inactive';

  const metaLine = state.accountMap[sub.source_account]?.name || '';

  let nextLine = '';
  if (sub.is_active && sub.next_payment_date) {
    const nextDate  = new Date(sub.next_payment_date);
    const nextFmt   = nextDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const today     = new Date(); today.setHours(0, 0, 0, 0);
    const diffMs    = nextDate - today;
    const diffDays  = Math.round(diffMs / 86400000);
    const duePart   = diffDays === 0 ? 'today'
                    : diffDays === 1 ? 'tomorrow'
                    : diffDays  >  0 ? `in ${diffDays}d`
                    : `${Math.abs(diffDays)}d overdue`;
    nextLine = `<div class="sub-card-next">Next: ${esc(nextFmt)} <span class="sub-card-due">(${esc(duePart)})</span></div>`;
  }

  const isForeign = sub.currency && sub.currency !== state.quoteCurrency;
  let convertedLine = '';
  if (isForeign) {
    const monthlyBase = toBase(_toMonthly(sub.amount, sub.frequency), sub.currency, null);
    const baseSym     = getSymbol(state.quoteCurrency);
    const baseFmt     = `${baseSym}${monthlyBase.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo`;
    convertedLine     = `<div class="sub-card-converted">${esc(baseFmt)}</div>`;
  }

  return `
    <div class="sub-card${inactiveCls}">
      <div class="sub-card-body">
        <div class="sub-card-name"><span class="sub-status-dot ${dotCls}">●</span> ${esc(sub.name)}</div>
        ${metaLine ? `<div class="sub-card-meta">${esc(metaLine)}</div>` : ''}
        ${nextLine}
      </div>
      <div class="sub-card-amt-wrap">
        <div class="sub-card-amt">${esc(amtFmt)}/${esc(_freqShort(sub.frequency))}</div>
        ${convertedLine}
      </div>
      <button class="tx-menu-trigger" data-action="sub-menu" data-row="${row}" title="Actions">⋮</button>
    </div>`;
}

function _renderCards() {
  const subs = state.subscriptions;
  if (!subs.length) {
    return `<div class="empty-state"><strong>No subscriptions yet</strong>Add your first recurring subscription above.</div>`;
  }

  // Sort: active by next_payment_date asc, then amount desc; inactive to bottom by amount desc
  const sorted = [...subs].sort((a, b) => {
    const aActive = a.is_active;
    const bActive = b.is_active;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) {
      const aDate = a.next_payment_date || '9999-12-31';
      const bDate = b.next_payment_date || '9999-12-31';
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    }
    return parseFloat(b.amount || 0) - parseFloat(a.amount || 0);
  });

  // Group by major_category; ungrouped subs fall into 'Uncategorised' at the end
  const groupMap = new Map();
  sorted.forEach(s => {
    const key = s.major_category || 'Uncategorised';
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(s);
  });

  const sym = getSymbol(state.quoteCurrency);

  return [...groupMap.entries()].map(([groupName, groupSubs]) => {
    const monthlyTotal = groupSubs
      .filter(s => s.is_active)
      .reduce((sum, s) => sum + toBase(_toMonthly(s.amount, s.frequency), s.currency, null), 0);
    const totalFmt = monthlyTotal > 0
      ? `${sym}${monthlyTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo`
      : '';

    return `
      <div class="sub-group">
        <div class="sub-group-header">
          <span class="sub-group-name">${esc(groupName)}</span>
          ${totalFmt ? `<span class="sub-group-total">${esc(totalFmt)}</span>` : ''}
        </div>
        <div class="sub-list">${groupSubs.map(_renderSubCard).join('')}</div>
      </div>`;
  }).join('');
}

let _importParsed = null;
let _subMenuKey   = null;

// ── CSV import ────────────────────────────────────────────────────────────────

function _renderImportPanel() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import subscriptions from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="subImportFile">CSV file</label>
        <input type="file" id="subImportFile" accept=".csv">
        <div class="field-hint">Columns: name, counterparty_name, amount, currency, frequency, day_of_month, day_of_week, source_account, tx_type, major_category, minor_category, tags, is_active, description</div>
      </div>
    </div>
    <div id="subImportStatus"></div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="subImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="subImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="subImportError"></div>
  </div>`;
}

function _parseCsvRow(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

function _parseSubscriptionsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { subscriptions: [], errors: ['File is empty.'] };

  const headers = _parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const subscriptions = [];
  const errors        = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = _parseCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });

    if (!row.name)      { errors.push(`Row ${i + 1}: missing name`);      continue; }
    if (!row.amount)    { errors.push(`Row ${i + 1}: missing amount`);    continue; }
    if (!row.currency)  { errors.push(`Row ${i + 1}: missing currency`);  continue; }
    if (!row.frequency) { errors.push(`Row ${i + 1}: missing frequency`); continue; }

    const amount = parseFloat(row.amount);
    if (isNaN(amount) || amount <= 0) {
      errors.push(`Row ${i + 1}: invalid amount "${row.amount}"`);
      continue;
    }

    subscriptions.push({
      name:              row.name,
      counterparty_name: row.counterparty_name || '',
      amount,
      currency:          row.currency.toUpperCase(),
      frequency:         row.frequency,
      day_of_month:      row.day_of_month || '',
      day_of_week:       row.day_of_week  || '',
      source_account:    row.source_account || '',
      tx_type:           row.tx_type        || '',
      major_category:    row.major_category  || '',
      minor_category:    row.minor_category  || '',
      tags:              row.tags            || '',
      is_active:         row.is_active !== 'false' && row.is_active !== 'FALSE',
      description:       row.description     || '',
    });
  }

  return { subscriptions, errors };
}

function _renderImportStatus(parsed) {
  const { subscriptions, errors } = parsed;
  const errHtml = errors.length
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (!subscriptions.length) return errHtml + '<p class="placeholder">No valid rows found.</p>';
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

    if (!res.ok && !res.results) {
      console.warn('[subscriptions] _submitImport failed:', res?.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error || 'unknown');
      if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }

    const created = res.created || 0;
    const skipped = res.skipped || 0;
    const failed  = res.failed  || 0;

    if (failed === 0) {
      _importParsed = null;
      state.subImportOpen = false;
      const msg = [
        created ? `${created} subscription${created !== 1 ? 's' : ''} imported` : '',
        skipped ? `${skipped} already existed` : '',
      ].filter(Boolean).join(' · ');
      showMsg(msg || 'Nothing to import.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      const resultRows = (res.results || []).map(r => `
        <tr>
          <td>${esc(r.name)}</td>
          <td>${r.ok
            ? `<span class="badge badge-et-in">created</span>`
            : r.error === 'duplicate_subscription'
              ? `<span class="badge" style="color:var(--muted)">already exists</span>`
              : `<span class="badge badge-et-out">${esc(r.error || 'unknown')}</span>`}
          </td>
        </tr>`).join('');
      const status = el('subImportStatus');
      if (status) status.innerHTML = `
        <div style="margin-bottom:8px;font-size:13px">${created} created${skipped ? ` · ${skipped} already existed` : ''} · <span style="color:var(--ember)">${failed} failed</span></div>
        <div class="table-wrap" style="margin-bottom:8px">
          <table class="acc-table">
            <thead><tr><th>Name</th><th>Result</th></tr></thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>`;
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
      ? state.subscriptions.find(s => s._row === state.subEditRow) || null
      : null) : ''}
    ${_renderStats()}
    ${_renderCards()}
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
  if (!content) return;

  el('subImportBtn')?.addEventListener('click', () => {
    if (state.subImportOpen) {
      state.subImportOpen = false;
      _importParsed = null;
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
    if (!file) return;
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
    const txType  = el('subTxType')?.value || '';
    const major   = el('subMajor').value;
    const minorEl = el('subMinor');
    if (minorEl) minorEl.innerHTML = _minorOpts(txType, major, '');
  }, { signal });

  content.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
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
      if (_subMenuKey === row) {
        closeContextMenu();
        _subMenuKey = null;
        return;
      }
      _subMenuKey = row;
      const sub = state.subscriptions.find(s => s._row === row);
      const pauseLabel = sub?.is_active ? 'Pause' : 'Resume';
      openContextMenu(btn, [
        { key: 'edit',   label: 'Edit'              },
        { key: 'toggle', label: pauseLabel           },
        { key: 'txs',    label: 'Transactions'      },
        { key: 'delete', label: 'Delete', cls: 'danger' },
      ], key => {
        _subMenuKey = null;
        if (key === 'edit')   { state.subEditRow = row; state.subAddOpen = false; state.subPrefill = null; renderSubscriptions(); }
        if (key === 'toggle') { _toggle(row); }
        if (key === 'delete') { state.subDeleteRow = row; renderSubscriptions(); }
        if (key === 'txs') {
          const searchTerm = sub?.counterparty_name || sub?.name || '';
          state.filters = { types: [], accounts: [], major: [], minor: [], tx_location_country: '', tag: '', search: searchTerm };
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
}

// ── Form collection helper ────────────────────────────────────────────────────

function _collectForm() {
  const freq = el('subFrequency')?.value || 'monthly';
  const dayOfWeek  = freq === 'weekly'  ? (el('subDayOfWeek')?.value  || '') : '';
  const dayOfMonth = freq !== 'weekly'  ? (el('subDayOfMonth')?.value || '') : '';

  return {
    name:              (el('subName')?.value          || '').trim(),
    counterparty_name: (el('subCounterparty')?.value  || '').trim(),
    amount:            parseFloat(el('subAmount')?.value || '0'),
    currency:          el('subCurrency')?.value        || '',
    frequency:         freq,
    day_of_week:       dayOfWeek,
    day_of_month:      dayOfMonth,
    source_account:    el('subSourceAccount')?.value   || '',
    tx_type:           el('subTxType')?.value          || '',
    major_category:    el('subMajor')?.value           || '',
    minor_category:    el('subMinor')?.value           || '',
    tags:              (el('subTags')?.value           || '').trim(),
    description:       (el('subDescription')?.value     || '').trim(),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function _saveAdd() {
  const errEl = el('subFormError');
  if (errEl) errEl.textContent = '';

  const body = _collectForm();

  if (!body.name) {
    if (errEl) errEl.textContent = 'Name is required.';
    return;
  }
  if (!body.amount || body.amount <= 0) {
    if (errEl) errEl.textContent = 'Enter a positive amount.';
    return;
  }
  if (!body.currency) {
    if (errEl) errEl.textContent = 'Currency is required.';
    return;
  }

  // FE duplicate check by name
  const norm = body.name.toLowerCase();
  const nameDupe = state.subscriptions.find(s => (s.name || '').toLowerCase() === norm);
  if (nameDupe) {
    if (errEl) errEl.textContent = `A subscription named "${nameDupe.name}" already exists.`;
    return;
  }

  showLoading();
  const saveBtn = el('subSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await ExpenseAPI.createSubscription({ ...body, is_active: true });
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
      if (errEl) errEl.textContent = 'Error: ' + (res.error || 'unknown');
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

  if (!body.name) {
    if (errEl) errEl.textContent = 'Name is required.';
    return;
  }
  if (!body.amount || body.amount <= 0) {
    if (errEl) errEl.textContent = 'Enter a positive amount.';
    return;
  }
  if (!body.currency) {
    if (errEl) errEl.textContent = 'Currency is required.';
    return;
  }

  const isActive = el('subIsActive')?.checked ?? true;

  showLoading();
  const saveBtn = el('subSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await ExpenseAPI.updateSubscription({ ...body, row_num: row, is_active: isActive });
    if (res.ok) {
      showMsg('Subscription updated.');
      state.subEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _saveEdit failed:', res?.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error || 'unknown');
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
  if (!sub) return;
  const newActive = !sub.is_active;
  showLoading();
  try {
    const res = await ExpenseAPI.updateSubscription({
      row_num:          row,
      name:             sub.name,
      counterparty_name: sub.counterparty_name || '',
      amount:           sub.amount,
      currency:         sub.currency,
      frequency:        sub.frequency,
      day_of_month:     sub.day_of_month || '',
      day_of_week:      sub.day_of_week  || '',
      source_account:   sub.source_account || '',
      tx_type:          sub.tx_type || '',
      major_category:   sub.major_category || '',
      minor_category:   sub.minor_category || '',
      tags:             sub.tags || '',
      description:      sub.description || '',
      is_active:        newActive,
    });
    if (res.ok) {
      showMsg(newActive ? 'Subscription resumed.' : 'Subscription paused.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _toggle failed:', res?.error);
      showMsg('Update failed: ' + (res.error || 'unknown'), 'warn');
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
      showMsg('Delete failed: ' + (res.error || 'unknown'), 'warn');
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
