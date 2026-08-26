import { state } from '../core/state.js';
import { el, esc, fmtDateTime, fmtDateTimeCompact, fmtNative, fmtBase, nowLocalISO, toDateInputVal, exportData, getSymbol, localToUtcISO, utcToLocalInput, openContextMenu, closeContextMenu } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { filteredTx } from '../core/daterange.js';
import { ExpenseAPI } from '../core/api.js';

const SUGGESTIONS_CACHE_KEY = 'et_suggestions_v1';
const SUGGESTIONS_TTL_MS    = 6 * 60 * 60 * 1000;

const METADATA_CACHE_KEY = 'et_metadata_v1';
const METADATA_TTL_MS    = 6 * 60 * 60 * 1000;

let filterOpen      = false;
let _txImportParsed = null;
let _txMenuKey      = null;
let _txEventsAbort  = null;
let _accTypeSel = new Set(); // "type:subtype" keys e.g. "asset:current"

function _dispatchTxAction(action, row) {
  if (action === 'tx-view')           { state.txViewRow = row; state.txEditRow = null; state.txDeleteRow = null; state.txAddOpen = false; renderTransactions(); }
  if (action === 'tx-cancel-view')    { state.txViewRow = null; renderTransactions(); }
  if (action === 'tx-edit')           { state.txEditRow = row; state.txDeleteRow = null; state.txViewRow = null; state.txAddOpen = false; renderTransactions(); }
  if (action === 'tx-cancel-edit')    { state.txEditRow = null; renderTransactions(); }
  if (action === 'tx-save-edit')      { _saveEdit(); }
  if (action === 'tx-delete')         { state.txDeleteRow = row; state.txEditRow = null; state.txViewRow = null; renderTransactions(); }
  if (action === 'tx-cancel-delete')  { state.txDeleteRow = null; renderTransactions(); }
  if (action === 'tx-confirm-delete') { _confirmDelete(row); }
  if (action === 'tx-copy') {
    const tx = state.transactions.find(t => t._row === row);
    if (!tx) return;
    state.txCopyPrefill = {
      tx_type:              tx.tx_type              || '',
      major_category:       tx.major_category       || '',
      minor_category:       tx.minor_category       || '',
      source_account:       tx.source_account       || '',
      target_account:       tx.target_account       || '',
      amount:               tx.amount,
      counterparty_name:    tx.counterparty_name    || '',
      user_location_area:     tx.user_location_area     || '',
      user_location_city:     tx.user_location_city     || '',
      user_location_country:  tx.user_location_country  || '',
      tx_tags:              tx.tx_tags              || '',
      description:          tx.description          || '',
    };
    state.txAddOpen   = true;
    state.txEditRow   = null;
    state.txViewRow   = null;
    state.txDeleteRow = null;
    renderTransactions();
  }
  if (action === 'tx-mark-sub') {
    const tx = state.transactions.find(t => t._row === row);
    if (!tx) return;
    if (_isAlreadySubscribed(tx)) { showMsg('Already tracked as a subscription.', 'warn'); return; }
    state.subPrefill = {
      name:              tx.counterparty_name || '',
      counterparty_name: tx.counterparty_name || '',
      amount:            tx.amount,
      currency:          tx.currency,
      source_account:    tx.source_account,
      tx_type:           tx.tx_type || '',
      major_category:    tx.major_category || '',
      minor_category:    tx.minor_category || '',
      tx_tags:           tx.tx_tags || '',
    };
    state.subAddOpen = true;
    document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'subscriptions' }));
  }
}

// ── Category dropdown helpers — respect is_active (greyed-out when archived) ──

// Major <option> list for a transaction type.
// A major is active if at least one of its minors is active.
function _catMajorOpts(type, selectedVal = '') {
  const cats = state.categories.filter(c => c.tx_type === type);
  const majors = [...new Map(cats.map(c => {
    const active = cats.some(x => x.major_category === c.major_category && x.is_active === true);
    return [c.major_category, { label: c.major_category, active }];
  })).values()];
  return `<option value="">— select —</option>` +
    majors.map(({ label, active }) => {
      const sel = selectedVal === label ? 'selected' : '';
      return active
        ? `<option value="${esc(label)}" ${sel}>${esc(label)}</option>`
        : `<option value="${esc(label)}" ${sel} disabled style="color:var(--muted)">${esc(label)} (archived)</option>`;
    }).join('');
}

// Minor <option> list for a type + major combo.
function _catMinorOpts(type, major, selectedVal = '') {
  const cats = state.categories.filter(c => c.tx_type === type && c.major_category === major);
  return `<option value="">— select —</option>` +
    cats.map(c => {
      const sel = selectedVal === c.minor_category ? 'selected' : '';
      return c.is_active === true
        ? `<option value="${esc(c.minor_category)}" ${sel}>${esc(c.minor_category)}</option>`
        : `<option value="${esc(c.minor_category)}" ${sel} disabled style="color:var(--muted)">${esc(c.minor_category)} (archived)</option>`;
    }).join('');
}

// ── Account dropdown helpers — filter by category source/dest account types ──

function _getCat(type, major, minor) {
  if (!type || !major || !minor) return null;
  return state.categories.find(c =>
    c.tx_type        === type &&
    c.major_category === major &&
    c.minor_category === minor
  ) || null;
}

// ── Subscription eligibility helpers ─────────────────────────────────────────

function _isCatSubEligible(tx) {
  if (!tx.major_category || !tx.minor_category) return false;
  const cat = state.categories.find(c =>
    c.tx_type        === tx.tx_type &&
    c.major_category === tx.major_category &&
    c.minor_category === tx.minor_category
  );
  return cat?.is_subscription_eligible === true;
}

function _normTags(str) {
  return new Set(
    String(str || '').split(';').map(t => t.trim().toLowerCase()).filter(Boolean)
  );
}

function _isAlreadySubscribed(tx) {
  const normCp = (tx.counterparty_name || '').trim().toLowerCase();
  if (!normCp) return false;
  const txTags = _normTags(tx.tx_tags);
  return state.subscriptions.some(s => {
    const sCp = (s.counterparty_name || '').trim().toLowerCase();
    if (sCp !== normCp) return false;
    const sTags = _normTags(s.tx_tags);
    // Match if both have no tags, OR at least one tag overlaps
    return (txTags.size === 0 && sTags.size === 0) || [...txTags].some(t => sTags.has(t));
  });
}

// Returns <option> elements filtered to allowedTypesStr account types.
// Shows all accounts when no types are configured for the category.
function _acctOptsWithHints(accounts, allowedTypesStr, selectedId = '') {
  const allowed = allowedTypesStr
    ? new Set(allowedTypesStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
    : new Set();
  const filtered = allowed.size
    ? accounts.filter(a => allowed.has((a.type || '').toLowerCase()))
    : accounts;
  return filtered.map(a =>
    `<option value="${esc(a.id)}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)} (${esc(a.currency)})</option>`
  ).join('');
}

// ── Transaction schema helpers ────────────────────────────────────────────────

function _txTypes() {
  return state.transactionSchema?.types || [
    { value: 'money-in',       label: 'Money In'  },
    { value: 'money-out',      label: 'Money Out' },
    { value: 'money-transfer', label: 'Transfer'  },
  ];
}
function _txTypeMap() {
  return Object.fromEntries(_txTypes().map(t => [t.value, t.label]));
}

export function renderTransactions() {
  _txMenuKey = null;

  // Load suggestions: serve from localStorage cache (6 h TTL), else fetch from API.
  if (!state.suggestionsLoaded) {
    state.suggestionsLoaded = true;
    let servedFromCache = false;
    try {
      const raw = localStorage.getItem(SUGGESTIONS_CACHE_KEY);
      if (raw) {
        const { suggestions, ts } = JSON.parse(raw);
        if (Array.isArray(suggestions) && Date.now() - ts < SUGGESTIONS_TTL_MS) {
          state.suggestions = suggestions;
          servedFromCache = true;
        } else {
          localStorage.removeItem(SUGGESTIONS_CACHE_KEY);
        }
      }
    } catch (_) {}

    if (!servedFromCache) {
      state.suggestionsFetching = true;
      ExpenseAPI.getSuggestedTransactions().then(res => {
        state.suggestionsFetching = false;
        if (res.ok) {
          state.suggestions = res.suggestions || [];
          try {
            localStorage.setItem(SUGGESTIONS_CACHE_KEY, JSON.stringify({ suggestions: state.suggestions, ts: Date.now() }));
          } catch (_) {}
        }
        renderTransactions();
      }).catch(() => {
        state.suggestionsFetching = false;
        renderTransactions();
      });
    }
  }

  // Load transaction metadata for datalist suggestions (6 h cache).
  if (!state.metadataLoaded) {
    state.metadataLoaded = true;
    let metaFromCache = false;
    try {
      const raw = localStorage.getItem(METADATA_CACHE_KEY);
      if (raw) {
        const { metadata, ts } = JSON.parse(raw);
        if (metadata && Date.now() - ts < METADATA_TTL_MS) {
          state.metadata = metadata;
          metaFromCache = true;
        } else {
          localStorage.removeItem(METADATA_CACHE_KEY);
        }
      }
    } catch (_) {}

    if (!metaFromCache) {
      ExpenseAPI.getTransactionMetadata().then(res => {
        if (res.ok) {
          state.metadata = {
            countries:      res.countries      || [],
            cities:         res.cities         || [],
            areas:          res.areas          || [],
            counterparties: res.counterparties || [],
            tags:           res.tx_tags           || [],
          };
          try {
            localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify({ metadata: state.metadata, ts: Date.now() }));
          } catch (_) {}
        }
      }).catch(() => {});
    }
  }

  const txEl = el('transactionsContent');
  const rows = filteredTx();

  const _rawTypes   = state.transactionSchema?.types ?? [];
  const _validTypes = new Set(_rawTypes.length
    ? _rawTypes.map(t => (typeof t === 'string' ? t : t.value))
    : ['money-in', 'money-out', 'money-transfer']);
  const validRows = rows.filter(tx =>  tx.id && tx.tx_date_time && _validTypes.has(tx.tx_type));
  const warnRows  = rows.filter(tx => !tx.id || !tx.tx_date_time || !_validTypes.has(tx.tx_type));

  const viewTx     = state.txViewRow !== null ? validRows.find(tx => tx._row === state.txViewRow) : null;
  const editTx     = state.txEditRow !== null ? validRows.find(tx => tx._row === state.txEditRow) : null;
  const anyAddOpen = state.txAddOpen || viewTx !== null || editTx !== null;

  txEl.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="txImportBtn">${state.txImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-secondary btn-sm" id="txExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="txAddBtn">${anyAddOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.txImportOpen ? _renderTxImportPanel()        : ''}
    ${state.txAddOpen    ? _renderAddForm()              : ''}
    ${viewTx             ? _renderTxForm(viewTx, 'view') : ''}
    ${editTx             ? _renderTxForm(editTx, 'edit') : ''}
    ${_renderSuggestionsPanel()}
    ${_renderFilterBar()}
    ${warnRows.length ? `<div class="warning-count" id="warnToggle">⚠ ${warnRows.length} row${warnRows.length > 1 ? 's' : ''} have warnings — click to expand</div>` : ''}
    ${_renderTxTable(validRows, warnRows)}
  `;

  el('txImportBtn')?.addEventListener('click', () => {
    if (state.txImportOpen) {
      state.txImportOpen = false;
      _txImportParsed = null;
    } else {
      state.txImportOpen = true;
      state.txAddOpen = false;
      state.txViewRow = null;
      state.txEditRow = null;
    }
    renderTransactions();
  });

  el('txAddBtn')?.addEventListener('click', () => {
    if (anyAddOpen) {
      state.txAddOpen = false;
      state.txViewRow = null;
      state.txEditRow = null;
    } else {
      state.txAddOpen = true;
      state.txImportOpen = false;
      _txImportParsed = null;
    }
    renderTransactions();
  });

  el('txImportFile')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const parsed = _parseTxCsv(ev.target.result);
      _txImportParsed = parsed.transactions.length && !parsed.errors.length ? parsed.transactions : null;
      const status = el('txImportStatus');
      if (status) status.innerHTML = _renderTxImportStatus(parsed);
      const btn = el('txImportConfirm');
      if (btn) btn.disabled = !_txImportParsed;
    };
    reader.readAsText(file);
  });

  el('txImportConfirm')?.addEventListener('click', () => {
    if (_txImportParsed) _submitTxImport(_txImportParsed);
  });

  el('txImportCancel')?.addEventListener('click', () => {
    state.txImportOpen = false;
    _txImportParsed = null;
    renderTransactions();
  });

  _attachSuggestionEvents();
  _attachFilterEvents();
  if (state.txAddOpen) _attachAddFormEvents();
  if (editTx) _attachTxEditCascadeEvents();
  _attachEvents();

  el('txExportBtn')?.addEventListener('click', () => {
    openContextMenu(el('txExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => exportData(key, rows));
  });

  if (warnRows.length) {
    el('warnToggle')?.addEventListener('click', () => el('warnTable')?.classList.toggle('hidden'));
  }
}

function _syncBadgeClass(status) {
  if (status === 'in-sync')      return 'success';
  if (status === 'sync-failure') return 'danger';
  return 'muted';
}

function _renderTxTable(validRows, warnRows) {
  const sorted = _sortTx([...validRows]);
  const total  = sorted.length;
  const pages  = Math.max(1, Math.ceil(total / state.txPerPage));
  if (state.txPage > pages) state.txPage = 1;
  const start  = (state.txPage - 1) * state.txPerPage;
  const paged  = sorted.slice(start, start + state.txPerPage);

  const thSort = (col, label) => {
    const cls = state.txSort.col === col ? ` sort-${state.txSort.dir}` : '';
    return `<th class="${cls}" data-sort="${esc(col)}">${esc(label)}</th>`;
  };

  // Only force table visible on mobile for inline delete confirmation
  const hasDeleteRow = state.txDeleteRow !== null;

  const rowData = paged.map(tx => {
    if (state.txDeleteRow === tx._row) return { tr: _renderTxDeleteRow(tx), card: '' };

    const badgeCls  = tx.tx_type === 'money-in' ? 'badge-et-in' : tx.tx_type === 'money-out' ? 'badge-et-out' : 'badge-et-transfer';
    const typeLabel = _txTypeMap()[tx.tx_type] || tx.tx_type;
    const missingRate = !state.rateMap[tx.currency];

    const fromName  = state.accountMap[tx.source_account]?.name || '—';
    const toName    = tx.target_account ? state.accountMap[tx.target_account]?.name : null;
    const acctLabel = toName ? `${fromName} → ${toName}` : fromName;
    const catLabel  = [tx.major_category, tx.minor_category].filter(Boolean).join(' → ') || '—';
    const nativeAmt = fmtNative(tx.amount, tx.currency);
    const baseAmt   = fmtBase(tx.amount, tx.currency);
    const amtCell   = tx.currency !== state.quoteCurrency
      ? `${esc(nativeAmt)} <span class="td-base-amt">/ ${esc(baseAmt)}</span>`
      : esc(nativeAmt);

    return {
      tr: `<tr>
        <td class="td-mono td-nowrap">${esc(fmtDateTimeCompact(tx.tx_date_time))}</td>
        <td><span class="badge ${badgeCls}">${typeLabel}</span></td>
        <td class="td-truncate" title="${esc(acctLabel)}">${esc(acctLabel)}</td>
        <td class="td-mono td-nowrap">${amtCell}${missingRate ? ' <span class="badge badge-warn" title="Currency not in rates tab">?</span>' : ''}</td>
        <td class="td-truncate" title="${esc(catLabel)}">${esc(catLabel)}</td>
        <td style="text-align:right">
          <button class="tx-menu-trigger" data-action="tx-menu" data-row="${tx._row}" title="Actions">⋮</button>
        </td>
      </tr>`,
      card: (()=>{
        const dotCls = tx.tx_type === 'money-in' ? 'tx-dot-in' : tx.tx_type === 'money-out' ? 'tx-dot-out' : 'tx-dot-transfer';
        return `<div class="tx-card">
          <div class="tx-card-body">
            <div class="tx-card-name"><span class="tx-type-dot ${dotCls}">●</span> ${esc(fmtDateTimeCompact(tx.tx_date_time))} · ${esc(acctLabel)}</div>
            ${catLabel !== '—' ? `<div class="tx-card-cat">${esc(catLabel)}</div>` : ''}
          </div>
          <div class="tx-card-amt td-mono">${esc(nativeAmt)}</div>
          <button class="tx-menu-trigger" data-action="tx-menu" data-row="${tx._row}" title="Actions">⋮</button>
        </div>`;
      })()
    };
  });

  const tableRows = rowData.map(d => d.tr).join('');
  const cardRows  = rowData.map(d => d.card).join('');

  const warnRowsHtml = warnRows.length ? `
    <tbody id="warnTable" class="hidden">
      ${warnRows.map(tx => `<tr>
        <td colspan="6"><span class="badge badge-warn">⚠ malformed</span> id=${esc(String(tx.id||'?'))} type=${esc(tx.tx_type||'?')} date=${esc(String(tx.tx_date_time||'?'))}</td>
      </tr>`).join('')}
    </tbody>` : '';

  const pagination = `
    <div class="pagination">
      <button class="btn btn-secondary btn-sm" id="prevPage" ${state.txPage <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${state.txPage} of ${pages} (${total} rows)</span>
      <select id="txPerPage" class="per-page-select">
        ${[10, 25, 50].map(n => `<option value="${n}" ${state.txPerPage === n ? 'selected' : ''}>${n} / page</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" id="nextPage" ${state.txPage >= pages ? 'disabled' : ''}>Next →</button>
    </div>`;

  return `
    <div class="table-wrap tx-table-wrap${hasDeleteRow ? ' tx-has-active' : ''}">
      <table>
        <thead><tr>
          ${thSort('tx_date_time','Date')}
          ${thSort('tx_type','Type')}
          ${thSort('source_account','Account')}
          <th>Amount</th>
          ${thSort('major_category','Category')}
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
        ${warnRowsHtml}
      </table>
    </div>
    <div class="tx-cards">${cardRows}</div>
    ${pagination}
  `;
}

function _attachEvents() {
  if (_txEventsAbort) _txEventsAbort.abort();
  _txEventsAbort = new AbortController();
  const { signal } = _txEventsAbort;

  const content = el('transactionsContent');
  if (!content) return;

  content.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      state.txSort.dir = state.txSort.col === col && state.txSort.dir === 'asc' ? 'desc' : (state.txSort.col === col ? 'asc' : 'desc');
      state.txSort.col = col;
      state.txPage = 1;
      renderTransactions();
    }, { signal });
  });

  el('prevPage')?.addEventListener('click', () => { state.txPage--; renderTransactions(); }, { signal });
  el('nextPage')?.addEventListener('click', () => { state.txPage++; renderTransactions(); }, { signal });
  el('txPerPage')?.addEventListener('change', e => { state.txPerPage = Number(e.target.value); state.txPage = 1; renderTransactions(); }, { signal });

  content.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? Number(btn.dataset.row) : null;
    if (action === 'tx-menu') {
      const tx = state.transactions.find(t => t._row === row);
      if (!tx) return;
      if (_txMenuKey === row) { closeContextMenu(); _txMenuKey = null; return; }
      _txMenuKey = row;
      const isSub = _isCatSubEligible(tx) && !_isAlreadySubscribed(tx);
      openContextMenu(btn, [
        { key: 'tx-view',     label: 'View',         cls: '' },
        { key: 'tx-edit',     label: 'Edit',         cls: '' },
        { key: 'tx-copy',     label: 'Copy',         cls: '' },
        { key: 'tx-delete',   label: 'Delete',       cls: 'danger' },
        ...(isSub ? [{ key: 'tx-mark-sub', label: 'Subscribe', cls: '' }] : []),
      ], key => { _txMenuKey = null; _dispatchTxAction(key, row); });
      return;
    }
    if (action === 'sugg-add') {
      const key = btn.dataset.key;
      const s = state.suggestions.find(x => `${x.counterparty_name}|${x.minor_category}` === key);
      if (!s) return;
      state.txCopyPrefill = {
        tx_type:             'money-out',
        major_category:      s.major_category,
        minor_category:      s.minor_category,
        source_account:      s.source_account,
        target_account:      '',
        amount:              s.typical_amount,
        currency:            s.currency,
        counterparty_name:   s.counterparty_name,
        user_location_area:    s.user_location_area    || '',
        user_location_city:    s.user_location_city    || '',
        user_location_country: s.user_location_country || '',
        tx_tags:             s.tx_tags                || '',
        beneficiaries:       s.beneficiaries          || '',
        description:         '',
      };
      state.txAddOpen    = true;
      state.txImportOpen = false;
      renderTransactions();
      return;
    }
    _dispatchTxAction(action, row);
  }, { signal });
}

function _sortTx(rows) {
  const col = state.txSort.col;
  const dir = state.txSort.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    if (col === 'tx_date_time') {
      const ts = s => { const d = new Date(String(s)); return isNaN(d) ? 0 : d.getTime(); };
      va = ts(va); vb = ts(vb);
    } else if (col === 'amount') {
      va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
    } else {
      va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
    }
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

// ── Add-transaction form ──────────────────────────────────────────────────────

function _renderAddForm() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="form-grid form-grid-6">
      <!-- Row 1: Type | Major category | Minor category -->
      <div class="field form-grid-span-2">
        <label for="afType">Type *</label>
        <select id="afType">
          <option value="">— select —</option>
          ${_txTypes().map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field form-grid-span-2" id="afMajorField">
        <label for="afMajor">Major category *</label>
        <select id="afMajor" disabled><option value="">— select type first —</option></select>
      </div>
      <div class="field form-grid-span-2" id="afMinorField">
        <label for="afMinor">Minor category *</label>
        <select id="afMinor" disabled><option value="">— select major first —</option></select>
      </div>
      <!-- Row 2: Source account | Target account -->
      <div class="field form-grid-span-3" id="afFromAccountWrap">
        <label for="afFromAccount">Source account</label>
        <select id="afFromAccount" disabled>
          <option value="">— select type first —</option>
        </select>
      </div>
      <div class="field form-grid-span-3" id="afToAccountWrap">
        <label for="afToAccount">Target account</label>
        <select id="afToAccount" disabled>
          <option value="">External</option>
        </select>
      </div>
      <!-- Row 3: Date & time | Timezone | Amount -->
      <div class="field form-grid-span-2" id="afDateField">
        <label for="afDate">Date &amp; time *</label>
        <input type="datetime-local" id="afDate" value="${nowLocalISO()}">
      </div>
      <div class="field form-grid-span-2" id="afTimezoneField">
        <label for="afTimezone">Timezone <span class="optional">optional</span></label>
        <input type="text" id="afTimezone" placeholder="e.g. Asia/Kolkata" autocomplete="off">
      </div>
      <div class="field form-grid-span-2" id="afAmountField">
        <label for="afAmount">Amount *</label>
        <input type="number" id="afAmount" min="0.01" step="0.01" placeholder="0.00">
      </div>
      <!-- Row 4: Counterparty | Tags -->
      <div class="field form-grid-span-3" id="afCounterpartyField">
        <label for="afCounterparty">Counterparty</label>
        <input type="text" id="afCounterparty" placeholder="Tesco, employer, …" list="dlAfCounterparty" autocomplete="off">
      </div>
      <div class="field form-grid-span-3" id="afTagsField">
        <label for="afTags">Tags</label>
        <input type="text" id="afTags" placeholder="reimbursable, work" list="dlAfTags" autocomplete="off">
      </div>
      <!-- Row 5: Description -->
      <div class="field form-grid-full" id="afDescriptionField">
        <label for="afDescription">Description</label>
        <input type="text" id="afDescription" placeholder="free text">
      </div>
      <!-- Row 6: Beneficiaries -->
      <div class="field form-grid-full" id="afBeneficiariesField">
        <label for="afBeneficiaries">Beneficiaries <span class="optional">optional</span></label>
        <input type="text" id="afBeneficiaries" placeholder="e.g. Alice:60;Bob:40 or Alice;Bob" autocomplete="off">
      </div>
      <!-- Row 7: Area | City | Country -->
      <div class="field form-grid-span-2" id="afAreaField">
        <label for="afArea">Area</label>
        <input type="text" id="afArea" placeholder="e.g. West End" list="dlAfArea" autocomplete="off">
      </div>
      <div class="field form-grid-span-2" id="afCityField">
        <label for="afCity">City</label>
        <input type="text" id="afCity" placeholder="e.g. London" list="dlAfCity" autocomplete="off">
      </div>
      <div class="field form-grid-span-2" id="afCountryField">
        <label for="afCountry">Country</label>
        <input type="text" id="afCountry" placeholder="UK" list="dlAfCountry" autocomplete="off">
      </div>
      <!-- Row 8: Coordinates -->
      <div class="field form-grid-full" id="afCoordinatesField">
        <label>Coordinates <span class="optional">optional</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="afLatitude"  step="any" placeholder="Latitude"  style="flex:1" min="-90"  max="90">
          <input type="number" id="afLongitude" step="any" placeholder="Longitude" style="flex:1" min="-180" max="180">
          <button type="button" id="afDetectLocation" class="btn btn-secondary btn-sm">Detect</button>
        </div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" id="afSubmit">Save</button>
      <button class="btn btn-secondary" id="afReset">Clear</button>
    </div>
    <div class="pin-error" id="afError"></div>
    ${_datalist('dlAfCounterparty', state.metadata?.counterparties)}
    ${_datalist('dlAfArea',         state.metadata?.areas)}
    ${_datalist('dlAfCity',         state.metadata?.cities)}
    ${_datalist('dlAfCountry',      state.metadata?.countries)}
    ${_datalist('dlAfTags',         state.metadata?.tags)}
  </div>`;
}

function _prefillAddForm(p) {
  const typeEl = el('afType');
  if (!typeEl) return;

  // 1. Type → unlock and populate major
  typeEl.value = p.tx_type ?? 'FAILURE';
  const majorEl = el('afMajor');
  const minorEl = el('afMinor');
  if (p.tx_type) {
    majorEl.innerHTML = _catMajorOpts(p.tx_type);
    majorEl.disabled  = false;
    minorEl.disabled  = false;
  }

  // 2. Major → populate minor (skip for transfers — legitimately no category)
  if (p.major_category) {
    majorEl.value     = p.major_category;
    minorEl.innerHTML = _catMinorOpts(p.tx_type, p.major_category);
    minorEl.value     = p.minor_category ?? 'FAILURE';
  }

  // 3. Refresh source account opts (category-filtered), then set value
  _afRefreshFromAccountOpts();
  const fromEl = el('afFromAccount');
  if (fromEl) fromEl.value = p.source_account ?? 'FAILURE';

  // 4. Refresh target account opts, then set value
  _afRefreshToAccountField();
  const toEl = el('afToAccount');
  if (toEl) toEl.value = p.target_account ?? 'FAILURE';

  // 5. Remaining text fields — date stays as nowLocalISO()
  const afAmount  = el('afAmount');      if (afAmount)  afAmount.value  = p.amount              ?? 'FAILURE';
  const afCp      = el('afCounterparty'); if (afCp)     afCp.value      = p.counterparty_name   ?? 'FAILURE';
  const afArea    = el('afArea');        if (afArea)    afArea.value    = p.user_location_area    ?? 'FAILURE';
  const afCity    = el('afCity');        if (afCity)    afCity.value    = p.user_location_city    ?? 'FAILURE';
  const afCountry = el('afCountry');     if (afCountry) afCountry.value = p.user_location_country ?? 'FAILURE';
  const afTags    = el('afTags');        if (afTags)    afTags.value    = p.tx_tags !== undefined ? String(p.tx_tags).replace(/;/g, ', ') : 'FAILURE';
  const afDesc    = el('afDescription'); if (afDesc)    afDesc.value    = p.description         ?? 'FAILURE';
  const afTimezone = el('afTimezone'); if (afTimezone) afTimezone.value = p.tx_timezone || '';
  const afLat = el('afLatitude');  if (afLat) afLat.value = p.user_location_latitude  ?? '';
  const afLon = el('afLongitude'); if (afLon) afLon.value = p.user_location_longitude ?? '';
  const afBen = el('afBeneficiaries'); if (afBen) afBen.value = p.beneficiaries || '';
}

function _attachAddFormEvents() {
  el('afType')?.addEventListener('change', () => {
    const type       = el('afType').value;
    const majorEl    = el('afMajor');
    const minorEl    = el('afMinor');

    majorEl.innerHTML = '<option value="">— select type first —</option>';
    minorEl.innerHTML = '<option value="">— select major first —</option>';
    if (el('afFromAccount')) el('afFromAccount').value = '';
    if (el('afToAccount'))   el('afToAccount').value   = '';

    if (!type) {
      majorEl.disabled = true;
      minorEl.disabled = true;
      const fromEl = el('afFromAccount');
      if (fromEl) { fromEl.disabled = true; fromEl.innerHTML = '<option value="">— select type first —</option>'; }
      const toEl = el('afToAccount');
      if (toEl) { toEl.disabled = true; toEl.innerHTML = '<option value="">External</option>'; }
      return;
    }

    majorEl.innerHTML = _catMajorOpts(type);
    majorEl.disabled  = false;
    minorEl.disabled  = false;

    // _afRefreshFromAccountOpts cascades → _afRefreshToAccountField
    _afRefreshFromAccountOpts();
  });

  el('afMajor')?.addEventListener('change', () => {
    const type   = el('afType').value;
    const major  = el('afMajor').value;
    el('afMinor').innerHTML = _catMinorOpts(type, major);
    _afRefreshFromAccountOpts();  // clear any previous category hint
  });

  el('afMinor')?.addEventListener('change', _afRefreshFromAccountOpts);

  el('afFromAccount')?.addEventListener('change', _afRefreshToAccountField);

  el('afSubmit')?.addEventListener('click', _saveTransaction);
  el('afReset')?.addEventListener('click', () => {
    ['afDate','afAmount','afCounterparty','afArea','afCity','afCountry','afTags','afDescription','afTimezone','afLatitude','afLongitude','afBeneficiaries']
      .forEach(id => { if (el(id)) el(id).value = id === 'afDate' ? nowLocalISO() : ''; });
    el('afType').value = '';
    const fromEl = el('afFromAccount');
    if (fromEl) { fromEl.disabled = true; fromEl.innerHTML = '<option value="">— select type first —</option>'; }
    const toEl = el('afToAccount');
    if (toEl) { toEl.disabled = true; toEl.innerHTML = '<option value="">External</option>'; }
    el('afMajor').innerHTML = '<option value="">— select type first —</option>';
    el('afMajor').disabled  = true;
    el('afMinor').innerHTML = '<option value="">— select major first —</option>';
    el('afMinor').disabled  = true;
    el('afError').textContent = '';
  });

  _attachTagAutocomplete('afTags', 'dlAfTags');

  el('afDetectLocation')?.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = el('afLatitude');
      const lon = el('afLongitude');
      if (lat) lat.value = pos.coords.latitude.toFixed(6);
      if (lon) lon.value = pos.coords.longitude.toFixed(6);
    });
  });

  // If a copy was triggered, populate the form now that events are wired
  if (state.txCopyPrefill) {
    _prefillAddForm(state.txCopyPrefill);
    state.txCopyPrefill = null;
  }
}

function _afRefreshFromAccountOpts() {
  const type   = el('afType')?.value  || '';
  const major  = el('afMajor')?.value || '';
  const minor  = el('afMinor')?.value || '';
  const fromEl = el('afFromAccount');
  if (!fromEl) return;
  const cat          = _getCat(type, major, minor);
  const srcMandatory = cat ? Boolean(cat.source_account_mandatory) : type !== 'money-in';

  if (!srcMandatory) {
    fromEl.disabled  = true;
    fromEl.innerHTML = `<option value="">External</option>`;
    fromEl.value     = '';
  } else {
    fromEl.disabled  = false;
    const prevVal    = fromEl.value;
    const activeAccs = state.accounts.filter(a => a.record_status === 'active');
    const srcTypes   = cat?.source_account_types || '';
    fromEl.innerHTML = `<option value="">— select —</option>${_acctOptsWithHints(activeAccs, srcTypes, prevVal)}`;
    if (prevVal) fromEl.value = prevVal;
  }
  _afRefreshToAccountField();
}

function _afRefreshToAccountField() {
  const type   = el('afType')?.value  || '';
  const major  = el('afMajor')?.value || '';
  const minor  = el('afMinor')?.value || '';
  const cat    = _getCat(type, major, minor);
  const isTransfer      = type === 'money-transfer';
  const targetMandatory = cat ? Boolean(cat.target_account_mandatory) : isTransfer;

  const toAccEl = el('afToAccount');
  if (!toAccEl) return;

  if (targetMandatory) {
    toAccEl.disabled  = false;
    const fromId      = el('afFromAccount')?.value || '';
    const prevVal     = toAccEl.value;
    const activeAccs  = state.accounts.filter(a => a.record_status === 'active');
    const dstTypes    = cat?.target_account_types || '';
    const eligible    = activeAccs.filter(a => a.id !== fromId);
    toAccEl.innerHTML = `<option value="">— select —</option>${_acctOptsWithHints(eligible, dstTypes, prevVal)}`;
    if (prevVal && prevVal !== fromId) toAccEl.value = prevVal;
  } else {
    toAccEl.disabled  = true;
    toAccEl.innerHTML = `<option value="">External</option>`;
    toAccEl.value     = '';
  }
}



// ── Financial hard-block rules 1–6 ───────────────────────────────────────────
// Returns null on pass, or a multi-line error string on block.
// Rules 1 & 3 — insufficient balance (asset accounts).
// Rules 2 & 4 — credit limit exceeded (credit-card accounts).
// Rule 5     — money-out from a loan account (with exemption for interest/charges).
// Rule 6     — FX rate required for cross-currency money-transfer.

function _checkBalanceRules(transaction_type, sourceAccount, amount) {
  if (!sourceAccount) return null;
  const isMoneyOut      = transaction_type === 'money-out';
  const isTransfer      = transaction_type === 'money-transfer';
  if (!isMoneyOut && !isTransfer) return null;

  const sym = getSymbol(sourceAccount.currency);
  const fmt = n => Number(n).toFixed(2);

  // Rules 1 & 3 — asset accounts
  if ((state.accountSchema?.asset_types || []).includes(sourceAccount.type)) {
    const balance = Number(sourceAccount.current_value);
    if (balance < amount) {
      return (
        `Insufficient balance.\n` +
        `${sourceAccount.name} has ${sym}${fmt(balance)} — this transaction requires ${sym}${fmt(amount)}.\n` +
        `Record an Adjustments / Balance correction first if your actual balance is higher.`
      );
    }
    return null;
  }

  // Rules 2 & 4 — credit card accounts
  if (sourceAccount.type === 'credit_card') {
    const creditLimit = Number(sourceAccount.credit_card_limit) || 0;
    if (creditLimit <= 0) return null; // no limit set — skip check

    const balance         = Number(sourceAccount.current_value); // negative: amount owed stored as negative
    const availableCredit = creditLimit + balance;                 // e.g. limit=1000, balance=−600 → available=400

    if (amount > availableCredit) {
      const owed = Math.abs(balance);
      if (availableCredit < 0) {
        // Already over the limit before this transaction
        const alreadyOver = Math.abs(availableCredit);
        return (
          `Credit limit exceeded.\n` +
          `${sourceAccount.name} — limit ${sym}${fmt(creditLimit)}, currently ${sym}${fmt(owed)} owed, already ${sym}${fmt(alreadyOver)} over the limit.\n` +
          `This transaction of ${sym}${fmt(amount)} cannot be applied.`
        );
      } else {
        // Within limit but this transaction would exceed it
        const overage = amount - availableCredit;
        return (
          `Credit limit exceeded.\n` +
          `${sourceAccount.name} — limit ${sym}${fmt(creditLimit)}, currently ${sym}${fmt(owed)} owed, available ${sym}${fmt(availableCredit)}.\n` +
          `This transaction of ${sym}${fmt(amount)} would exceed the limit by ${sym}${fmt(overage)}.`
        );
      }
    }
    return null;
  }

  return null;
}

// Rule 5 — block money-out from a loan account.
// Exemption: major_category === 'Debt & finance' AND minor_category === 'Interest & charges'.
// Returns null on pass, or the error string on block.
function _checkRule5(transaction_type, sourceAccount, major_category, minor_category) {
  if (transaction_type !== 'money-out') return null;
  if (!sourceAccount) return null;
  const loanTypes = state.accountSchema?.loan_types || [];
  if (!loanTypes.includes(sourceAccount.type)) return null;
  if (major_category === 'Debt & finance' && minor_category === 'Interest & charges') return null;
  return (
    `Cannot record money-out from a loan account.\n` +
    `Loan accounts track what you owe. To record a loan fee or charge, add it as a money-out from your current account, or record it directly in the sheet.`
  );
}


async function _saveTransaction() {
  const btn   = el('afSubmit');
  const errEl = el('afError');
  errEl.textContent = '';

  const dateRaw              = el('afDate').value;
  const tx_type              = el('afType').value;
  const source_account       = el('afFromAccount').value;
  const target_account       = el('afToAccount')?.value || '';
  const amount               = el('afAmount').value;
  const currency             = tx_type === 'money-in'
    ? (state.accountMap[target_account]?.currency || '')
    : (state.accountMap[source_account]?.currency || '');
  const major_category       = el('afMajor').value;
  const minor_category       = el('afMinor').value;
  const counterparty_name    = el('afCounterparty').value.trim();
  const user_location_area     = el('afArea')?.value.trim()    || '';
  const user_location_city     = el('afCity')?.value.trim()    || '';
  const user_location_country  = el('afCountry').value.trim();
  const tx_tags              = el('afTags').value.trim();
  const description          = el('afDescription').value.trim();
  const tx_timezone            = el('afTimezone')?.value.trim() || '';
  const user_location_latitude  = el('afLatitude')?.value  !== '' ? Number(el('afLatitude')?.value)  : '';
  const user_location_longitude = el('afLongitude')?.value !== '' ? Number(el('afLongitude')?.value) : '';
  const beneficiaries           = el('afBeneficiaries')?.value.trim() || '';

  const isTransfer    = tx_type === 'money-transfer';
  const _saveCat      = _getCat(tx_type, major_category, minor_category);
  const srcMandatory  = _saveCat ? Boolean(_saveCat.source_account_mandatory) : tx_type !== 'money-in';
  const tgtMandatory  = _saveCat ? Boolean(_saveCat.target_account_mandatory) : isTransfer;
  if (!dateRaw)                                  { errEl.textContent = 'Date is required.';                          return; }
  if (!tx_type)                                  { errEl.textContent = 'Type is required.';                          return; }
  if (srcMandatory && !source_account)           { errEl.textContent = 'Source account is required.';                return; }
  if (tgtMandatory && !target_account)           { errEl.textContent = 'Target account is required.';                return; }
  if (!amount || parseFloat(amount) <= 0)        { errEl.textContent = 'Enter a positive amount.';                   return; }
  if (!isTransfer && !major_category)            { errEl.textContent = 'Major category is required.';                return; }
  if (!isTransfer && !minor_category)            { errEl.textContent = 'Minor category is required.';                return; }

  const sourceAcc     = state.accountMap[source_account];
  const targetAcc     = state.accountMap[target_account];
  const balanceError  = _checkBalanceRules(tx_type, sourceAcc, parseFloat(amount));
  if (balanceError) { errEl.textContent = balanceError; return; }

  const rule5Error    = _checkRule5(tx_type, sourceAcc, major_category, minor_category);
  if (rule5Error) { errEl.textContent = rule5Error; return; }

  btn.disabled = true; btn.textContent = 'Saving…';
  showLoading();
  try {
    const res = await ExpenseAPI.createTransaction({
      tx_date_time: localToUtcISO(dateRaw),
      tx_type, source_account, target_account,
      amount: parseFloat(amount), currency,
      major_category, minor_category,
      counterparty_name, user_location_area, user_location_city, user_location_country,
      tx_tags, description,
      tx_timezone, user_location_latitude, user_location_longitude, beneficiaries,
    });
    if (res.ok) {
      showMsg('Transaction saved.');
      state.txAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _saveTransaction failed:', res?.error);
      errEl.textContent = 'Error: ' + (res.error || 'unknown');
      btn.disabled = false; btn.textContent = 'Save';
    }
  } catch (err) {
    console.error('[transactions] _saveTransaction failed:', err);
    errEl.textContent = 'Connection error.';
    btn.disabled = false; btn.textContent = 'Save';
  } finally {
    hideLoading();
  }
}

// ── Transaction view / edit card ──────────────────────────────────────────────

function _renderTxForm(tx, mode) {
  const badgeCls  = tx.tx_type === 'money-in' ? 'badge-et-in' : tx.tx_type === 'money-out' ? 'badge-et-out' : 'badge-et-transfer';
  const typeLabel = _txTypeMap()[tx.tx_type] || tx.tx_type;
  const fromName  = state.accountMap[tx.source_account]?.name || '—';
  const toName    = tx.target_account ? (state.accountMap[tx.target_account]?.name || '—') : 'External';

  if (mode === 'view') {
    const f = (label, value) =>
      `<div class="tx-detail-field"><div class="tx-detail-label">${label}</div><div class="tx-detail-value">${value}</div></div>`;

    return `
    <div class="card" style="margin-bottom:16px">
      <div class="tx-detail-grid">
        ${f('Date & time',      esc(fmtDateTime(tx.tx_date_time)))}
        ${f('Type',             `<span class="badge ${badgeCls}">${esc(typeLabel)}</span>`)}
        ${f('Source account',   esc(fromName))}
        ${f('Target account',   esc(toName))}
        ${f('Amount',           esc(fmtNative(tx.amount, tx.currency)))}
        ${f('≈ ' + state.quoteCurrency, esc(fmtBase(tx.amount, tx.currency)))}
        ${f('Category',         esc([tx.major_category, tx.minor_category].filter(Boolean).join(' → ') || '—'))}
        ${f('Counterparty',     esc(tx.counterparty_name || '—'))}
        ${tx.user_location_area    ? f('Area',    esc(tx.user_location_area))    : ''}
        ${tx.user_location_city    ? f('City',    esc(tx.user_location_city))    : ''}
        ${tx.user_location_country ? f('Country', esc(tx.user_location_country)) : ''}
        ${f('Tags',             esc(String(tx.tx_tags || '').replace(/;/g, ', ') || '—'))}
        ${f('Description',      esc(tx.description || '—'))}
        ${tx.sync_status ? `<span class="badge badge-${_syncBadgeClass(tx.sync_status)}">${esc(tx.sync_status)}</span>` : ''}
        ${tx.sync_status === 'sync-failure' && tx.sync_notes ? `<div class="sync-notes">${esc(tx.sync_notes)}</div>` : ''}
      </div>
      <div class="form-actions" style="margin-top:12px">
        <button class="btn btn-secondary btn-sm" data-action="tx-cancel-view">Close</button>
        <button class="btn btn-primary btn-sm" data-action="tx-edit" data-row="${tx._row}">Edit</button>
      </div>
    </div>`;
  }

  // Edit mode
  const activeAccounts  = state.accounts.filter(a => a.record_status === 'active');
  const _editCat        = _getCat(tx.tx_type, tx.major_category, tx.minor_category);
  const fromAccountOpts = _acctOptsWithHints(activeAccounts, _editCat?.source_account_types || '', tx.source_account);
  const toAccountOpts   = _acctOptsWithHints(
    activeAccounts.filter(a => a.id !== tx.source_account),
    _editCat?.target_account_types || '',
    tx.target_account
  );
  const typeOpts = _txTypes().map(t =>
    `<option value="${esc(t.value)}" ${tx.tx_type === t.value ? 'selected' : ''}>${esc(t.label)}</option>`
  ).join('');
  const majorOpts = _catMajorOpts(tx.tx_type, tx.major_category);
  const minorOpts = _catMinorOpts(tx.tx_type, tx.major_category, tx.minor_category);

  const dateVal = utcToLocalInput(tx.tx_date_time);

  const isXfer     = tx.tx_type === 'money-transfer';
  const tgtMand    = _editCat ? Boolean(_editCat.target_account_mandatory) : isXfer;

  return `
  <div class="card" style="margin-bottom:16px">
    <div class="form-grid form-grid-6">
      <!-- Row 1: Type | Major category | Minor category -->
      <div class="field form-grid-span-2">
        <label>Type</label>
        <select id="txEditType">${typeOpts}</select>
      </div>
      <div class="field form-grid-span-2" id="txEditMajorField">
        <label>Major category</label>
        <select id="txEditMajor">
          <option value="">— select —</option>
          ${majorOpts}
        </select>
      </div>
      <div class="field form-grid-span-2" id="txEditMinorField">
        <label>Minor category</label>
        <select id="txEditMinor">
          <option value="">— select —</option>
          ${minorOpts}
        </select>
      </div>
      <!-- Row 2: Source account | Target account -->
      <div class="field form-grid-span-3">
        <label>Source account</label>
        <select id="txEditFromAccount">
          <option value="">— select —</option>
          ${fromAccountOpts}
        </select>
      </div>
      <div class="field form-grid-span-3" id="txEditToAccountWrap">
        <label>Target account</label>
        <select id="txEditToAccount" ${tgtMand ? '' : 'disabled'}>
          ${tgtMand
            ? `<option value="">— select —</option>${toAccountOpts}`
            : `<option value="">External</option>`}
        </select>
      </div>
      <!-- Row 3: Date & time | Timezone | Amount -->
      <div class="field form-grid-span-2">
        <label>Date &amp; time</label>
        <input type="datetime-local" id="txEditDate" value="${esc(dateVal)}">
      </div>
      <div class="field form-grid-span-2">
        <label>Timezone <span class="optional">optional</span></label>
        <input type="text" id="txEditTimezone" placeholder="e.g. Asia/Kolkata" autocomplete="off" value="${esc(tx.tx_timezone || '')}">
      </div>
      <div class="field form-grid-span-2">
        <label>Amount</label>
        <input type="number" id="txEditAmount" min="0.01" step="0.01" value="${esc(String(tx.amount || ''))}">
      </div>
      <!-- Row 4: Counterparty | Tags -->
      <div class="field form-grid-span-3">
        <label>Counterparty</label>
        <input type="text" id="txEditCounterparty" value="${esc(tx.counterparty_name || '')}" list="dlEditCounterparty" autocomplete="off">
      </div>
      <div class="field form-grid-span-3">
        <label>Tags</label>
        <input type="text" id="txEditTags" value="${esc(String(tx.tx_tags || '').replace(/;/g, ', '))}" list="dlEditTags" autocomplete="off">
      </div>
      <!-- Row 5: Description -->
      <div class="field form-grid-full">
        <label>Description</label>
        <input type="text" id="txEditDescription" value="${esc(tx.description || '')}">
      </div>
      <!-- Row 6: Beneficiaries -->
      <div class="field form-grid-full">
        <label for="txEditBeneficiaries">Beneficiaries <span class="optional">optional</span></label>
        <input type="text" id="txEditBeneficiaries" placeholder="e.g. Alice:60;Bob:40 or Alice;Bob" autocomplete="off" value="${esc(tx.beneficiaries || '')}">
      </div>
      <!-- Row 7: Area | City | Country -->
      <div class="field form-grid-span-2">
        <label>Area</label>
        <input type="text" id="txEditArea" value="${esc(tx.user_location_area || '')}" list="dlEditArea" autocomplete="off">
      </div>
      <div class="field form-grid-span-2">
        <label>City</label>
        <input type="text" id="txEditCity" value="${esc(tx.user_location_city || '')}" list="dlEditCity" autocomplete="off">
      </div>
      <div class="field form-grid-span-2">
        <label>Country</label>
        <input type="text" id="txEditCountry" value="${esc(tx.user_location_country || '')}" list="dlEditCountry" autocomplete="off">
      </div>
      <!-- Row 8: Coordinates -->
      <div class="field form-grid-full">
        <label>Coordinates <span class="optional">optional</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="txEditLatitude"  step="any" placeholder="Latitude"  style="flex:1" min="-90"  max="90"  value="${tx.user_location_latitude  ?? ''}">
          <input type="number" id="txEditLongitude" step="any" placeholder="Longitude" style="flex:1" min="-180" max="180" value="${tx.user_location_longitude ?? ''}">
          <button type="button" id="txEditDetectLocation" class="btn btn-secondary btn-sm">Detect</button>
        </div>
      </div>
    </div>
    <div class="form-actions" style="margin-top:8px">
      <button class="btn btn-primary btn-sm" data-action="tx-save-edit">Save</button>
      <button class="btn btn-secondary btn-sm" data-action="tx-cancel-edit">Cancel</button>
    </div>
    <div class="pin-error" id="txEditError"></div>
    ${_datalist('dlEditCounterparty', state.metadata?.counterparties)}
    ${_datalist('dlEditArea',         state.metadata?.areas)}
    ${_datalist('dlEditCity',         state.metadata?.cities)}
    ${_datalist('dlEditCountry',      state.metadata?.countries)}
    ${_datalist('dlEditTags',         state.metadata?.tags)}
  </div>`;
}

function _renderTxDeleteRow(tx) {
  const fromName = state.accountMap[tx.source_account]?.name || '—';
  const toName   = tx.target_account ? state.accountMap[tx.target_account]?.name : null;
  const accLabel = toName ? `${fromName} → ${toName}` : fromName;
  return `<tr>
    <td colspan="6">
      <span class="confirm-text">Delete <strong>${esc(fmtDateTime(tx.tx_date_time))}</strong> — ${esc(accLabel)} — ${esc(fmtNative(tx.amount, tx.currency))}?</span>
      <span style="display:inline-flex;gap:8px;margin-left:16px">
        <button class="btn-link danger" data-action="tx-confirm-delete" data-row="${tx._row}">Yes, delete</button>
        <button class="btn-link" data-action="tx-cancel-delete">Cancel</button>
      </span>
    </td>
  </tr>`;
}

function _attachTxEditCascadeEvents() {
  const _refreshFieldVis = () => {
    const type    = el('txEditType')?.value;
    const major   = el('txEditMajor')?.value || '';
    const minor   = el('txEditMinor')?.value || '';
    const cat     = _getCat(type, major, minor);
    const fromAcc = state.accountMap[el('txEditFromAccount')?.value];
    const toAcc   = state.accountMap[el('txEditToAccount')?.value];
    const isXfer     = type === 'money-transfer';
    const tgtMand    = cat ? Boolean(cat.target_account_mandatory) : isXfer;

    const toEl = el('txEditToAccount');
    if (toEl) {
      if (tgtMand) {
        toEl.disabled = false;
        if (toEl.innerHTML.trim().startsWith('<option value="">External')) {
          toEl.innerHTML = `<option value="">— select —</option>`;
        }
      } else {
        toEl.disabled  = true;
        toEl.innerHTML = `<option value="">External</option>`;
        toEl.value     = '';
      }
    }
  };

  const _refreshAccountOpts = () => {
    const type     = el('txEditType')?.value  || '';
    const major    = el('txEditMajor')?.value || '';
    const minor    = el('txEditMinor')?.value || '';
    const cat      = _getCat(type, major, minor);
    const srcTypes = cat?.source_account_types      || '';
    const dstTypes = cat?.target_account_types || '';
    const srcMand  = cat ? Boolean(cat.source_account_mandatory) : type !== 'money-in';
    const actives  = state.accounts.filter(a => a.record_status === 'active');
    const fromEl   = el('txEditFromAccount');
    const toEl     = el('txEditToAccount');
    if (fromEl) {
      if (!srcMand) {
        fromEl.disabled  = true;
        fromEl.innerHTML = `<option value="">External</option>`;
        fromEl.value     = '';
      } else {
        fromEl.disabled  = false;
        const prev = fromEl.value;
        fromEl.innerHTML = `<option value="">— select —</option>${_acctOptsWithHints(actives, srcTypes, prev)}`;
        if (prev) fromEl.value = prev;
      }
    }
    if (toEl) {
      const fromId = fromEl?.value || '';
      const prev   = toEl.value;
      toEl.innerHTML = `<option value="">— none —</option>${_acctOptsWithHints(actives.filter(a => a.id !== fromId), dstTypes, prev)}`;
      if (prev && prev !== fromId) toEl.value = prev;
    }
    _refreshFieldVis();
  };

  el('txEditType')?.addEventListener('change', () => {
    el('txEditMajor').innerHTML = _catMajorOpts(el('txEditType').value);
    el('txEditMinor').innerHTML = `<option value="">— select major first —</option>`;
    el('txEditToAccount').value = '';
    _refreshFieldVis();
  });
  el('txEditMajor')?.addEventListener('change', () => {
    const type  = el('txEditType').value;
    const major = el('txEditMajor').value;
    el('txEditMinor').innerHTML = _catMinorOpts(type, major);
    _refreshAccountOpts();
  });
  el('txEditMinor')?.addEventListener('change', _refreshAccountOpts);
  el('txEditFromAccount')?.addEventListener('change', _refreshFieldVis);
  el('txEditToAccount')?.addEventListener('change', _refreshFieldVis);

  _attachTagAutocomplete('txEditTags', 'dlEditTags');

  el('txEditDetectLocation')?.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = el('txEditLatitude');
      const lon = el('txEditLongitude');
      if (lat) lat.value = pos.coords.latitude.toFixed(6);
      if (lon) lon.value = pos.coords.longitude.toFixed(6);
    });
  });

  // Initial render: apply source/target disabled state based on category flags
  _refreshAccountOpts();
}

async function _saveEdit() {
  const errEl = el('txEditError');
  errEl.textContent = '';

  const rowNum              = state.txEditRow;
  const dateRaw             = el('txEditDate')?.value;
  const tx_type             = el('txEditType')?.value;
  const source_account      = el('txEditFromAccount')?.value;
  const target_account      = el('txEditToAccount')?.value  || '';
  const amount              = el('txEditAmount')?.value;
  const currency            = tx_type === 'money-in'
    ? (state.accountMap[target_account]?.currency || '')
    : (state.accountMap[source_account]?.currency || '');
  const major_category      = el('txEditMajor')?.value;
  const minor_category      = el('txEditMinor')?.value;
  const counterparty_name   = el('txEditCounterparty')?.value.trim();
  const user_location_area    = el('txEditArea')?.value.trim();
  const user_location_city    = el('txEditCity')?.value.trim();
  const user_location_country = el('txEditCountry')?.value.trim();
  const tx_tags             = el('txEditTags')?.value.trim();
  const description         = el('txEditDescription')?.value.trim();
  const tx_timezone            = el('txEditTimezone')?.value.trim() || '';
  const user_location_latitude  = el('txEditLatitude')?.value  !== '' ? Number(el('txEditLatitude')?.value)  : '';
  const user_location_longitude = el('txEditLongitude')?.value !== '' ? Number(el('txEditLongitude')?.value) : '';
  const beneficiaries           = el('txEditBeneficiaries')?.value.trim() || '';

  const isEditTransfer   = tx_type === 'money-transfer';
  const _editSaveCat     = _getCat(tx_type, major_category, minor_category);
  const editSrcMandatory = _editSaveCat ? Boolean(_editSaveCat.source_account_mandatory) : tx_type !== 'money-in';
  const editTgtMandatory = _editSaveCat ? Boolean(_editSaveCat.target_account_mandatory) : isEditTransfer;
  if (!dateRaw)                                 { errEl.textContent = 'Date is required.';                          return; }
  if (!tx_type)                                 { errEl.textContent = 'Type is required.';                          return; }
  if (editSrcMandatory && !source_account)      { errEl.textContent = 'Source account is required.';                return; }
  if (editTgtMandatory && !target_account)      { errEl.textContent = 'Target account is required.';                return; }
  if (!amount || parseFloat(amount) <= 0)       { errEl.textContent = 'Enter a positive amount.';                   return; }
  if (!isEditTransfer && !major_category)       { errEl.textContent = 'Major category is required.';                return; }
  if (!isEditTransfer && !minor_category)       { errEl.textContent = 'Minor category is required.';                return; }

  const fromAccEdit = state.accountMap[source_account];
  const toAccEdit   = state.accountMap[target_account];

  // Locate the original transaction so we can compute post-reversal balances.
  const oldTx = state.transactions.find(t => t._row === rowNum);

  // Post-reversal balance for source_account:
  // Phase 1 of the backend edit reverses the old transaction before Phase 2 applies new values.
  // We only undo the old debit/credit if the source_account hasn't changed.
  let fromPostRevBal = fromAccEdit ? Number(fromAccEdit.current_value) : 0;
  if (oldTx && String(oldTx.source_account) === String(source_account)) {
    const oldAmt = Number(oldTx.amount) || 0;
    if (oldTx.tx_type === 'money-in')       fromPostRevBal -= oldAmt; // reversal removes the credit
    if (oldTx.tx_type === 'money-out')      fromPostRevBal += oldAmt; // reversal restores the debit
    if (oldTx.tx_type === 'money-transfer') fromPostRevBal += oldAmt; // reversal restores the debit
  }
  // Proxy object with post-reversal balance — passed to _checkBalanceRules instead of fromAccEdit.
  const fromAccPR = fromAccEdit ? { ...fromAccEdit, current_value: fromPostRevBal } : fromAccEdit;

  const balanceErrorEdit = _checkBalanceRules(tx_type, fromAccPR, parseFloat(amount));
  if (balanceErrorEdit) { errEl.textContent = balanceErrorEdit; return; }

  const rule5ErrorEdit = _checkRule5(tx_type, fromAccEdit, major_category, minor_category);
  if (rule5ErrorEdit) { errEl.textContent = rule5ErrorEdit; return; }

  // target_account credit-card check (transfer edits only)
  if (
    tx_type === 'money-transfer' &&
    toAccEdit && toAccEdit.type === 'credit_card' &&
    Number(toAccEdit.credit_card_limit) > 0
  ) {
    // How much will be credited to target_account in Phase 2?
    const newCredited = parseFloat(amount);

    // Post-reversal balance of target_account: undo old credited amount (if same target_account).
    let toPostRevBal = Number(toAccEdit.current_value);
    if (oldTx && String(oldTx.target_account) === String(target_account)) {
      const oldCredited = Number(oldTx.amount);
      toPostRevBal     -= oldCredited; // reversal removes the old credit
    }

    const toAvailable = Number(toAccEdit.credit_card_limit) + toPostRevBal;
    if (newCredited > toAvailable) {
      const sym  = getSymbol(toAccEdit.currency);
      const fmt  = n => Number(n).toFixed(2);
      const owed = Math.abs(toPostRevBal);
      if (toAvailable < 0) {
        errEl.textContent =
          `Credit limit exceeded.\n` +
          `${toAccEdit.name} — limit ${sym}${fmt(toAccEdit.credit_card_limit)}, currently ${sym}${fmt(owed)} owed, already ${sym}${fmt(Math.abs(toAvailable))} over the limit.\n` +
          `This credit of ${sym}${fmt(newCredited)} cannot be applied.`;
      } else {
        errEl.textContent =
          `Credit limit exceeded.\n` +
          `${toAccEdit.name} — limit ${sym}${fmt(toAccEdit.credit_card_limit)}, currently ${sym}${fmt(owed)} owed, available ${sym}${fmt(toAvailable)}.\n` +
          `This credit of ${sym}${fmt(newCredited)} would exceed the limit by ${sym}${fmt(newCredited - toAvailable)}.`;
      }
      return;
    }
  }

  showLoading();
  try {
    const res = await ExpenseAPI.updateTransaction({
      row_num: rowNum, tx_date_time: localToUtcISO(dateRaw), tx_type,
      source_account, target_account, amount: parseFloat(amount), currency,
      major_category, minor_category, counterparty_name,
      user_location_area, user_location_city, user_location_country,
      tx_tags, description,
      tx_timezone, user_location_latitude, user_location_longitude, beneficiaries,
    });
    if (res.ok) {
      showMsg('Transaction updated.');
      state.txEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _saveEdit failed:', res?.error);
      errEl.textContent = 'Error: ' + (res.error || 'unknown');
    }
  } catch (err) {
    console.error('[transactions] _saveEdit failed:', err);
    errEl.textContent = 'Connection error.';
  } finally {
    hideLoading();
  }
}

async function _confirmDelete(rowNum) {
  showLoading();
  try {
    const res = await ExpenseAPI.deleteTransaction({ row_num: rowNum });
    if (res.ok) {
      showMsg('Transaction deleted.');
      state.txDeleteRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _confirmDelete failed:', res?.error);
      showMsg('Delete failed: ' + (res.error || 'unknown'), 'warn');
      state.txDeleteRow = null;
      renderTransactions();
    }
  } catch (err) {
    console.error('[transactions] _confirmDelete failed:', err);
    showMsg('Connection error.', 'warn');
    state.txDeleteRow = null;
    renderTransactions();
  } finally {
    hideLoading();
  }
}

// ── Suggestions panel ─────────────────────────────────────────────────────────

function _renderSuggestionsPanel() {
  if (state.suggestionsFetching) {
    return `
    <div class="suggestions-panel">
      <button class="suggestions-toggle" id="suggestionsToggle">
        Suggestions <span class="filter-arrow">▼</span>
      </button>
      <div class="suggestions-body" id="suggestionsBody">
        <div class="suggestions-scroll">
          ${Array.from({length: 10}).map(() => `<div class="suggestion-card suggestion-skeleton"></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  const visible = state.suggestions;

  // When empty: always show panel but collapsed
  const isEmpty  = visible.length === 0;
  const isOpen   = isEmpty ? false : state.suggestionsOpen;
  const arrow     = isOpen ? '▲' : '▼';
  const bodyClass = isOpen ? '' : 'hidden';
  const countLabel = visible.length > 0 ? ` (${visible.length})` : '';

  const cards = visible.map(s => {
    const key      = `${s.counterparty_name}|${s.minor_category}`;
    const acctName = state.accountMap[s.source_account]?.name || esc(s.source_account);
    const sym      = getSymbol(s.currency);
    const amount   = sym + Number(s.typical_amount).toFixed(2);

    return `
      <div class="suggestion-card" data-key="${esc(key)}">
        <div class="suggestion-name" title="${esc(s.counterparty_name)}">${esc(s.counterparty_name)}</div>
        <div class="suggestion-meta" title="${esc(s.minor_category)} · ${esc(acctName)}">${esc(s.minor_category)} · ${esc(acctName)}</div>
        <div class="suggestion-amount">${esc(amount)}</div>
        <div class="suggestion-reason" title="${esc(s.reason)}">${esc(s.reason)}</div>
        <button class="btn btn-primary btn-sm suggestion-add" data-action="sugg-add" data-key="${esc(key)}">Add</button>
      </div>`;
  }).join('');

  const body = isEmpty
    ? `<div class="suggestions-empty">No suggestions right now.</div>`
    : `<div class="suggestions-scroll">${cards}</div>`;

  return `
  <div class="suggestions-panel">
    <button class="suggestions-toggle" id="suggestionsToggle">
      Suggestions${esc(countLabel)} <span class="filter-arrow">${arrow}</span>
    </button>
    <div class="suggestions-body ${bodyClass}" id="suggestionsBody">
      ${body}
    </div>
  </div>`;
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const _ACC_TYPE_LABEL = { asset: 'Asset', investment: 'Investment', liability: 'Liability' };

function _fmtAccType(t) { return _ACC_TYPE_LABEL[t] || t; }

function _accountsForTypeSel() {
  if (!_accTypeSel.size) return state.accounts;
  return state.accounts.filter(a => _accTypeSel.has(a.type));
}

function _accTypeDropdownLabel() {
  if (!_accTypeSel.size) return 'All account types';
  return Array.from(_accTypeSel).map(_fmtAccType).join(', ');
}

function _refreshFilterAccountDropdown() {
  const dropdown = el('filterAccountDropdown');
  if (!dropdown) return;
  const accts   = _accountsForTypeSel();
  const validIds = new Set(accts.map(a => a.id));
  if (!_accTypeSel.size) state.filters.accounts = [];
  else state.filters.accounts = state.filters.accounts.filter(id => validIds.has(id));
  dropdown.innerHTML = accts.length
    ? accts.map(a => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
        <input type="checkbox" data-filter-account="${esc(a.id)}" ${state.filters.accounts.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}
      </label>`).join('')
    : `<span style="font-size:var(--text-sm);color:var(--muted)">No accounts for selected type</span>`;
  _attachFilterAccountCheckboxes(dropdown);
  const lbl = el('filterAccountLabel');
  if (lbl) lbl.textContent = state.filters.accounts.length
    ? state.filters.accounts.map(id => state.accountMap[id]?.name || id).join(', ')
    : 'All accounts';
}

function _attachFilterAccountCheckboxes(dropdown) {
  dropdown.querySelectorAll('[data-filter-account]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.filterAccount;
      if (cb.checked) { if (!state.filters.accounts.includes(id)) state.filters.accounts.push(id); }
      else { state.filters.accounts = state.filters.accounts.filter(x => x !== id); }
      const lbl = el('filterAccountLabel');
      if (lbl) lbl.textContent = state.filters.accounts.length
        ? state.filters.accounts.map(id => state.accountMap[id]?.name || id).join(', ')
        : 'All accounts';
    });
  });
}

function _refreshFilterMinorDropdown() {
  const dropdown = el('filterMinorDropdown');
  if (!dropdown) return;
  const minors = state.filters.major.length
    ? [...new Set(state.categories.filter(c => state.filters.major.includes(c.major_category)).map(c => c.minor_category))].sort()
    : [...new Set(state.categories.map(c => c.minor_category))].sort();
  const validSet = new Set(minors);
  state.filters.minor = state.filters.minor.filter(v => validSet.has(v));
  dropdown.innerHTML = minors.length
    ? minors.map(v => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
        <input type="checkbox" data-filter-minor="${esc(v)}" ${state.filters.minor.includes(v) ? 'checked' : ''}> ${esc(v)}
      </label>`).join('')
    : `<span style="font-size:var(--text-sm);color:var(--muted)">No minor categories</span>`;
  dropdown.querySelectorAll('[data-filter-minor]').forEach(cb => {
    cb.addEventListener('change', () => {
      const v = cb.dataset.filterMinor;
      if (cb.checked) { if (!state.filters.minor.includes(v)) state.filters.minor.push(v); }
      else { state.filters.minor = state.filters.minor.filter(x => x !== v); }
      const lbl = el('filterMinorLabel');
      if (lbl) lbl.textContent = state.filters.minor.length ? state.filters.minor.join(', ') : 'All minor';
    });
  });
  const lbl = el('filterMinorLabel');
  if (lbl) lbl.textContent = state.filters.minor.length ? state.filters.minor.join(', ') : 'All minor';
}

function _datalist(id, items) {
  // Always render the element so it exists in the DOM even before metadata loads.
  return `<datalist id="${esc(id)}">${(items || []).map(v => `<option value="${esc(String(v))}">`).join('')}</datalist>`;
}

function _attachTagAutocomplete(inputId, datalistId) {
  const input = el(inputId);
  const dl    = el(datalistId);
  if (!input || !dl) return;
  input.addEventListener('input', () => {
    const tags = state.metadata?.tags;
    if (!tags?.length) return;
    const val       = input.value;
    const lastComma = val.lastIndexOf(',');
    const prefix    = lastComma >= 0 ? val.slice(0, lastComma + 1) + ' ' : '';
    const partial   = val.slice(lastComma + 1).trimStart().toLowerCase();
    const existing  = new Set(val.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
    const hits      = tags.filter(t =>
      (!partial || t.toLowerCase().startsWith(partial)) && !existing.has(t.toLowerCase())
    );
    dl.innerHTML = hits.map(t => `<option value="${esc(prefix + t)}">`).join('');
  });
}

function _renderFilterBar() {
  const f        = state.filters;
  const allTypes = _txTypes();
  const allAccs  = state.accounts;
  const allMajor = [...new Set(state.categories.map(c => c.major_category))].sort();

  const allMinor = f.major.length
    ? [...new Set(state.categories.filter(c => f.major.includes(c.major_category)).map(c => c.minor_category))].sort()
    : [...new Set(state.categories.map(c => c.minor_category))].sort();

  const m = state.metadata;

  const activeChips = [
    ...f.types.map(t     => ({ label: _txTypeMap()[t] || t,              key: 'types',    val: t })),
    ...f.accounts.map(id => ({ label: state.accountMap[id]?.name || id,  key: 'accounts', val: id })),
    ...f.major.map(v     => ({ label: v,                                 key: 'major',    val: v })),
    ...f.minor.map(v     => ({ label: v,                                 key: 'minor',    val: v })),
    ...(f.user_location_country ? [{ label: 'Country: ' + f.user_location_country, key: 'user_location_country', val: '' }] : []),
    ...(f.user_location_city    ? [{ label: 'City: '    + f.user_location_city,    key: 'user_location_city',    val: '' }] : []),
    ...(f.user_location_area    ? [{ label: 'Area: '    + f.user_location_area,    key: 'user_location_area',    val: '' }] : []),
    ...(f.tag    ? [{ label: 'Tag: '    + f.tag,    key: 'tag',    val: '' }] : []),
    ...(f.search ? [{ label: 'Search: ' + f.search, key: 'search', val: '' }] : []),
  ];

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="filterToggle">
      Filters${activeChips.length ? ` (${activeChips.length})` : ''} <span class="filter-arrow">${filterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${filterOpen ? '' : 'hidden'}" id="filterBody">
      <div class="filter-row">
        <label>Type</label>
        <div id="filterTypeWrap" style="flex:1;min-width:120px;position:relative">
          <button id="filterTypeTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
            <span id="filterTypeLabel">${f.types.length ? f.types.map(t => _txTypeMap()[t] || t).join(', ') : 'All types'}</span>
            <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
          </button>
          <div id="filterTypeDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15)">
            ${allTypes.map(t => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
              <input type="checkbox" data-filter-type="${esc(t.value)}" ${f.types.includes(t.value) ? 'checked' : ''}> ${esc(t.label)}
            </label>`).join('')}
          </div>
        </div>
      </div>
      <div class="filter-row">
        <label>Account</label>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap">
          <div id="filterAccTypeWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterAccTypeTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
              <span id="filterAccTypeLabel">${_accTypeDropdownLabel()}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterAccTypeDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15)">
              ${[...new Set(state.accounts.map(a => a.type))].map(type => {
                const count = state.accounts.filter(a => a.type === type).length;
                return `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
                  <input type="checkbox" data-acc-type="${esc(type)}" ${_accTypeSel.has(type) ? 'checked' : ''}> ${esc(_fmtAccType(type))} <span style="color:var(--muted);font-size:var(--text-xs)">(${count})</span>
                </label>`;
              }).join('')}
            </div>
          </div>
          <div id="filterAccountWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterAccountTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
              <span id="filterAccountLabel">${f.accounts.length ? f.accounts.map(id => state.accountMap[id]?.name || id).join(', ') : 'All accounts'}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterAccountDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);max-height:200px;overflow-y:auto">
              ${_accountsForTypeSel().map(a => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
                <input type="checkbox" data-filter-account="${esc(a.id)}" ${f.accounts.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}
              </label>`).join('') || `<span style="font-size:var(--text-sm);color:var(--muted)">No accounts</span>`}
            </div>
          </div>
        </div>
      </div>
      <div class="filter-row">
        <label>Category</label>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap">
          <div id="filterMajorWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterMajorTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
              <span id="filterMajorLabel">${f.major.length ? f.major.join(', ') : 'All major'}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterMajorDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);max-height:240px;overflow-y:auto">
              ${allMajor.map(v => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
                <input type="checkbox" data-filter-major="${esc(v)}" ${f.major.includes(v) ? 'checked' : ''}> ${esc(v)}
              </label>`).join('')}
            </div>
          </div>
          <div id="filterMinorWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterMinorTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
              <span id="filterMinorLabel">${f.minor.length ? f.minor.join(', ') : 'All minor'}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterMinorDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);max-height:240px;overflow-y:auto">
              ${allMinor.length
                ? allMinor.map(v => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
                    <input type="checkbox" data-filter-minor="${esc(v)}" ${f.minor.includes(v) ? 'checked' : ''}> ${esc(v)}
                  </label>`).join('')
                : `<span style="font-size:var(--text-sm);color:var(--muted)">No minor categories</span>`}
            </div>
          </div>
        </div>
      </div>
      <div class="filter-row">
        <label>Location</label>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="filterCountry" value="${esc(f.user_location_country)}" list="dlFCountry" placeholder="Country" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFCountry', m?.countries)}
          <input type="text" id="filterCity" value="${esc(f.user_location_city)}" list="dlFCity" placeholder="City" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFCity', m?.cities)}
          <input type="text" id="filterArea" value="${esc(f.user_location_area)}" list="dlFArea" placeholder="Area" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFArea', m?.areas)}
        </div>
      </div>
      <div class="filter-row">
        <label>Tag</label>
        <input type="text" id="filterTag" value="${esc(f.tag)}" placeholder="any tag" list="dlFTag" autocomplete="off">
        ${_datalist('dlFTag', m?.tags)}
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="filterSearch" value="${esc(f.search)}" placeholder="counterparty or notes">
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="clearFilters">Clear</button>
        <button class="btn btn-primary btn-sm" id="applyFilters">Search</button>
      </div>
    </div>
  </div>`;
}

// ── Transaction CSV import ────────────────────────────────────────────────────

function _renderTxImportPanel() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import transactions from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="txImportFile">CSV file</label>
        <input type="file" id="txImportFile" accept=".csv">
        <div class="field-hint">Columns: tx_date_time, tx_timezone, tx_type, source_account, target_account, user_location_area, user_location_city, user_location_country, user_location_latitude, user_location_longitude, amount, currency, major_category, minor_category, description, counterparty_name, tx_tags, beneficiaries</div>
      </div>
    </div>
    <div id="txImportStatus"></div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="txImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="txImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="txImportError"></div>
  </div>`;
}

function _parseTxCsvRow(line) {
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

function _parseTxCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { transactions: [], errors: ['File is empty.'] };

  const headers  = _parseTxCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const nameToId = {};
  (state.accounts || []).forEach(a => { nameToId[a.name.trim().toLowerCase()] = a.id; });

  const transactions = [];
  const errors       = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = _parseTxCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });

    const rowErrors = [];
    if (!row.tx_date_time)    rowErrors.push('missing tx_date_time');
    if (!row.tx_type)         rowErrors.push('missing tx_type');
    if (!row.amount)          rowErrors.push('missing amount');
    if (!row.currency)        rowErrors.push('missing currency');
    if (!row.major_category)  rowErrors.push('missing major_category');
    if (!row.minor_category)  rowErrors.push('missing minor_category');

    let sourceId = '';
    let targetId = '';
    if (row.source_account) {
      sourceId = nameToId[row.source_account.toLowerCase()] || '';
      if (!sourceId) rowErrors.push(`unknown account: "${row.source_account}"`);
    }
    if (row.target_account) {
      targetId = nameToId[row.target_account.toLowerCase()] || '';
      if (!targetId) rowErrors.push(`unknown account: "${row.target_account}"`);
    }

    if (rowErrors.length) { errors.push(`Row ${i + 1}: ${rowErrors.join('; ')}`); continue; }

    const tx_date_time = localToUtcISO(row.tx_date_time);

    transactions.push({
      tx_date_time,
      tx_timezone:              row.tx_timezone || '',
      tx_type:                  row.tx_type,
      source_account:           sourceId,
      target_account:           targetId,
      user_location_area:       row.user_location_area    || '',
      user_location_city:       row.user_location_city    || '',
      user_location_country:    row.user_location_country || '',
      user_location_latitude:   row.user_location_latitude  !== '' ? parseFloat(row.user_location_latitude)  : '',
      user_location_longitude:  row.user_location_longitude !== '' ? parseFloat(row.user_location_longitude) : '',
      amount:                   parseFloat(row.amount),
      currency:                 row.currency.toUpperCase(),
      major_category:           row.major_category,
      minor_category:           row.minor_category,
      description:              row.description || '',
      counterparty_name:        row.counterparty_name || '',
      tx_tags:                  row.tx_tags || '',
      beneficiaries:            row.beneficiaries || '',
      _src_name:                row.source_account,
      _tgt_name:                row.target_account,
    });
  }

  return { transactions, errors };
}

function _renderTxImportStatus(parsed) {
  const { transactions, errors } = parsed;
  const errHtml = errors.length
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (!transactions.length) return errHtml + '<p class="placeholder">No valid rows found.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${transactions.length} transaction${transactions.length !== 1 ? 's' : ''} ready to import</p>`;
}

async function _submitTxImport(transactions) {
  const btn   = el('txImportConfirm');
  const errEl = el('txImportError');
  if (btn)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl) errEl.textContent = '';
  showLoading();
  try {
    // Strip display-only fields before sending
    const payload = transactions.map(tx => {
      const clean = Object.assign({}, tx);
      delete clean._src_name;
      delete clean._tgt_name;
      return clean;
    });

    const res = await ExpenseAPI.createTransactionsBulk({ transactions: payload });

    if (!res.ok && !res.results) {
      console.warn('[transactions] _submitTxImport failed:', res?.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error || 'unknown');
      if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }

    const created = res.created || 0;
    const skipped = res.skipped || 0;
    const failed  = res.failed  || 0;

    if (failed === 0) {
      _txImportParsed = null;
      state.txImportOpen = false;
      const msg = [
        created ? `${created} transaction${created !== 1 ? 's' : ''} imported` : '',
        skipped ? `${skipped} already existed` : '',
      ].filter(Boolean).join(' · ');
      showMsg(msg || 'Nothing to import.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      // Keep panel open — show per-row results so user can see what failed and why
      const resultRows = (res.results || []).map(r => `
        <tr>
          <td style="font-size:12px;color:var(--muted)">${esc(r.label || '')}</td>
          <td>${r.ok
            ? `<span class="badge badge-et-in">created</span>`
            : r.error === 'duplicate_transaction'
              ? `<span class="badge" style="color:var(--muted)">already exists</span>`
              : `<span class="badge badge-et-out">${esc(r.error || 'unknown')}</span>`}
          </td>
        </tr>`).join('');
      const status = el('txImportStatus');
      if (status) status.innerHTML = `
        <div style="margin-bottom:8px;font-size:13px">${created} created${skipped ? ` · ${skipped} already existed` : ''} · <span style="color:var(--ember)">${failed} failed</span></div>
        <div class="table-wrap" style="margin-bottom:8px">
          <table>
            <thead><tr><th>Transaction</th><th>Result</th></tr></thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>`;
      _txImportParsed = null;
      if (btn) { btn.disabled = true; btn.textContent = 'Import'; }
      if (created > 0) { document.dispatchEvent(new CustomEvent('et:reload')); }
      showMsg(`${created} imported · ${skipped} skipped · ${failed} failed`, 'warn');
    }
  } catch (err) {
    console.error('[transactions] _submitTxImport failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
    if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}

function _attachSuggestionEvents() {
  el('suggestionsToggle')?.addEventListener('click', () => {
    state.suggestionsOpen = !state.suggestionsOpen;
    renderTransactions();
  });
}

function _positionDropdown(triggerId, dropdownId) {
  const trigger  = el(triggerId);
  const dropdown = el(dropdownId);
  if (!trigger || !dropdown) return;
  const rect = trigger.getBoundingClientRect();
  dropdown.style.top   = (rect.bottom + 4) + 'px';
  dropdown.style.left  = rect.left + 'px';
  dropdown.style.width = rect.width + 'px';
}

const _FILTER_DROPDOWN_IDS = ['filterTypeDropdown','filterAccTypeDropdown','filterAccountDropdown','filterMajorDropdown','filterMinorDropdown'];
const _FILTER_WRAP_IDS     = ['filterTypeWrap','filterAccTypeWrap','filterAccountWrap','filterMajorWrap','filterMinorWrap'];

function _closeAllFilterDropdowns(exceptId) {
  _FILTER_DROPDOWN_IDS.forEach(id => { if (id !== exceptId) el(id)?.classList.add('hidden'); });
}

function _attachFilterEvents() {
  el('filterToggle')?.addEventListener('click', () => { filterOpen = !filterOpen; renderTransactions(); });

  const typeTrigger  = el('filterTypeTrigger');
  const typeDropdown = el('filterTypeDropdown');
  const typeWrap     = el('filterTypeWrap');
  if (typeTrigger && typeDropdown) {
    typeTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = typeDropdown.classList.contains('hidden');
      if (opening) _closeAllFilterDropdowns('filterTypeDropdown');
      typeDropdown.classList.toggle('hidden');
      if (opening) _positionDropdown('filterTypeTrigger', 'filterTypeDropdown');
    });
    typeDropdown.querySelectorAll('[data-filter-type]').forEach(cb => {
      cb.addEventListener('change', () => {
        const t = cb.dataset.filterType;
        if (cb.checked) { if (!state.filters.types.includes(t)) state.filters.types.push(t); }
        else { state.filters.types = state.filters.types.filter(x => x !== t); }
        const lbl = el('filterTypeLabel');
        if (lbl) lbl.textContent = state.filters.types.length ? state.filters.types.map(v => _txTypeMap()[v] || v).join(', ') : 'All types';
      });
    });
  }

  // ── Account type dropdown ──
  const accTypeTrigger  = el('filterAccTypeTrigger');
  const accTypeDropdown = el('filterAccTypeDropdown');
  if (accTypeTrigger && accTypeDropdown) {
    accTypeTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = accTypeDropdown.classList.contains('hidden');
      if (opening) _closeAllFilterDropdowns('filterAccTypeDropdown');
      accTypeDropdown.classList.toggle('hidden');
      if (opening) _positionDropdown('filterAccTypeTrigger', 'filterAccTypeDropdown');
    });
    accTypeDropdown.querySelectorAll('[data-acc-type]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _accTypeSel.add(cb.dataset.accType);
        else            _accTypeSel.delete(cb.dataset.accType);
        const lbl = el('filterAccTypeLabel');
        if (lbl) lbl.textContent = _accTypeDropdownLabel();
        _refreshFilterAccountDropdown();
      });
    });
  }

  // ── Account dropdown ──
  const acctTrigger  = el('filterAccountTrigger');
  const acctDropdown = el('filterAccountDropdown');
  if (acctTrigger && acctDropdown) {
    acctTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = acctDropdown.classList.contains('hidden');
      if (opening) _closeAllFilterDropdowns('filterAccountDropdown');
      acctDropdown.classList.toggle('hidden');
      if (opening) _positionDropdown('filterAccountTrigger', 'filterAccountDropdown');
    });
    _attachFilterAccountCheckboxes(acctDropdown);
  }

  // ── Major category dropdown ──
  const majorTrigger  = el('filterMajorTrigger');
  const majorDropdown = el('filterMajorDropdown');
  if (majorTrigger && majorDropdown) {
    majorTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = majorDropdown.classList.contains('hidden');
      if (opening) _closeAllFilterDropdowns('filterMajorDropdown');
      majorDropdown.classList.toggle('hidden');
      if (opening) _positionDropdown('filterMajorTrigger', 'filterMajorDropdown');
    });
    majorDropdown.querySelectorAll('[data-filter-major]').forEach(cb => {
      cb.addEventListener('change', () => {
        const v = cb.dataset.filterMajor;
        if (cb.checked) { if (!state.filters.major.includes(v)) state.filters.major.push(v); }
        else { state.filters.major = state.filters.major.filter(x => x !== v); }
        const lbl = el('filterMajorLabel');
        if (lbl) lbl.textContent = state.filters.major.length ? state.filters.major.join(', ') : 'All major';
        _refreshFilterMinorDropdown();
      });
    });
  }

  // ── Minor category dropdown ──
  const minorTrigger  = el('filterMinorTrigger');
  const minorDropdown = el('filterMinorDropdown');
  if (minorTrigger && minorDropdown) {
    minorTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = minorDropdown.classList.contains('hidden');
      if (opening) _closeAllFilterDropdowns('filterMinorDropdown');
      minorDropdown.classList.toggle('hidden');
      if (opening) _positionDropdown('filterMinorTrigger', 'filterMinorDropdown');
    });
    minorDropdown.querySelectorAll('[data-filter-minor]').forEach(cb => {
      cb.addEventListener('change', () => {
        const v = cb.dataset.filterMinor;
        if (cb.checked) { if (!state.filters.minor.includes(v)) state.filters.minor.push(v); }
        else { state.filters.minor = state.filters.minor.filter(x => x !== v); }
        const lbl = el('filterMinorLabel');
        if (lbl) lbl.textContent = state.filters.minor.length ? state.filters.minor.join(', ') : 'All minor';
      });
    });
  }

  // ── Global outside-click: close all dropdowns when clicking outside every wrap ──
  document.addEventListener('click', e => {
    const inAnyWrap = _FILTER_WRAP_IDS.some(id => el(id)?.contains(e.target));
    if (!inAnyWrap) _closeAllFilterDropdowns();
  });

  const bindText = (id, key) => el(id)?.addEventListener('input', e => {
    state.filters[key] = e.target.value.trim();
  });

  bindText('filterCountry', 'user_location_country');
  bindText('filterCity',    'user_location_city');
  bindText('filterArea',    'user_location_area');
  bindText('filterTag',     'tag');
  bindText('filterSearch',  'search');
  _attachTagAutocomplete('filterTag', 'dlFTag');

  el('applyFilters')?.addEventListener('click', () => {
    state.txPage = 1; renderTransactions();
  });

  el('clearFilters')?.addEventListener('click', () => {
    _accTypeSel.clear();
    state.filters = { types:[], accounts:[], major:[], minor:[], user_location_country:'', user_location_city:'', user_location_area:'', tag:'', search:'' };
    state.txPage = 1; renderTransactions();
  });

  el('transactionsContent')?.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.chipKey;
      const val = btn.dataset.chipVal;
      if (Array.isArray(state.filters[key])) state.filters[key] = state.filters[key].filter(x => x !== val);
      else state.filters[key] = '';
      state.txPage = 1; renderTransactions();
    });
  });
}
