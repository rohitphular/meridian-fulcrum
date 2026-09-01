import { state } from '../core/state.js';
import { el, esc, fmtDateTime, fmtDateTimeCompact, fmtNative, fmtBase, nowLocalISO, toDateInputVal, exportData, getSymbol, localToUtcISO, utcToLocalInput, openContextMenu, closeContextMenu, syncStatusIcon, recordStatusIcon, parseCsvRow } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { filteredTx, getRangeBounds } from '../core/daterange.js';
import { ExpenseAPI } from '../core/api.js';

const SUGGESTIONS_CACHE_KEY = 'et_suggestions_v1';
const SUGGESTIONS_TTL_MS    = 6 * 60 * 60 * 1000;

const METADATA_CACHE_KEY = 'et_metadata_v1';
const METADATA_TTL_MS    = 6 * 60 * 60 * 1000;

let filterOpen         = false;
let _txImportParsed    = null;
let _filterEventsAbort = null;
let _txImportResult  = null;   // persists failure table HTML across re-renders
let _txMenuKey      = null;
let _txEventsAbort  = null;
let _accTypeSel     = new Set();
let _siblingMap     = {};   // tx.id → sibling tx; rebuilt only when state.transactions reference changes
let _siblingMapSrc  = null; // the state.transactions array that produced _siblingMap

function _buildSiblingMap(allTx) {
  const byId = {};
  allTx.forEach(tx => { if (tx.id) byId[tx.id] = tx; });
  const out = {};
  allTx.forEach(tx => {
    if (tx.parent_tx_id === undefined || tx.parent_tx_id === null || String(tx.parent_tx_id).trim() === '') return;
    const parent = byId[tx.parent_tx_id];
    if (parent === undefined || parent === null) return;
    out[tx.id]     = parent;
    out[parent.id] = tx;
  });
  return out;
}

function _dispatchTxAction(action, row) {
  if (action === 'tx-view')           { state.txViewRow = row; state.txEditRow = null; state.txDeleteRow = null; state.txAddOpen = false; renderTransactions(); }
  if (action === 'tx-cancel-view')    { state.txViewRow = null; renderTransactions(); }
  if (action === 'tx-edit')           { state.txEditRow = row; state.txDeleteRow = null; state.txViewRow = null; state.txAddOpen = false; renderTransactions(); }
  if (action === 'tx-cancel-edit')    { state.txEditRow = null; renderTransactions(); }
  if (action === 'tx-save-edit')      { _saveEdit(); }
  if (action === 'tx-delete')         { state.txDeleteRow = row; state.txEditRow = null; state.txViewRow = null; state.txAddOpen = false; renderTransactions(); }
  if (action === 'tx-cancel-delete')  { state.txDeleteRow = null; renderTransactions(); }
  if (action === 'tx-confirm-delete') { _confirmDelete(row); }
  if (action === 'tx-restore')        { _restoreTx(row); }
  if (action === 'tx-copy') {
    const tx = state.transactions.find(t => t._row === row);
    if (tx === undefined || tx === null) return;
    const _copySibling = _siblingMap[tx.id] !== undefined ? _siblingMap[tx.id] : null;
    // Reconstruct source/target for the add form (which still uses source/target format)
    let _cpySrcAcc = '', _cpyTgtAcc = '', _cpySrcAmt = Number(tx.tx_amount), _cpyTgtAmt = '';
    if (tx.tx_type === 'money-out') {
      _cpySrcAcc = (tx.account_id !== undefined && tx.account_id !== null) ? tx.account_id : '';
      if (_copySibling !== null && _copySibling.tx_type === 'money-in') {
        _cpyTgtAcc = (_copySibling.account_id !== undefined && _copySibling.account_id !== null) ? _copySibling.account_id : '';
        _cpyTgtAmt = Number(_copySibling.tx_amount) !== _cpySrcAmt ? String(_copySibling.tx_amount) : '';
      }
    } else {
      _cpyTgtAcc = (tx.account_id !== undefined && tx.account_id !== null) ? tx.account_id : '';
      if (_copySibling !== null && _copySibling.tx_type === 'money-out') {
        _cpySrcAcc = (_copySibling.account_id !== undefined && _copySibling.account_id !== null) ? _copySibling.account_id : '';
        _cpySrcAmt = Number(_copySibling.tx_amount);
      }
    }
    state.txCopyPrefill = {
      tx_type:              (tx.tx_type              !== undefined && tx.tx_type              !== null) ? tx.tx_type              : '',
      major_category:       (tx.major_category       !== undefined && tx.major_category       !== null) ? tx.major_category       : '',
      minor_category:       (tx.minor_category       !== undefined && tx.minor_category       !== null) ? tx.minor_category       : '',
      source_account:       _cpySrcAcc,
      target_account:       _cpyTgtAcc,
      source_amount:        _cpySrcAmt,
      target_amount:        _cpyTgtAmt,
      counterparty_name:    (tx.counterparty_name    !== undefined && tx.counterparty_name    !== null) ? tx.counterparty_name    : '',
      user_location_area:   (tx.user_location_area   !== undefined && tx.user_location_area   !== null) ? tx.user_location_area   : '',
      user_location_city:   (tx.user_location_city   !== undefined && tx.user_location_city   !== null) ? tx.user_location_city   : '',
      user_location_country: (tx.user_location_country !== undefined && tx.user_location_country !== null) ? tx.user_location_country : '',
      tx_tags:              (tx.tx_tags              !== undefined && tx.tx_tags              !== null) ? tx.tx_tags              : '',
      description:          (tx.description          !== undefined && tx.description          !== null) ? tx.description          : '',
    };
    state.txAddOpen   = true;
    state.txEditRow   = null;
    state.txViewRow   = null;
    state.txDeleteRow = null;
    renderTransactions();
  }
  if (action === 'tx-mark-sub') {
    const tx = state.transactions.find(t => t._row === row);
    if (tx === undefined || tx === null) return;
    if (_isAlreadySubscribed(tx)) { showMsg('Already tracked as a subscription.', 'warn'); return; }
    const _subAcct = (state.accountMap[tx.account_id] !== undefined && state.accountMap[tx.account_id] !== null) ? state.accountMap[tx.account_id] : {};
    state.subPrefill = {
      name:              (tx.counterparty_name !== undefined && tx.counterparty_name !== null) ? tx.counterparty_name : '',
      counterparty_name: (tx.counterparty_name !== undefined && tx.counterparty_name !== null) ? tx.counterparty_name : '',
      amount:            Number(tx.tx_amount),
      currency:          (_subAcct.currency !== undefined && _subAcct.currency !== null) ? _subAcct.currency : '',
      source_account:    (tx.account_id !== undefined && tx.account_id !== null) ? tx.account_id : '',
      tx_type:           (tx.tx_type !== undefined && tx.tx_type !== null) ? tx.tx_type : '',
      major_category:    (tx.major_category !== undefined && tx.major_category !== null) ? tx.major_category : '',
      minor_category:    (tx.minor_category !== undefined && tx.minor_category !== null) ? tx.minor_category : '',
      tx_tags:           (tx.tx_tags !== undefined && tx.tx_tags !== null) ? tx.tx_tags : '',
    };
    state.subAddOpen = true;
    document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'subscriptions' }));
  }
}

// ── Category dropdown helpers — respect record_status (greyed-out when archived) ──

// Major <option> list for a transaction type. Values are major_category_key.
// A major is active if at least one of its minors is active.
function _catMajorOpts(type, selectedVal = '') {
  const cats = state.categories.filter(c => c.tx_type_key === type);
  const majors = [...new Map(cats.map(c => {
    const active = cats.some(x => x.major_category_key === c.major_category_key && x.record_status === 'active');
    return [c.major_category_key, { key: c.major_category_key, label: c.major_category_label, active }];
  })).values()];
  return `<option value="">— select —</option>` +
    majors.map(({ key, label, active }) => {
      const sel = selectedVal === key ? 'selected' : '';
      return active
        ? `<option value="${esc(key)}" ${sel}>${esc(label)}</option>`
        : `<option value="${esc(key)}" ${sel} disabled style="color:var(--muted)">${esc(label)} (archived)</option>`;
    }).join('');
}

// Minor <option> list for a type + major key combo. Values are minor_category_key.
function _catMinorOpts(type, majorKey, selectedVal = '') {
  const cats = state.categories.filter(c => c.tx_type_key === type && c.major_category_key === majorKey);
  return `<option value="">— select —</option>` +
    cats.map(c => {
      const sel = selectedVal === c.minor_category_key ? 'selected' : '';
      return c.record_status === 'active'
        ? `<option value="${esc(c.minor_category_key)}" ${sel}>${esc(c.minor_category_label)}</option>`
        : `<option value="${esc(c.minor_category_key)}" ${sel} disabled style="color:var(--muted)">${esc(c.minor_category_label)} (archived)</option>`;
    }).join('');
}

// ── Account dropdown helpers — filter by category source/dest account types ──

// Looks up a category by type + major_category_key + minor_category_key.
function _getCat(type, majorKey, minorKey) {
  if (type === undefined || type === null || String(type).trim() === '' ||
      majorKey === undefined || majorKey === null || String(majorKey).trim() === '' ||
      minorKey === undefined || minorKey === null || String(minorKey).trim() === '') return null;
  const result = state.categories.find(c =>
    c.tx_type_key        === type &&
    c.major_category_key === majorKey &&
    c.minor_category_key === minorKey
  );
  return result !== undefined ? result : null;
}

// Normalizes stored major/minor values to keys — accepts both keys (new data)
// and labels (old sheet data before migration). Returns {majorKey, minorKey}.
function _normCatKeys(type, majorVal, minorVal) {
  if (majorVal === undefined || majorVal === null || String(majorVal).trim() === '') return { majorKey: '', minorKey: '' };
  const minorProvided = minorVal !== undefined && minorVal !== null && String(minorVal).trim() !== '';
  // Try key match first
  let cat = state.categories.find(c =>
    c.tx_type_key        === type &&
    c.major_category_key === majorVal &&
    (!minorProvided || c.minor_category_key === minorVal)
  );
  if (cat !== undefined && cat !== null) return { majorKey: cat.major_category_key, minorKey: (minorVal !== undefined && minorVal !== null) ? minorVal : '' };
  // Fall back to label match (old sheet data)
  cat = state.categories.find(c =>
    c.tx_type_key          === type &&
    c.major_category_label === majorVal &&
    (!minorProvided || c.minor_category_label === minorVal)
  );
  if (cat !== undefined && cat !== null) return { majorKey: cat.major_category_key, minorKey: (minorVal !== undefined && minorVal !== null && minorVal !== '') ? cat.minor_category_key : '' };
  return { majorKey: majorVal, minorKey: (minorVal !== undefined && minorVal !== null) ? minorVal : '' };
}

// Resolves stored keys (or legacy labels) to display string. Falls back gracefully.
function _catLabel(type, majorVal, minorVal) {
  if ((majorVal === undefined || majorVal === null || String(majorVal).trim() === '') &&
      (minorVal === undefined || minorVal === null || String(minorVal).trim() === '')) return '—';
  const { majorKey, minorKey } = _normCatKeys(type, majorVal, minorVal);
  const cat = _getCat(type, majorKey, minorKey);
  if (cat !== undefined && cat !== null) return cat.major_category_label + ' → ' + cat.minor_category_label;
  return [majorVal, minorVal].filter(v => v !== undefined && v !== null && v !== '').join(' → ');
}

// Formats beneficiaries string (e.g. "Alice:60;Bob:40") as readable HTML chips.
function _fmtBeneficiaries(str) {
  if (str === undefined || str === null || String(str).trim() === '') return '—';
  return str.split(';').map(part => {
    const idx = part.indexOf(':');
    if (idx === -1) return esc(part.trim());
    const name = part.slice(0, idx).trim();
    const pct  = part.slice(idx + 1).trim();
    return `${esc(name)} <span style="color:var(--muted)">(${esc(pct)}%)</span>`;
  }).join(' &middot; ');
}

// Forward geocode: area+city+country → lat/lon via Nominatim.
async function _geocodeCity(areaId, cityId, countryId, latId, lonId) {
  const area    = el(areaId)    !== null && el(areaId)    !== undefined ? el(areaId).value    : '';
  const city    = el(cityId)    !== null && el(cityId)    !== undefined ? el(cityId).value    : '';
  const country = el(countryId) !== null && el(countryId) !== undefined ? el(countryId).value : '';
  if (area === '' && city === '' && country === '') return;
  const latEl = el(latId);
  const lonEl = el(lonId);
  if (latEl === null || latEl === undefined || lonEl === null || lonEl === undefined) return;
  if (latEl.value !== '' && lonEl.value !== '') return; // already set
  try {
    const q   = encodeURIComponent([area, city, country].filter(v => v !== undefined && v !== null && v !== '').join(', '));
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (data !== null && data !== undefined && data[0] !== undefined && data[0] !== null) {
      latEl.value = parseFloat(data[0].lat).toFixed(6);
      lonEl.value = parseFloat(data[0].lon).toFixed(6);
    }
  } catch (_) {}
}

// Reverse geocode: lat/lon → area/city/country via Nominatim.
async function _reverseGeocode(latId, lonId, areaId, cityId, countryId) {
  const latEl = el(latId);
  const lonEl = el(lonId);
  if (latEl === null || latEl === undefined || lonEl === null || lonEl === undefined) return;
  const lat = latEl.value.trim();
  const lon = lonEl.value.trim();
  if (lat === '' || lon === '') return;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (data !== null && data !== undefined && data.address !== undefined && data.address !== null) {
      const addr     = data.address;
      const cityEl   = el(cityId);
      const ctryEl   = el(countryId);
      const areaEl   = el(areaId);
      if (cityEl !== null && cityEl !== undefined && cityEl.value === '') cityEl.value   = (addr.city !== undefined && addr.city !== null) ? addr.city : ((addr.town !== undefined && addr.town !== null) ? addr.town : ((addr.village !== undefined && addr.village !== null) ? addr.village : ((addr.municipality !== undefined && addr.municipality !== null) ? addr.municipality : '')));
      if (ctryEl !== null && ctryEl !== undefined && ctryEl.value === '') ctryEl.value   = (addr.country !== undefined && addr.country !== null) ? addr.country : '';
      if (areaEl !== null && areaEl !== undefined && areaEl.value === '') areaEl.value   = (addr.suburb !== undefined && addr.suburb !== null) ? addr.suburb : ((addr.neighbourhood !== undefined && addr.neighbourhood !== null) ? addr.neighbourhood : ((addr.county !== undefined && addr.county !== null) ? addr.county : ''));
    }
  } catch (_) {}
}

// ── Subscription eligibility helpers ─────────────────────────────────────────

function _isCatSubEligible(tx) {
  if (tx.major_category === undefined || tx.major_category === null || String(tx.major_category).trim() === '' ||
      tx.minor_category === undefined || tx.minor_category === null || String(tx.minor_category).trim() === '') return false;
  const { majorKey, minorKey } = _normCatKeys(tx.tx_type, tx.major_category, tx.minor_category);
  const cat = _getCat(tx.tx_type, majorKey, minorKey);
  if (cat === undefined || cat === null) return false;
  return cat.is_subscription_eligible === true;
}

function _normTags(str) {
  return new Set(
    String(str !== undefined && str !== null ? str : '').split(';').map(t => t.trim().toLowerCase()).filter(v => v !== '')
  );
}

function _isAlreadySubscribed(tx) {
  const normCp = (tx.counterparty_name !== undefined && tx.counterparty_name !== null ? tx.counterparty_name : '').trim().toLowerCase();
  if (normCp === '') return false;
  const txTags = _normTags(tx.tx_tags);
  return state.subscriptions.some(s => {
    const sCp = (s.counterparty_name !== undefined && s.counterparty_name !== null ? s.counterparty_name : '').trim().toLowerCase();
    if (sCp !== normCp) return false;
    const sTags = _normTags(s.tags);
    // Match if both have no tags, OR at least one tag overlaps
    return (txTags.size === 0 && sTags.size === 0) || [...txTags].some(t => sTags.has(t));
  });
}

// Returns <option> elements filtered to allowedTypesStr account types.
// Shows all accounts when no types are configured for the category.
function _acctOptsWithHints(accounts, allowedTypesStr, selectedId = '') {
  const allowed = allowedTypesStr
    ? new Set(allowedTypesStr.split(',').map(s => s.trim().toLowerCase()).filter(v => v !== undefined && v !== null && v !== ''))
    : new Set();
  const filtered = allowed.size
    ? accounts.filter(a => allowed.has((a.type !== undefined && a.type !== null ? a.type : '').toLowerCase()) || allowed.has((a.sub_type !== undefined && a.sub_type !== null ? a.sub_type : '').toLowerCase()))
    : accounts;
  return filtered.map(a =>
    `<option value="${esc(a.id)}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)} (${esc(a.currency)})</option>`
  ).join('');
}

// ── Transaction schema helpers ────────────────────────────────────────────────

function _txTypes() {
  const all = (state.transactionSchema !== undefined && state.transactionSchema !== null && state.transactionSchema.types !== undefined && state.transactionSchema.types !== null) ? state.transactionSchema.types : [];
  return all.filter(t => t.value === 'money-in' || t.value === 'money-out');
}
function _txTypeMap() {
  return Object.fromEntries(_txTypes().map(t => [t.value, t.label]));
}

export function renderTransactions() {
  _txMenuKey = null;
  if (state.transactions !== _siblingMapSrc) {
    _siblingMap    = _buildSiblingMap(state.transactions);
    _siblingMapSrc = state.transactions;
  }

  // Load suggestions: serve from localStorage cache (6 h TTL), else fetch from API.
  if (!state.suggestionsLoaded) {
    state.suggestionsLoaded = true;
    let servedFromCache = false;
    try {
      const raw = localStorage.getItem(SUGGESTIONS_CACHE_KEY);
      if (raw !== null && raw !== undefined && raw !== '') {
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
          state.suggestions = (res.data !== undefined && res.data !== null) ? res.data : [];
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
      if (raw !== null && raw !== undefined && raw !== '') {
        const { metadata, ts } = JSON.parse(raw);
        if (metadata !== undefined && metadata !== null && Date.now() - ts < METADATA_TTL_MS) {
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
            countries:      (res.countries      !== undefined && res.countries      !== null) ? res.countries      : [],
            cities:         (res.cities         !== undefined && res.cities         !== null) ? res.cities         : [],
            areas:          (res.areas          !== undefined && res.areas          !== null) ? res.areas          : [],
            counterparties: (res.counterparties !== undefined && res.counterparties !== null) ? res.counterparties : [],
            tags:           (res.tx_tags        !== undefined && res.tx_tags        !== null) ? res.tx_tags        : [],
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

  const _rawTypes   = (state.transactionSchema !== undefined && state.transactionSchema !== null && state.transactionSchema.types !== undefined && state.transactionSchema.types !== null) ? state.transactionSchema.types : [];
  const _validTypes = new Set(_rawTypes.length
    ? _rawTypes.map(t => (typeof t === 'string' ? t : t.value))
    : ['money-in', 'money-out']);
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
    ${_renderFilterBar()}
    ${_renderSuggestionsPanel()}
    ${warnRows.length ? `<div class="warning-count" id="warnToggle">⚠ ${warnRows.length} row${warnRows.length > 1 ? 's' : ''} have warnings — click to expand</div>` : ''}
    ${_renderTxTable(validRows, warnRows)}
  `;

  el('txImportBtn').addEventListener('click', () => {
    if (state.txImportOpen) {
      state.txImportOpen = false;
      _txImportParsed = null;
      _txImportResult = null;
    } else {
      state.txImportOpen = true;
      state.txAddOpen = false;
      state.txViewRow = null;
      state.txEditRow = null;
    }
    renderTransactions();
  });

  el('txAddBtn').addEventListener('click', () => {
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

  if (state.txImportOpen) {
    el('txImportFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file === undefined || file === null) return;
      _txImportResult = null;
      const reader = new FileReader();
      reader.onload = ev => {
        const parsed = _parseTxCsv(ev.target.result);
        _txImportParsed = parsed.transactions.length > 0 ? parsed.transactions : null;
        el('txImportStatus').innerHTML = _renderTxImportStatus(parsed);
        el('txImportConfirm').disabled = _txImportParsed === null;
      };
      reader.readAsText(file);
    });

    el('txImportConfirm').addEventListener('click', async () => {
      if (_txImportParsed === null) return;
      _submitTxImport(await _geocodeImportRows(_txImportParsed));
    });

    el('txImportCancel').addEventListener('click', () => {
      state.txImportOpen = false;
      _txImportParsed = null;
      _txImportResult = null;
      renderTransactions();
    });
  }

  _attachSuggestionEvents();
  _attachFilterEvents();
  if (state.txAddOpen) _attachAddFormEvents();
  if (editTx) _attachTxEditCascadeEvents();
  _attachEvents();

  el('txExportBtn').addEventListener('click', () => {
    if (rows.length === 0) { showMsg('No transactions to export.', 'warn'); return; }
    openContextMenu(el('txExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => exportData(key, rows));
  });

  if (warnRows.length) {
    el('warnToggle').addEventListener('click', () => el('warnTable').classList.toggle('hidden'));
  }
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

    const badgeCls    = tx.tx_type === 'money-in' ? 'badge-et-in' : tx.tx_type === 'money-out' ? 'badge-et-out' : 'badge-et-transfer';
    const typeLabel   = (_txTypeMap()[tx.tx_type] !== undefined && _txTypeMap()[tx.tx_type] !== null) ? _txTypeMap()[tx.tx_type] : tx.tx_type;
    const _txAccTbl   = (state.accountMap[tx.account_id] !== undefined && state.accountMap[tx.account_id] !== null) ? state.accountMap[tx.account_id] : {};
    const txCur       = (_txAccTbl.currency !== undefined && _txAccTbl.currency !== null) ? _txAccTbl.currency : '';
    const missingRate = state.rateMap[txCur] === undefined || state.rateMap[txCur] === null;
    const displayAmt  = Number(tx.tx_amount);
    const acctName    = (_txAccTbl.name !== undefined && _txAccTbl.name !== null) ? _txAccTbl.name : '—';
    const _sibling    = (_siblingMap[tx.id] !== undefined && _siblingMap[tx.id] !== null) ? _siblingMap[tx.id] : null;
    const _sibAccTbl  = _sibling !== null ? ((state.accountMap[_sibling.account_id] !== undefined && state.accountMap[_sibling.account_id] !== null) ? state.accountMap[_sibling.account_id] : {}) : null;
    const _sibAccTblName = (_sibAccTbl !== null && _sibAccTbl !== undefined && _sibAccTbl.name !== undefined && _sibAccTbl.name !== null) ? _sibAccTbl.name : '—';
    const acctLabel   = _sibAccTbl !== null
      ? (tx.tx_type === 'money-out'
          ? acctName + ' → ' + _sibAccTblName
          : _sibAccTblName + ' → ' + acctName)
      : acctName;
    const catLabel  = _catLabel(tx.tx_type, tx.major_category, tx.minor_category);
    const nativeAmt = fmtNative(displayAmt, txCur);
    const baseAmt   = fmtBase(displayAmt, txCur);
    const amtCell   = txCur !== state.quoteCurrency
      ? `${esc(nativeAmt)} <span class="td-base-amt">${esc(baseAmt)}</span>`
      : esc(nativeAmt);

    return {
      tr: `<tr>
        <td class="td-mono td-nowrap">${esc(fmtDateTimeCompact(tx.tx_date_time))}</td>
        <td><span class="badge ${badgeCls}">${typeLabel}</span></td>
        <td class="td-truncate" title="${esc(acctLabel)}">${esc(acctLabel)}</td>
        <td class="td-mono td-nowrap">${amtCell}${missingRate ? ' <span class="badge badge-warn" title="Currency not in rates tab">?</span>' : ''}</td>
        <td class="td-truncate" title="${esc(catLabel)}">${esc(catLabel)}</td>
        <td style="text-align:right;white-space:nowrap">
          ${recordStatusIcon(tx.record_status)}
          ${syncStatusIcon(tx.sync_status)}
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
          <div class="tx-card-amt td-mono">${esc(fmtNative(displayAmt, txCur))}</div>
          <div style="display:flex;align-items:center;gap:2px">
            ${recordStatusIcon(tx.record_status)}
            ${syncStatusIcon(tx.sync_status)}
            <button class="tx-menu-trigger" data-action="tx-menu" data-row="${tx._row}" title="Actions">⋮</button>
          </div>
        </div>`;
      })()
    };
  });

  const tableRows = rowData.map(d => d.tr).join('');
  const cardRows  = rowData.map(d => d.card).join('');

  const warnRowsHtml = warnRows.length ? `
    <tbody id="warnTable" class="hidden">
      ${warnRows.map(tx => `<tr>
        <td colspan="6"><span class="badge badge-warn">⚠ malformed</span> id=${esc(String(tx.id !== undefined && tx.id !== null ? tx.id : '?'))} type=${esc(tx.tx_type !== undefined && tx.tx_type !== null ? tx.tx_type : '?')} date=${esc(String(tx.tx_date_time !== undefined && tx.tx_date_time !== null ? tx.tx_date_time : '?'))}</td>
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
          ${thSort('account_id','Account')}
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
  if (content === null || content === undefined) return;

  content.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      state.txSort.dir = state.txSort.col === col ? (state.txSort.dir === 'asc' ? 'desc' : 'asc') : 'asc';
      state.txSort.col = col;
      state.txPage = 1;
      renderTransactions();
    }, { signal });
  });

  el('prevPage').addEventListener('click', () => { state.txPage--; renderTransactions(); }, { signal });
  el('nextPage').addEventListener('click', () => { state.txPage++; renderTransactions(); }, { signal });
  el('txPerPage').addEventListener('change', e => { state.txPerPage = Number(e.target.value); state.txPage = 1; renderTransactions(); }, { signal });

  content.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn === null || btn === undefined) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? Number(btn.dataset.row) : null;
    if (action === 'tx-menu') {
      const tx = state.transactions.find(t => t._row === row);
      if (tx === undefined || tx === null) return;
      if (_txMenuKey === row) { closeContextMenu(); _txMenuKey = null; return; }
      _txMenuKey = row;
      const rstat = tx.record_status;
      const isSub = _isCatSubEligible(tx) && !_isAlreadySubscribed(tx);
      const items = rstat === 'locked'
        ? [{ key: 'tx-view', label: 'View', cls: '' }]
        : rstat === 'deleted'
          ? [{ key: 'tx-view',    label: 'View',    cls: '' },
             { key: 'tx-restore', label: 'Restore', cls: '' }]
          : [
              { key: 'tx-view',   label: 'View',   cls: '' },
              { key: 'tx-edit',   label: 'Edit',   cls: '' },
              { key: 'tx-copy',   label: 'Copy',   cls: '' },
              { key: 'tx-delete', label: 'Delete', cls: 'danger' },
              ...(isSub ? [{ key: 'tx-mark-sub', label: 'Subscribe', cls: '' }] : []),
            ];
      openContextMenu(btn, items, key => { _txMenuKey = null; _dispatchTxAction(key, row); });
      return;
    }
    if (action === 'sugg-add') {
      const key = btn.dataset.key;
      const s = state.suggestions.find(x => `${x.counterparty_name}|${x.minor_category}` === key);
      if (s === undefined || s === null) return;
      state.txCopyPrefill = {
        tx_type:              'money-out',
        major_category:       s.major_category,
        minor_category:       s.minor_category,
        source_account:       (s.account_id             !== undefined && s.account_id             !== null) ? s.account_id             : '',
        target_account:       '',
        source_amount:        s.typical_amount,
        target_amount:        '',
        counterparty_name:    s.counterparty_name,
        user_location_area:   (s.user_location_area    !== undefined && s.user_location_area    !== null) ? s.user_location_area    : '',
        user_location_city:   (s.user_location_city    !== undefined && s.user_location_city    !== null) ? s.user_location_city    : '',
        user_location_country: (s.user_location_country !== undefined && s.user_location_country !== null) ? s.user_location_country : '',
        tx_tags:              (s.tx_tags               !== undefined && s.tx_tags               !== null) ? s.tx_tags               : '',
        beneficiaries:        (s.beneficiaries         !== undefined && s.beneficiaries         !== null) ? s.beneficiaries         : '',
        description:          '',
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
    if (col === 'tx_date_time') {
      const ts = s => { const d = new Date(String(s)); return Number.isFinite(d.getTime()) ? d.getTime() : null; };
      const va = ts(a[col]); const vb = ts(b[col]);
      const aNil = va === null; const bNil = vb === null;
      if (aNil && bNil) return 0;
      if (aNil) return 1;
      if (bNil) return -1;
      return va < vb ? -dir : va > vb ? dir : 0;
    }
    if (col === 'tx_amount') {
      const va = parseFloat(a.tx_amount);
      const vb = parseFloat(b.tx_amount);
      const aNil = !Number.isFinite(va); const bNil = !Number.isFinite(vb);
      if (aNil && bNil) return 0;
      if (aNil) return 1;
      if (bNil) return -1;
      return va < vb ? -dir : va > vb ? dir : 0;
    }
    // String columns: null/undefined sorts to end regardless of direction
    const ra = a[col]; const rb = b[col];
    const aNil = ra === undefined || ra === null;
    const bNil = rb === undefined || rb === null;
    if (aNil && bNil) return 0;
    if (aNil) return 1;
    if (bNil) return -1;
    const va = String(ra).toLowerCase();
    const vb = String(rb).toLowerCase();
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
      <!-- Row 3: Date & time | Timezone | Source amount | Target amount -->
      <div class="field form-grid-span-2" id="afDateField">
        <label for="afDate">Date &amp; time *</label>
        <input type="datetime-local" id="afDate" value="${nowLocalISO()}">
      </div>
      <div class="field form-grid-span-2" id="afTimezoneField">
        <label for="afTimezone">Timezone <span class="optional">optional</span></label>
        <input type="text" id="afTimezone" placeholder="e.g. Asia/Kolkata" autocomplete="off">
      </div>
      <div class="field form-grid-span-2" id="afSourceAmountField">
        <label for="afSourceAmount" id="afSourceAmountLabel">Amount *</label>
        <input type="number" id="afSourceAmount" min="0.01" step="0.01" placeholder="0.00">
      </div>
      <div class="field form-grid-span-1 hidden" id="afTargetAmountField">
        <label for="afTargetAmount">Target amount</label>
        <input type="number" id="afTargetAmount" min="0.01" step="0.01" placeholder="0.00">
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
    ${_datalist('dlAfCounterparty', (state.metadata !== null && state.metadata !== undefined) ? state.metadata.counterparties : null)}
    ${_datalist('dlAfArea',         (state.metadata !== null && state.metadata !== undefined) ? state.metadata.areas         : null)}
    ${_datalist('dlAfCity',         (state.metadata !== null && state.metadata !== undefined) ? state.metadata.cities        : null)}
    ${_datalist('dlAfCountry',      (state.metadata !== null && state.metadata !== undefined) ? state.metadata.countries     : null)}
    ${_datalist('dlAfTags',         (state.metadata !== null && state.metadata !== undefined) ? state.metadata.tags          : null)}
  </div>`;
}

function _prefillAddForm(p) {
  const typeEl = el('afType');
  if (typeEl === null || typeEl === undefined) return;

  // 1. Type → unlock and populate major
  typeEl.value = p.tx_type !== undefined && p.tx_type !== null ? p.tx_type : '';
  const majorEl = el('afMajor');
  const minorEl = el('afMinor');
  if (p.tx_type !== undefined && p.tx_type !== null && String(p.tx_type).trim() !== '') {
    majorEl.innerHTML = _catMajorOpts(p.tx_type);
    majorEl.disabled  = false;
    minorEl.disabled  = false;
  }

  // 2. Major → populate minor (skip for transfers — legitimately no category)
  if (p.major_category !== undefined && p.major_category !== null && String(p.major_category).trim() !== '') {
    const { majorKey: _pfMaj, minorKey: _pfMin } = _normCatKeys(p.tx_type, p.major_category, p.minor_category);
    majorEl.value     = _pfMaj;
    minorEl.innerHTML = _catMinorOpts(p.tx_type, _pfMaj);
    minorEl.value     = _pfMin !== undefined && _pfMin !== null && String(_pfMin).trim() !== '' ? _pfMin : '';
  }

  // 3. Refresh source account opts (category-filtered), then set value
  _afRefreshFromAccountOpts();
  const fromEl = el('afFromAccount');
  if (fromEl !== null && fromEl !== undefined) fromEl.value = p.source_account !== undefined && p.source_account !== null ? p.source_account : '';

  // 4. Refresh target account opts, then set value
  _afRefreshToAccountField();
  const toEl = el('afToAccount');
  if (toEl !== null && toEl !== undefined) toEl.value = (p.target_account !== undefined && p.target_account !== null) ? p.target_account : '';

  // 5. Remaining text fields — date stays as nowLocalISO()
  const afSourceAmount = el('afSourceAmount'); if (afSourceAmount !== null && afSourceAmount !== undefined) afSourceAmount.value = p.source_amount !== undefined && p.source_amount !== null ? p.source_amount : '';
  const afTargetAmount = el('afTargetAmount'); if (afTargetAmount !== null && afTargetAmount !== undefined) afTargetAmount.value = (p.target_amount !== undefined && p.target_amount !== null) ? p.target_amount : '';
  const afCp      = el('afCounterparty'); if (afCp      !== null && afCp      !== undefined) afCp.value      = (p.counterparty_name   !== undefined && p.counterparty_name   !== null) ? p.counterparty_name   : '';
  const afArea    = el('afArea');        if (afArea    !== null && afArea    !== undefined) afArea.value    = (p.user_location_area    !== undefined && p.user_location_area    !== null) ? p.user_location_area    : '';
  const afCity    = el('afCity');        if (afCity    !== null && afCity    !== undefined) afCity.value    = (p.user_location_city    !== undefined && p.user_location_city    !== null) ? p.user_location_city    : '';
  const afCountry = el('afCountry');     if (afCountry !== null && afCountry !== undefined) afCountry.value = (p.user_location_country !== undefined && p.user_location_country !== null) ? p.user_location_country : '';
  const afTags    = el('afTags');        if (afTags    !== null && afTags    !== undefined) afTags.value    = (p.tx_tags !== undefined && p.tx_tags !== null) ? String(p.tx_tags).replace(/;/g, ', ') : '';
  const afDesc    = el('afDescription'); if (afDesc    !== null && afDesc    !== undefined) afDesc.value    = (p.description          !== undefined && p.description          !== null) ? p.description          : '';
  const afTimezone = el('afTimezone'); if (afTimezone !== null && afTimezone !== undefined) afTimezone.value = (p.tx_timezone !== undefined && p.tx_timezone !== null) ? p.tx_timezone : '';
  const afLat = el('afLatitude');  if (afLat !== null && afLat !== undefined) afLat.value = (p.user_location_latitude  !== undefined && p.user_location_latitude  !== null) ? p.user_location_latitude  : '';
  const afLon = el('afLongitude'); if (afLon !== null && afLon !== undefined) afLon.value = (p.user_location_longitude !== undefined && p.user_location_longitude !== null) ? p.user_location_longitude : '';
  const afBen = el('afBeneficiaries'); if (afBen !== null && afBen !== undefined) afBen.value = (p.beneficiaries !== undefined && p.beneficiaries !== null) ? p.beneficiaries : '';
}

function _attachAddFormEvents() {
  el('afType').addEventListener('change', () => {
    const type       = el('afType').value;
    const majorEl    = el('afMajor');
    const minorEl    = el('afMinor');

    majorEl.innerHTML = '<option value="">— select type first —</option>';
    minorEl.innerHTML = '<option value="">— select major first —</option>';
    const _afFromAcc = el('afFromAccount'); if (_afFromAcc !== null && _afFromAcc !== undefined) _afFromAcc.value = '';
    const _afToAcc   = el('afToAccount');   if (_afToAcc   !== null && _afToAcc   !== undefined) _afToAcc.value   = '';

    if (type === '') {
      majorEl.disabled = true;
      minorEl.disabled = true;
      const fromEl = el('afFromAccount');
      if (fromEl !== null && fromEl !== undefined) { fromEl.disabled = true; fromEl.innerHTML = '<option value="">— select type first —</option>'; }
      const toEl = el('afToAccount');
      if (toEl !== null && toEl !== undefined) { toEl.disabled = true; toEl.innerHTML = '<option value="">External</option>'; }
      return;
    }

    majorEl.innerHTML = _catMajorOpts(type);
    majorEl.disabled  = false;
    minorEl.disabled  = false;

    // _afRefreshFromAccountOpts cascades → _afRefreshToAccountField
    _afRefreshFromAccountOpts();
  });

  el('afMajor').addEventListener('change', () => {
    const type   = el('afType').value;
    const major  = el('afMajor').value;
    el('afMinor').innerHTML = _catMinorOpts(type, major);
    _afRefreshFromAccountOpts();  // clear any previous category hint
  });

  el('afMinor').addEventListener('change', _afRefreshFromAccountOpts);

  el('afFromAccount').addEventListener('change', _afRefreshToAccountField);

  el('afSubmit').addEventListener('click', _saveTransaction);
  el('afReset').addEventListener('click', () => {
    ['afDate','afSourceAmount','afTargetAmount','afCounterparty','afArea','afCity','afCountry','afTags','afDescription','afTimezone','afLatitude','afLongitude','afBeneficiaries']
      .forEach(id => { const _el = el(id); if (_el !== null && _el !== undefined) _el.value = id === 'afDate' ? nowLocalISO() : ''; });
    el('afType').value = '';
    const fromEl = el('afFromAccount');
    if (fromEl !== null && fromEl !== undefined) { fromEl.disabled = true; fromEl.innerHTML = '<option value="">— select type first —</option>'; }
    const toEl = el('afToAccount');
    if (toEl !== null && toEl !== undefined) { toEl.disabled = true; toEl.innerHTML = '<option value="">External</option>'; }
    el('afMajor').innerHTML = '<option value="">— select type first —</option>';
    el('afMajor').disabled  = true;
    el('afMinor').innerHTML = '<option value="">— select major first —</option>';
    el('afMinor').disabled  = true;
    el('afError').textContent = '';
  });

  _attachTagAutocomplete('afTags', 'dlAfTags');

  el('afDetectLocation').addEventListener('click', () => {
    if (navigator.geolocation === undefined || navigator.geolocation === null) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = el('afLatitude');
      const lon = el('afLongitude');
      if (lat !== null && lat !== undefined) lat.value = pos.coords.latitude.toFixed(6);
      if (lon !== null && lon !== undefined) lon.value = pos.coords.longitude.toFixed(6);
      _reverseGeocode('afLatitude', 'afLongitude', 'afArea', 'afCity', 'afCountry');
    });
  });

  el('afArea').addEventListener('blur',    () => _geocodeCity('afArea', 'afCity', 'afCountry', 'afLatitude', 'afLongitude'));
  el('afCity').addEventListener('blur',    () => _geocodeCity('afArea', 'afCity', 'afCountry', 'afLatitude', 'afLongitude'));
  el('afCountry').addEventListener('blur', () => _geocodeCity('afArea', 'afCity', 'afCountry', 'afLatitude', 'afLongitude'));
  el('afLatitude').addEventListener('blur',  () => _reverseGeocode('afLatitude', 'afLongitude', 'afArea', 'afCity', 'afCountry'));
  el('afLongitude').addEventListener('blur', () => _reverseGeocode('afLatitude', 'afLongitude', 'afArea', 'afCity', 'afCountry'));

  // If a copy was triggered, populate the form now that events are wired
  if (state.txCopyPrefill) {
    _prefillAddForm(state.txCopyPrefill);
    state.txCopyPrefill = null;
  }
}

function _afRefreshFromAccountOpts() {
  const type   = el('afType').value;
  const major  = el('afMajor').value;
  const minor  = el('afMinor').value;
  const fromEl = el('afFromAccount');
  if (fromEl === null || fromEl === undefined) return;
  const cat          = _getCat(type, major, minor);
  const srcMandatory = (cat !== null && cat !== undefined) ? Boolean(cat.source_account_mandatory) : type !== 'money-in';

  if (!srcMandatory) {
    fromEl.disabled  = true;
    fromEl.innerHTML = `<option value="">External</option>`;
    fromEl.value     = '';
  } else {
    fromEl.disabled  = false;
    const prevVal    = fromEl.value;
    const activeAccs = state.accounts.filter(a => a.record_status === 'active');
    const srcTypes   = (cat !== null && cat !== undefined && cat.source_account_types !== undefined && cat.source_account_types !== null) ? cat.source_account_types : '';
    fromEl.innerHTML = `<option value="">— select —</option>${_acctOptsWithHints(activeAccs, srcTypes, prevVal)}`;
    if (prevVal !== '') fromEl.value = prevVal;
  }
  _afRefreshToAccountField();
}

function _afRefreshToAccountField() {
  const type   = el('afType').value;
  const major  = el('afMajor').value;
  const minor  = el('afMinor').value;
  const cat    = _getCat(type, major, minor);
  const isTransfer      = cat !== null && cat !== undefined && cat.source_account_mandatory === true && cat.target_account_mandatory === true;
  const targetMandatory = (cat !== null && cat !== undefined) ? Boolean(cat.target_account_mandatory) : false;

  const toAccEl = el('afToAccount');
  if (toAccEl === null || toAccEl === undefined) return;

  if (targetMandatory) {
    toAccEl.disabled  = false;
    const fromId      = el('afFromAccount').value;
    const prevVal     = toAccEl.value;
    const activeAccs  = state.accounts.filter(a => a.record_status === 'active');
    const dstTypes    = (cat !== null && cat !== undefined && cat.target_account_types !== undefined && cat.target_account_types !== null) ? cat.target_account_types : '';
    const eligible    = activeAccs.filter(a => a.id !== fromId);
    toAccEl.innerHTML = `<option value="">— select —</option>${_acctOptsWithHints(eligible, dstTypes, prevVal)}`;
    if (prevVal !== '' && prevVal !== fromId) toAccEl.value = prevVal;
  } else {
    toAccEl.disabled  = true;
    toAccEl.innerHTML = `<option value="">External</option>`;
    toAccEl.value     = '';
  }

  const srcAmtLbl   = el('afSourceAmountLabel');
  const srcAmtField = el('afSourceAmountField');
  const tgtAmtField = el('afTargetAmountField');
  if (srcAmtLbl !== null && srcAmtLbl !== undefined) srcAmtLbl.textContent = isTransfer ? 'Source amount *' : 'Amount *';
  if (tgtAmtField !== null && tgtAmtField !== undefined) {
    if (isTransfer) {
      tgtAmtField.classList.remove('hidden');
      if (srcAmtField !== null && srcAmtField !== undefined) { srcAmtField.classList.remove('form-grid-span-2'); srcAmtField.classList.add('form-grid-span-1'); }
    } else {
      tgtAmtField.classList.add('hidden');
      if (srcAmtField !== null && srcAmtField !== undefined) { srcAmtField.classList.remove('form-grid-span-1'); srcAmtField.classList.add('form-grid-span-2'); }
      const tgtEl = el('afTargetAmount');
      if (tgtEl !== null && tgtEl !== undefined) tgtEl.value = '';
    }
  }
}



// ── Financial hard-block rules 1–6 ───────────────────────────────────────────
// Returns null on pass, or a multi-line error string on block.
// Rules 1 & 3 — insufficient balance (asset accounts).
// Rules 2 & 4 — credit limit exceeded (credit-card accounts).
// Rule 5     — money-out from a loan account (with exemption for interest/charges).
// Rule 6     — FX transfer: source_amount and target_amount may differ for cross-currency transfers.

function _checkBalanceRules(transaction_type, sourceAccount, isTransfer, amount) {
  if (sourceAccount === undefined || sourceAccount === null) return null;
  const isMoneyOut      = transaction_type === 'money-out';
  if (!isMoneyOut && !isTransfer) return null;

  const sym = getSymbol(sourceAccount.currency);
  const fmt = n => Number(n).toFixed(2);

  // Rules 1 & 3 — asset accounts
  if ((state.accountSchema !== undefined && state.accountSchema !== null && state.accountSchema.asset_types !== undefined && state.accountSchema.asset_types !== null ? state.accountSchema.asset_types : []).includes(sourceAccount.type)) {
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
    const creditLimit = Number(sourceAccount.credit_card_limit);
    if ((sourceAccount.credit_card_limit === undefined || sourceAccount.credit_card_limit === null || sourceAccount.credit_card_limit === '') || creditLimit <= 0) return null; // no limit set — skip check

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
  if (sourceAccount === undefined || sourceAccount === null) return null;
  const loanTypes = (state.accountSchema !== undefined && state.accountSchema !== null && state.accountSchema.loan_types !== undefined && state.accountSchema.loan_types !== null) ? state.accountSchema.loan_types : [];
  if (!loanTypes.includes(sourceAccount.type)) return null;
  if (major_category === 'debt-finance' && minor_category === 'interest-charges') return null;
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
  const target_account       = el('afToAccount').value;
  const source_amount_raw    = el('afSourceAmount').value;
  const target_amount_raw    = el('afTargetAmount').value;
  const major_category       = el('afMajor').value;
  const minor_category       = el('afMinor').value;
  const counterparty_name    = el('afCounterparty').value.trim();
  const user_location_area     = el('afArea').value.trim();
  const user_location_city     = el('afCity').value.trim();
  const user_location_country  = el('afCountry').value.trim();
  const tx_tags              = el('afTags').value.trim();
  const description          = el('afDescription').value.trim();
  const tx_timezone            = el('afTimezone').value.trim();
  const user_location_latitude  = el('afLatitude').value  !== '' ? Number(el('afLatitude').value)  : '';
  const user_location_longitude = el('afLongitude').value !== '' ? Number(el('afLongitude').value) : '';
  const beneficiaries           = el('afBeneficiaries').value.trim();

  const _saveCat      = _getCat(tx_type, major_category, minor_category);
  const isTransfer    = (_saveCat !== null && _saveCat !== undefined) && _saveCat.source_account_mandatory === true && _saveCat.target_account_mandatory === true;
  const srcMandatory  = (_saveCat !== null && _saveCat !== undefined) ? Boolean(_saveCat.source_account_mandatory) : tx_type !== 'money-in';
  const tgtMandatory  = (_saveCat !== null && _saveCat !== undefined) ? Boolean(_saveCat.target_account_mandatory) : false;
  if (dateRaw === '')                                            { errEl.textContent = 'Date is required.';           return; }
  if (tx_type === '')                                            { errEl.textContent = 'Type is required.';           return; }
  if (srcMandatory && source_account === '')                     { errEl.textContent = 'Source account is required.'; return; }
  if (tgtMandatory && target_account === '')                     { errEl.textContent = 'Target account is required.'; return; }
  if (source_amount_raw === '' || parseFloat(source_amount_raw) <= 0) { errEl.textContent = 'Enter a positive amount.'; return; }
  if (major_category === '')                                     { errEl.textContent = 'Major category is required.'; return; }
  if (minor_category === '')                                     { errEl.textContent = 'Minor category is required.'; return; }

  const source_amount = parseFloat(source_amount_raw);
  const _targetAmtParsed = (target_amount_raw !== undefined && target_amount_raw !== null && String(target_amount_raw).trim() !== '')
    ? parseFloat(String(target_amount_raw).trim())
    : null;
  const target_amount = (Number.isFinite(_targetAmtParsed) && _targetAmtParsed > 0) ? _targetAmtParsed : source_amount;

  const sourceAcc     = state.accountMap[source_account];
  const targetAcc     = state.accountMap[target_account];
  const balanceError  = _checkBalanceRules(tx_type, sourceAcc, isTransfer, source_amount);
  if (balanceError) { errEl.textContent = balanceError; return; }

  const rule5Error    = _checkRule5(tx_type, sourceAcc, major_category, minor_category);
  if (rule5Error) { errEl.textContent = rule5Error; return; }

  btn.disabled = true; btn.textContent = 'Saving…';
  showLoading();
  try {
    const res = await ExpenseAPI.createTransaction({
      tx_date_time: localToUtcISO(dateRaw),
      tx_type, source_account, target_account,
      source_amount, target_amount,
      major_category, minor_category,
      counterparty_name, user_location_area, user_location_city, user_location_country,
      tx_tags, description,
      tx_timezone, user_location_latitude, user_location_longitude, beneficiaries,
    });
    if (res.ok) {
      showMsg(res.ids ? '2 transactions saved (transfer split).' : 'Transaction saved.');
      state.txAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _saveTransaction failed:', res.error);
      errEl.textContent = 'Error: ' + (res.error !== undefined && res.error !== null && String(res.error).trim() !== '' ? res.error : '[no error code]');
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
  const typeLabel = (_txTypeMap()[tx.tx_type] !== undefined && _txTypeMap()[tx.tx_type] !== null) ? _txTypeMap()[tx.tx_type] : tx.tx_type;
  const _txAccForm   = (state.accountMap[tx.account_id] !== undefined && state.accountMap[tx.account_id] !== null) ? state.accountMap[tx.account_id] : {};
  const _siblingForm = (_siblingMap[tx.id] !== undefined && _siblingMap[tx.id] !== null) ? _siblingMap[tx.id] : null;
  const _sibAccForm  = _siblingForm !== null ? ((state.accountMap[_siblingForm.account_id] !== undefined && state.accountMap[_siblingForm.account_id] !== null) ? state.accountMap[_siblingForm.account_id] : {}) : null;
  const acctFormName  = (_txAccForm.name !== undefined && _txAccForm.name !== null) ? _txAccForm.name : '—';

  if (mode === 'view') {
    const txCurView = (_txAccForm.currency !== undefined && _txAccForm.currency !== null) ? _txAccForm.currency : '';
    const viewAmt   = Number(tx.tx_amount);
    const _sibAccFormName = (_sibAccForm !== null && _sibAccForm !== undefined && _sibAccForm.name !== undefined && _sibAccForm.name !== null) ? _sibAccForm.name : '—';
    const viewAcct  = _sibAccForm !== null
      ? (tx.tx_type === 'money-out'
          ? acctFormName + ' → ' + _sibAccFormName
          : _sibAccFormName + ' → ' + acctFormName)
      : acctFormName;

    const vf = (label, value, span = 'form-grid-span-2') =>
      `<div class="field ${span}"><label>${label}</label><div class="field-val">${value}</div></div>`;

    const hasCoords = (tx.user_location_latitude !== undefined && tx.user_location_latitude !== null && String(tx.user_location_latitude).trim() !== '') ||
                      (tx.user_location_longitude !== undefined && tx.user_location_longitude !== null && String(tx.user_location_longitude).trim() !== '');
    const { majorKey: _vMajKey, minorKey: _vMinKey } = _normCatKeys(tx.tx_type, tx.major_category, tx.minor_category);
    const _viewCat  = _getCat(tx.tx_type, _vMajKey, _vMinKey);
    const _viewCatMajorLbl = _viewCat !== null && _viewCat !== undefined ? _viewCat.major_category_label : null;
    const _viewCatMinorLbl = _viewCat !== null && _viewCat !== undefined ? _viewCat.minor_category_label : null;
    const majorLbl  = (_viewCatMajorLbl !== null && _viewCatMajorLbl !== undefined) ? _viewCatMajorLbl
      : ((tx.major_category !== undefined && tx.major_category !== null && String(tx.major_category).trim() !== '') ? tx.major_category : '—');
    const minorLbl  = (_viewCatMinorLbl !== null && _viewCatMinorLbl !== undefined) ? _viewCatMinorLbl
      : ((tx.minor_category !== undefined && tx.minor_category !== null && String(tx.minor_category).trim() !== '') ? tx.minor_category : '—');

    return `
    <div class="card" style="margin-bottom:16px">
      <div class="form-grid form-grid-6">
        <!-- Row 1: Type | Major category | Minor category -->
        <div class="field form-grid-span-2">
          <label>Type</label>
          <div class="field-val"><span class="badge ${badgeCls}">${esc(typeLabel)}</span></div>
        </div>
        ${vf('Major category', esc(majorLbl))}
        ${vf('Minor category', esc(minorLbl))}
        <!-- Row 2: Account (full width) -->
        ${vf('Account', esc(viewAcct), 'form-grid-full')}
        <!-- Row 3: Date & time | Timezone | Amount -->
        ${vf('Date &amp; time', esc(fmtDateTime(tx.tx_date_time)))}
        ${vf('Timezone', esc((tx.tx_timezone !== undefined && tx.tx_timezone !== null && String(tx.tx_timezone).trim() !== '') ? tx.tx_timezone : '—'))}
        <div class="field form-grid-span-2">
          <label>Amount</label>
          <div class="field-val">
            ${esc(fmtNative(viewAmt, txCurView))}
            <span style="color:var(--muted);font-size:var(--text-sm)">≈ ${esc(fmtBase(viewAmt, txCurView))}</span>
          </div>
        </div>
        <!-- Row 4: Counterparty | Tags -->
        ${vf('Counterparty', esc((tx.counterparty_name !== undefined && tx.counterparty_name !== null && String(tx.counterparty_name).trim() !== '') ? tx.counterparty_name : '—'), 'form-grid-span-3')}
        ${vf('Tags', (() => { const _tagsStr = (tx.tx_tags !== undefined && tx.tx_tags !== null) ? String(tx.tx_tags).replace(/;/g, ', ') : ''; return esc(_tagsStr !== '' ? _tagsStr : '—'); })(), 'form-grid-span-3')}
        <!-- Row 5: Description -->
        ${vf('Description', esc((tx.description !== undefined && tx.description !== null && String(tx.description).trim() !== '') ? tx.description : '—'), 'form-grid-full')}
        <!-- Row 6: Beneficiaries -->
        ${vf('Beneficiaries', _fmtBeneficiaries(tx.beneficiaries), 'form-grid-full')}
        <!-- Row 7: Area | City | Country -->
        ${vf('Area',    esc((tx.user_location_area    !== undefined && tx.user_location_area    !== null && String(tx.user_location_area).trim()    !== '') ? tx.user_location_area    : '—'))}
        ${vf('City',    esc((tx.user_location_city    !== undefined && tx.user_location_city    !== null && String(tx.user_location_city).trim()    !== '') ? tx.user_location_city    : '—'))}
        ${vf('Country', esc((tx.user_location_country !== undefined && tx.user_location_country !== null && String(tx.user_location_country).trim() !== '') ? tx.user_location_country : '—'))}
        <!-- Row 8: Coordinates (only if set) -->
        ${hasCoords ? vf('Coordinates', esc(`${(tx.user_location_latitude !== undefined && tx.user_location_latitude !== null) ? tx.user_location_latitude : ''}, ${(tx.user_location_longitude !== undefined && tx.user_location_longitude !== null) ? tx.user_location_longitude : ''}`), 'form-grid-full') : ''}
      </div>
      ${(tx.sync_status !== undefined && tx.sync_status !== null && String(tx.sync_status).trim() !== '') ? `<div style="margin-top:8px;display:flex;align-items:center;gap:6px">${syncStatusIcon(tx.sync_status)}<span style="font-size:var(--text-sm);color:var(--muted)">${esc(tx.sync_status)}</span>${(tx.sync_notes !== undefined && tx.sync_notes !== null && String(tx.sync_notes).trim() !== '') ? `<span style="font-size:var(--text-sm)">— ${esc(tx.sync_notes)}</span>` : ''}</div>` : ''}
      <div class="form-actions" style="margin-top:12px">
        <button class="btn btn-secondary btn-sm" data-action="tx-cancel-view">Close</button>
        <button class="btn btn-primary btn-sm" data-action="tx-edit" data-row="${tx._row}">Edit</button>
      </div>
    </div>`;
  }

  // Edit mode — single-row edit: one account_id, one tx_amount (no source/target split)
  const activeAccounts = state.accounts.filter(a => a.record_status === 'active');
  const _editCat       = _getCat(tx.tx_type, tx.major_category, tx.minor_category);
  const _editAccTypes  = tx.tx_type === 'money-out'
    ? ((_editCat !== null && _editCat !== undefined && _editCat.source_account_types !== undefined && _editCat.source_account_types !== null) ? _editCat.source_account_types : '')
    : ((_editCat !== null && _editCat !== undefined && _editCat.target_account_types !== undefined && _editCat.target_account_types !== null) ? _editCat.target_account_types : '');
  const accountOpts    = _acctOptsWithHints(activeAccounts, _editAccTypes, tx.account_id);
  const typeOpts       = _txTypes().map(t =>
    `<option value="${esc(t.value)}" ${tx.tx_type === t.value ? 'selected' : ''}>${esc(t.label)}</option>`
  ).join('');
  const { majorKey: _editMajorKey, minorKey: _editMinorKey } = _normCatKeys(tx.tx_type, tx.major_category, tx.minor_category);
  const majorOpts = _catMajorOpts(tx.tx_type, _editMajorKey);
  const minorOpts = _catMinorOpts(tx.tx_type, _editMajorKey, _editMinorKey);
  const dateVal   = utcToLocalInput(tx.tx_date_time);
  const _sibAccFormName = (_sibAccForm !== null && _sibAccForm !== undefined && _sibAccForm.name !== undefined && _sibAccForm.name !== null && String(_sibAccForm.name).trim() !== '') ? _sibAccForm.name : '—';
  const transferNote = _siblingForm !== null
    ? `<div style="font-size:var(--text-sm);color:var(--muted);margin-bottom:4px">Linked transfer — edit this leg only. The other leg (${esc(_sibAccFormName)}) is a separate row.</div>`
    : '';

  return `
  <div class="card" style="margin-bottom:16px">
    ${transferNote}
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
      <!-- Row 2: Account (full width) -->
      <div class="field form-grid-full">
        <label>Account</label>
        <select id="txEditAccount">
          <option value="">— select —</option>
          ${accountOpts}
        </select>
      </div>
      <!-- Row 3: Date & time | Timezone | Amount -->
      <div class="field form-grid-span-2">
        <label>Date &amp; time</label>
        <input type="datetime-local" id="txEditDate" value="${esc(dateVal)}">
      </div>
      <div class="field form-grid-span-2">
        <label>Timezone <span class="optional">optional</span></label>
        <input type="text" id="txEditTimezone" placeholder="e.g. Asia/Kolkata" autocomplete="off" value="${esc((tx.tx_timezone !== undefined && tx.tx_timezone !== null) ? tx.tx_timezone : '')}">
      </div>
      <div class="field form-grid-span-2">
        <label>Amount</label>
        <input type="number" id="txEditAmount" min="0.01" step="0.01" value="${esc(String(Number(tx.tx_amount)))}">
      </div>
      <!-- Row 4: Counterparty | Tags -->
      <div class="field form-grid-span-3">
        <label>Counterparty</label>
        <input type="text" id="txEditCounterparty" value="${esc((tx.counterparty_name !== undefined && tx.counterparty_name !== null) ? tx.counterparty_name : '')}" list="dlEditCounterparty" autocomplete="off">
      </div>
      <div class="field form-grid-span-3">
        <label>Tags</label>
        <input type="text" id="txEditTags" value="${esc(String((tx.tx_tags !== undefined && tx.tx_tags !== null) ? tx.tx_tags : '').replace(/;/g, ', '))}" list="dlEditTags" autocomplete="off">
      </div>
      <!-- Row 5: Description -->
      <div class="field form-grid-full">
        <label>Description</label>
        <input type="text" id="txEditDescription" value="${esc((tx.description !== undefined && tx.description !== null) ? tx.description : '')}">
      </div>
      <!-- Row 6: Beneficiaries -->
      <div class="field form-grid-full">
        <label for="txEditBeneficiaries">Beneficiaries <span class="optional">optional</span></label>
        <input type="text" id="txEditBeneficiaries" placeholder="e.g. Alice:60;Bob:40 or Alice;Bob" autocomplete="off" value="${esc((tx.beneficiaries !== undefined && tx.beneficiaries !== null) ? tx.beneficiaries : '')}">
      </div>
      <!-- Row 7: Area | City | Country -->
      <div class="field form-grid-span-2">
        <label>Area</label>
        <input type="text" id="txEditArea" value="${esc((tx.user_location_area !== undefined && tx.user_location_area !== null) ? tx.user_location_area : '')}" list="dlEditArea" autocomplete="off">
      </div>
      <div class="field form-grid-span-2">
        <label>City</label>
        <input type="text" id="txEditCity" value="${esc((tx.user_location_city !== undefined && tx.user_location_city !== null) ? tx.user_location_city : '')}" list="dlEditCity" autocomplete="off">
      </div>
      <div class="field form-grid-span-2">
        <label>Country</label>
        <input type="text" id="txEditCountry" value="${esc((tx.user_location_country !== undefined && tx.user_location_country !== null) ? tx.user_location_country : '')}" list="dlEditCountry" autocomplete="off">
      </div>
      <!-- Row 8: Coordinates -->
      <div class="field form-grid-full">
        <label>Coordinates <span class="optional">optional</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="txEditLatitude"  step="any" placeholder="Latitude"  style="flex:1" min="-90"  max="90"  value="${(tx.user_location_latitude  !== undefined && tx.user_location_latitude  !== null) ? tx.user_location_latitude  : ''}">
          <input type="number" id="txEditLongitude" step="any" placeholder="Longitude" style="flex:1" min="-180" max="180" value="${(tx.user_location_longitude !== undefined && tx.user_location_longitude !== null) ? tx.user_location_longitude : ''}">
          <button type="button" id="txEditDetectLocation" class="btn btn-secondary btn-sm">Detect</button>
        </div>
      </div>
    </div>
    <div class="form-actions" style="margin-top:8px">
      <button class="btn btn-primary btn-sm" data-action="tx-save-edit">Save</button>
      <button class="btn btn-secondary btn-sm" data-action="tx-cancel-edit">Cancel</button>
    </div>
    <div class="pin-error" id="txEditError"></div>
    ${_datalist('dlEditCounterparty', (state.metadata !== null && state.metadata !== undefined) ? state.metadata.counterparties : null)}
    ${_datalist('dlEditArea',         (state.metadata !== null && state.metadata !== undefined) ? state.metadata.areas         : null)}
    ${_datalist('dlEditCity',         (state.metadata !== null && state.metadata !== undefined) ? state.metadata.cities        : null)}
    ${_datalist('dlEditCountry',      (state.metadata !== null && state.metadata !== undefined) ? state.metadata.countries     : null)}
    ${_datalist('dlEditTags',         (state.metadata !== null && state.metadata !== undefined) ? state.metadata.tags          : null)}
  </div>`;
}

function _renderTxDeleteRow(tx) {
  const _txAccDel   = (state.accountMap[tx.account_id] !== undefined && state.accountMap[tx.account_id] !== null) ? state.accountMap[tx.account_id] : {};
  const _delSibling = (_siblingMap[tx.id] !== undefined && _siblingMap[tx.id] !== null) ? _siblingMap[tx.id] : null;
  const _delSibAcc  = _delSibling !== null ? ((state.accountMap[_delSibling.account_id] !== undefined && state.accountMap[_delSibling.account_id] !== null) ? state.accountMap[_delSibling.account_id] : {}) : null;
  const acctName    = (_txAccDel.name !== undefined && _txAccDel.name !== null) ? _txAccDel.name : '—';
  const _delSibAccName = (_delSibAcc !== null && _delSibAcc !== undefined && _delSibAcc.name !== undefined && _delSibAcc.name !== null) ? _delSibAcc.name : '—';
  const accLabel    = _delSibAcc !== null
    ? (tx.tx_type === 'money-out'
        ? acctName + ' → ' + _delSibAccName
        : _delSibAccName + ' → ' + acctName)
    : acctName;
  const delAmt = Number(tx.tx_amount);
  const _delCur = (_txAccDel.currency !== undefined && _txAccDel.currency !== null) ? _txAccDel.currency : '';
  return `<tr>
    <td colspan="6">
      <span class="confirm-text">Delete <strong>${esc(fmtDateTime(tx.tx_date_time))}</strong> — ${esc(accLabel)} — ${esc(fmtNative(delAmt, _delCur))}?</span>
      <span style="display:inline-flex;gap:8px;margin-left:16px">
        <button class="btn-link danger" data-action="tx-confirm-delete" data-row="${tx._row}">Yes, delete</button>
        <button class="btn-link" data-action="tx-cancel-delete">Cancel</button>
      </span>
    </td>
  </tr>`;
}

function _attachTxEditCascadeEvents() {
  const _refreshAccountOpts = () => {
    const type     = el('txEditType').value;
    const major    = el('txEditMajor').value;
    const minor    = el('txEditMinor').value;
    const cat      = _getCat(type, major, minor);
    const typeHint = type === 'money-out'
      ? ((cat !== null && cat !== undefined && cat.source_account_types !== undefined && cat.source_account_types !== null) ? cat.source_account_types : '')
      : ((cat !== null && cat !== undefined && cat.target_account_types !== undefined && cat.target_account_types !== null) ? cat.target_account_types : '');
    const actives  = state.accounts.filter(a => a.record_status === 'active');
    const acctEl   = el('txEditAccount');
    if (acctEl) {
      const prev   = acctEl.value;
      acctEl.innerHTML = `<option value="">— select —</option>${_acctOptsWithHints(actives, typeHint, prev)}`;
      if (prev) acctEl.value = prev;
    }
  };

  el('txEditType').addEventListener('change', () => {
    el('txEditMajor').innerHTML = _catMajorOpts(el('txEditType').value);
    el('txEditMinor').innerHTML = `<option value="">— select major first —</option>`;
    _refreshAccountOpts();
  });
  el('txEditMajor').addEventListener('change', () => {
    const type  = el('txEditType').value;
    const major = el('txEditMajor').value;
    el('txEditMinor').innerHTML = _catMinorOpts(type, major);
    _refreshAccountOpts();
  });
  el('txEditMinor').addEventListener('change', _refreshAccountOpts);

  _attachTagAutocomplete('txEditTags', 'dlEditTags');

  el('txEditDetectLocation').addEventListener('click', () => {
    if (navigator.geolocation === undefined || navigator.geolocation === null) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = el('txEditLatitude');
      const lon = el('txEditLongitude');
      if (lat !== null && lat !== undefined) lat.value = pos.coords.latitude.toFixed(6);
      if (lon !== null && lon !== undefined) lon.value = pos.coords.longitude.toFixed(6);
      _reverseGeocode('txEditLatitude', 'txEditLongitude', 'txEditArea', 'txEditCity', 'txEditCountry');
    });
  });

  el('txEditArea').addEventListener('blur',    () => _geocodeCity('txEditArea', 'txEditCity', 'txEditCountry', 'txEditLatitude', 'txEditLongitude'));
  el('txEditCity').addEventListener('blur',    () => _geocodeCity('txEditArea', 'txEditCity', 'txEditCountry', 'txEditLatitude', 'txEditLongitude'));
  el('txEditCountry').addEventListener('blur', () => _geocodeCity('txEditArea', 'txEditCity', 'txEditCountry', 'txEditLatitude', 'txEditLongitude'));
  el('txEditLatitude').addEventListener('blur',  () => _reverseGeocode('txEditLatitude', 'txEditLongitude', 'txEditArea', 'txEditCity', 'txEditCountry'));
  el('txEditLongitude').addEventListener('blur', () => _reverseGeocode('txEditLatitude', 'txEditLongitude', 'txEditArea', 'txEditCity', 'txEditCountry'));
}

async function _saveEdit() {
  const errEl = el('txEditError');
  errEl.textContent = '';

  const rowNum              = state.txEditRow;
  const dateRaw             = el('txEditDate').value;
  const tx_type             = el('txEditType').value;
  const account_id          = el('txEditAccount').value;
  const tx_amount_raw       = el('txEditAmount').value;
  const major_category      = el('txEditMajor').value;
  const minor_category      = el('txEditMinor').value;
  const counterparty_name   = el('txEditCounterparty').value.trim();
  const user_location_area    = el('txEditArea').value.trim();
  const user_location_city    = el('txEditCity').value.trim();
  const user_location_country = el('txEditCountry').value.trim();
  const tx_tags             = el('txEditTags').value.trim();
  const description         = el('txEditDescription').value.trim();
  const tx_timezone         = el('txEditTimezone').value.trim();
  const user_location_latitude  = el('txEditLatitude').value  !== '' ? Number(el('txEditLatitude').value)  : '';
  const user_location_longitude = el('txEditLongitude').value !== '' ? Number(el('txEditLongitude').value) : '';
  const beneficiaries       = el('txEditBeneficiaries').value.trim();

  if (dateRaw === '')                                            { errEl.textContent = 'Date is required.';           return; }
  if (tx_type === '')                                            { errEl.textContent = 'Type is required.';           return; }
  if (account_id === '')                                         { errEl.textContent = 'Account is required.';        return; }
  if (tx_amount_raw === '' || parseFloat(tx_amount_raw) <= 0)   { errEl.textContent = 'Enter a positive amount.';    return; }
  if (major_category === '')                                     { errEl.textContent = 'Major category is required.'; return; }
  if (minor_category === '')                                     { errEl.textContent = 'Minor category is required.'; return; }

  const tx_amount  = parseFloat(tx_amount_raw);
  const oldTx      = state.transactions.find(t => t._row === rowNum);
  const acctEdit   = state.accountMap[account_id];

  // Post-reversal balance: backend reverses the old row before writing the new values.
  // Undo the old movement only when the account hasn't changed.
  if (acctEdit === undefined || acctEdit === null || !Number.isFinite(Number(acctEdit.current_value))) { errEl.textContent = 'Account not found or has no valid balance.'; return; }
  let postRevBal = Number(acctEdit.current_value);
  if (oldTx && String(oldTx.account_id) === String(account_id)) {
    const oldAmt = Number(oldTx.tx_amount);
    if (oldTx.tx_type === 'money-in')  postRevBal -= oldAmt;
    if (oldTx.tx_type === 'money-out') postRevBal += oldAmt;
  }
  const acctPR = Object.assign({}, acctEdit, { current_value: postRevBal });

  const balanceErrorEdit = _checkBalanceRules(tx_type, acctPR, false, tx_amount);
  if (balanceErrorEdit) { errEl.textContent = balanceErrorEdit; return; }

  const rule5ErrorEdit = _checkRule5(tx_type, acctEdit, major_category, minor_category);
  if (rule5ErrorEdit) { errEl.textContent = rule5ErrorEdit; return; }

  showLoading();
  try {
    const res = await ExpenseAPI.updateTransaction({
      row_num: rowNum, tx_date_time: localToUtcISO(dateRaw), tx_type,
      account_id, tx_amount,
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
      console.warn('[transactions] _saveEdit failed:', res.error);
      errEl.textContent = 'Error: ' + (res.error !== undefined && res.error !== null && String(res.error).trim() !== '' ? res.error : '[no error code]');
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
      console.warn('[transactions] _confirmDelete failed:', res.error);
      showMsg('Delete failed: ' + (res.error !== undefined && res.error !== null && String(res.error).trim() !== '' ? res.error : '[no error code]'), 'warn');
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

async function _restoreTx(rowNum) {
  showLoading();
  try {
    const res = await ExpenseAPI.restoreTransaction({ row_num: rowNum });
    if (res.ok) {
      showMsg('Transaction restored.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _restoreTx failed:', res.error);
      showMsg('Restore failed: ' + (res.error !== undefined && res.error !== null && String(res.error).trim() !== '' ? res.error : '[no error code]'), 'warn');
      renderTransactions();
    }
  } catch (err) {
    console.error('[transactions] _restoreTx failed:', err);
    showMsg('Connection error.', 'warn');
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
    const key        = `${s.counterparty_name}|${s.minor_category}`;
    const _suggAcc   = (state.accountMap[s.account_id] !== undefined && state.accountMap[s.account_id] !== null) ? state.accountMap[s.account_id] : {};
    const acctName   = (_suggAcc.name !== undefined && _suggAcc.name !== null) ? _suggAcc.name : esc((s.account_id !== undefined && s.account_id !== null) ? s.account_id : '');
    const sym        = getSymbol(s.currency);
    const amount     = sym + Number(s.typical_amount).toFixed(2);
    const _minorCat  = state.categories.find(c => c.minor_category_key === s.minor_category);
    const minorLabel = (_minorCat !== undefined && _minorCat !== null && _minorCat.minor_category_label !== undefined && _minorCat.minor_category_label !== null) ? _minorCat.minor_category_label : ((s.minor_category !== undefined && s.minor_category !== null) ? s.minor_category : '');

    return `
      <div class="suggestion-card" data-key="${esc(key)}">
        <div class="suggestion-name" title="${esc(s.counterparty_name)}">${esc(s.counterparty_name)}</div>
        <div class="suggestion-meta" title="${esc(minorLabel)} · ${esc(acctName)}">${esc(minorLabel)} · ${esc(acctName)}</div>
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

function _fmtAccType(t) { return (_ACC_TYPE_LABEL[t] !== undefined && _ACC_TYPE_LABEL[t] !== null) ? _ACC_TYPE_LABEL[t] : t; }

function _accountsForTypeSel() {
  if (_accTypeSel.size === 0) return state.accounts;
  return state.accounts.filter(a => _accTypeSel.has(a.type));
}

function _accTypeDropdownLabel() {
  if (_accTypeSel.size === 0) return 'All account types';
  return Array.from(_accTypeSel).map(_fmtAccType).join(', ');
}

function _refreshFilterAccountDropdown() {
  const dropdown = el('filterAccountDropdown');
  if (dropdown === null || dropdown === undefined) return;
  const accts   = _accountsForTypeSel();
  const validIds = new Set(accts.map(a => a.id));
  if (_accTypeSel.size === 0) state.filters.accounts = [];
  else state.filters.accounts = state.filters.accounts.filter(id => validIds.has(id));
  dropdown.innerHTML = accts.length > 0
    ? accts.map(a => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
        <input type="checkbox" data-filter-account="${esc(a.id)}" ${state.filters.accounts.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}
      </label>`).join('')
    : `<span style="font-size:var(--text-sm);color:var(--muted)">No accounts for selected type</span>`;
  _attachFilterAccountCheckboxes(dropdown);
  const lbl = el('filterAccountLabel');
  if (lbl !== null && lbl !== undefined) lbl.textContent = state.filters.accounts.length > 0
    ? state.filters.accounts.map(id => { const a = state.accountMap[id]; return (a !== undefined && a !== null && a.name !== undefined && a.name !== null) ? a.name : id; }).join(', ')
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
        ? state.filters.accounts.map(id => { const a = state.accountMap[id]; return (a !== undefined && a !== null && a.name !== undefined && a.name !== null && a.name !== '') ? a.name : id; }).join(', ')
        : 'All accounts';
    });
  });
}

function _refreshFilterMinorDropdown() {
  const dropdown = el('filterMinorDropdown');
  if (dropdown === null || dropdown === undefined) return;
  const cats = state.filters.major.length > 0
    ? state.categories.filter(c => state.filters.major.includes(c.major_category_key))
    : state.categories;
  const minorMap = new Map();
  cats.forEach(c => minorMap.set(c.minor_category_key, c.minor_category_label));
  const minors = [...minorMap.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  const validSet = new Set(minors.map(m => m.key));
  state.filters.minor = state.filters.minor.filter(v => validSet.has(v));
  dropdown.innerHTML = minors.length
    ? minors.map(({ key, label }) => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
        <input type="checkbox" data-filter-minor="${esc(key)}" ${state.filters.minor.includes(key) ? 'checked' : ''}> ${esc(label)}
      </label>`).join('')
    : `<span style="font-size:var(--text-sm);color:var(--muted)">No minor categories</span>`;
  dropdown.querySelectorAll('[data-filter-minor]').forEach(cb => {
    cb.addEventListener('change', () => {
      const v = cb.dataset.filterMinor;
      if (cb.checked) { if (!state.filters.minor.includes(v)) state.filters.minor.push(v); }
      else { state.filters.minor = state.filters.minor.filter(x => x !== v); }
      const lbl = el('filterMinorLabel');
      if (lbl) lbl.textContent = state.filters.minor.length
        ? state.filters.minor.map(k => { const c = state.categories.find(x => x.minor_category_key === k); return (c !== undefined && c !== null && c.minor_category_label !== undefined && c.minor_category_label !== null) ? c.minor_category_label : k; }).join(', ')
        : 'All minor';
    });
  });
  const lbl = el('filterMinorLabel');
  if (lbl) lbl.textContent = state.filters.minor.length
    ? state.filters.minor.map(k => { const c = state.categories.find(x => x.minor_category_key === k); return (c !== undefined && c !== null && c.minor_category_label !== undefined && c.minor_category_label !== null) ? c.minor_category_label : k; }).join(', ')
    : 'All minor';
}

function _datalist(id, items) {
  // Always render the element so it exists in the DOM even before metadata loads.
  if (items === undefined || items === null) return `<datalist id="${esc(id)}"></datalist>`;
  return `<datalist id="${esc(id)}">${items.map(v => `<option value="${esc(String(v))}">`).join('')}</datalist>`;
}

function _attachTagAutocomplete(inputId, datalistId) {
  const input = el(inputId);
  const dl    = el(datalistId);
  if (input === null || input === undefined || dl === null || dl === undefined) return;
  input.addEventListener('input', () => {
    if (state.metadata === undefined || state.metadata === null) return;
    const tags = state.metadata.tags;
    if (tags === undefined || tags === null || tags.length === 0) return;
    const val       = input.value;
    const lastComma = val.lastIndexOf(',');
    const prefix    = lastComma >= 0 ? val.slice(0, lastComma + 1) + ' ' : '';
    const partial   = val.slice(lastComma + 1).trimStart().toLowerCase();
    const existing  = new Set(val.split(',').map(t => t.trim().toLowerCase()).filter(v => v !== ''));
    const hits      = tags.filter(t =>
      (partial === '' || t.toLowerCase().startsWith(partial)) && !existing.has(t.toLowerCase())
    );
    dl.innerHTML = hits.map(t => `<option value="${esc(prefix + t)}">`).join('');
  });
}

function _renderFilterBar() {
  const f        = state.filters;
  const allTypes = _txTypes();
  const allAccs  = state.accounts;
  const _majorMap = new Map();
  const _minorMap = new Map();
  state.categories.forEach(c => {
    _majorMap.set(c.major_category_key, c.major_category_label);
    _minorMap.set(c.minor_category_key, c.minor_category_label);
  });
  const allMajor = [..._majorMap.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  const _minorSrc = f.major.length
    ? state.categories.filter(c => f.major.includes(c.major_category_key))
    : state.categories;
  const _minorMapF = new Map();
  _minorSrc.forEach(c => _minorMapF.set(c.minor_category_key, c.minor_category_label));
  const allMinor = [..._minorMapF.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));

  const m = state.metadata;

  const RANGE_OPTS = [
    { value: 'last_30',    label: 'Last 30 days' },
    { value: 'this_month', label: 'This month'   },
    { value: 'last_month', label: 'Last month'   },
    { value: 'last_3',     label: 'Last 3 mo'    },
    { value: 'last_6',     label: 'Last 6 mo'    },
    { value: 'last_12',    label: 'Last 12 mo'   },
    { value: 'ytd',        label: 'Year to date' },
    { value: 'all',        label: 'All'          },
    { value: 'custom',     label: 'Custom'       },
  ];
  const isCustomRange = state.dateRange === 'custom';
  const _rangeInputFmt = d => { const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0'); return `${y}-${mo}-${day}`; };
  const { from: _rFrom, to: _rTo } = getRangeBounds();
  const rangeFromStr = isCustomRange ? ((state.customFrom !== undefined && state.customFrom !== null) ? state.customFrom : '') : _rangeInputFmt(_rFrom);
  const rangeToStr   = isCustomRange ? ((state.customTo   !== undefined && state.customTo   !== null) ? state.customTo   : '') : _rangeInputFmt(_rTo);
  const rangeDateStyle = (editable) => `background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);font-family:var(--grotesk);color:${editable ? 'var(--ink)' : 'var(--muted)'};cursor:${editable ? 'auto' : 'default'}`;

  const _findRangeOpt = RANGE_OPTS.find(o => o.value === state.dateRange);
  const activeChips = [
    ...(state.dateRange !== 'last_30' ? [{ label: (_findRangeOpt !== undefined && _findRangeOpt !== null) ? _findRangeOpt.label : state.dateRange, key: 'dateRange', val: '' }] : []),
    ...f.types.map(t     => ({ label: (_txTypeMap()[t] !== undefined && _txTypeMap()[t] !== null) ? _txTypeMap()[t] : t, key: 'types', val: t })),
    ...f.accounts.map(id => { const a = state.accountMap[id]; return { label: (a !== undefined && a !== null && a.name !== undefined && a.name !== null) ? a.name : id, key: 'accounts', val: id }; }),
    ...f.major.map(v     => { const _ml = _majorMap.get(v); return { label: (_ml !== undefined && _ml !== null) ? _ml : v, key: 'major', val: v }; }),
    ...f.minor.map(v     => { const _ml = _minorMap.get(v); return { label: (_ml !== undefined && _ml !== null) ? _ml : v, key: 'minor', val: v }; }),
    ...(f.user_location_country !== '' ? [{ label: 'Country: ' + esc(f.user_location_country), key: 'user_location_country', val: '' }] : []),
    ...(f.user_location_city    !== '' ? [{ label: 'City: '    + esc(f.user_location_city),    key: 'user_location_city',    val: '' }] : []),
    ...(f.user_location_area    !== '' ? [{ label: 'Area: '    + esc(f.user_location_area),    key: 'user_location_area',    val: '' }] : []),
    ...(f.tag    !== '' ? [{ label: 'Tag: '    + esc(f.tag),    key: 'tag',    val: '' }] : []),
    ...(f.search !== '' ? [{ label: 'Search: ' + esc(f.search), key: 'search', val: '' }] : []),
  ];

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="filterToggle">
      Filters${activeChips.length ? ` (${activeChips.length})` : ''} <span class="filter-arrow">${filterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${filterOpen ? '' : 'hidden'}" id="filterBody">
      <div class="filter-row">
        <label>Date range</label>
        <div style="flex:1;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div id="filterDateRangeWrap" style="flex:1;min-width:140px;position:relative">
            <button id="filterDateRangeTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
              <span id="filterDateRangeLabel">${esc((_findRangeOpt !== undefined && _findRangeOpt !== null) ? _findRangeOpt.label : RANGE_OPTS[0].label)}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterDateRangeDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:0 4px 16px rgba(0,0,0,.15)">
              ${RANGE_OPTS.map(o => `<div data-range-val="${esc(o.value)}" style="padding:6px 10px;font-size:var(--text-base);color:${state.dateRange === o.value ? 'var(--ember)' : 'var(--ink)'};background:${state.dateRange === o.value ? 'var(--hair)' : 'transparent'};border-radius:6px;cursor:pointer">${esc(o.label)}</div>`).join('')}
            </div>
          </div>
          <input type="date" id="filterDateFrom" value="${esc(rangeFromStr)}" ${isCustomRange ? '' : 'readonly'} style="${rangeDateStyle(isCustomRange)}">
          <span style="color:var(--muted)">–</span>
          <input type="date" id="filterDateTo" value="${esc(rangeToStr)}" ${isCustomRange ? '' : 'readonly'} style="${rangeDateStyle(isCustomRange)}">
        </div>
      </div>
      <div class="filter-row">
        <label>Type</label>
        <div id="filterTypeWrap" style="flex:1;min-width:120px;position:relative">
          <button id="filterTypeTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
            <span id="filterTypeLabel">${f.types.length ? f.types.map(t => (_txTypeMap()[t] !== undefined && _txTypeMap()[t] !== null) ? _txTypeMap()[t] : t).join(', ') : 'All types'}</span>
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
              <span id="filterAccountLabel">${f.accounts.length ? f.accounts.map(id => { const a = state.accountMap[id]; return (a !== undefined && a !== null && a.name !== undefined && a.name !== null && a.name !== '') ? a.name : id; }).join(', ') : 'All accounts'}</span>
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
              <span id="filterMajorLabel">${f.major.length ? f.major.map(k => { const _ml = _majorMap.get(k); return (_ml !== undefined && _ml !== null) ? _ml : k; }).join(', ') : 'All major'}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterMajorDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);max-height:240px;overflow-y:auto">
              ${allMajor.map(({ key, label }) => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
                <input type="checkbox" data-filter-major="${esc(key)}" ${f.major.includes(key) ? 'checked' : ''}> ${esc(label)}
              </label>`).join('')}
            </div>
          </div>
          <div id="filterMinorWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterMinorTrigger" type="button" style="width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none">
              <span id="filterMinorLabel">${f.minor.length ? f.minor.map(k => { const _ml = _minorMap.get(k); return (_ml !== undefined && _ml !== null) ? _ml : k; }).join(', ') : 'All minor'}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterMinorDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);max-height:240px;overflow-y:auto">
              ${allMinor.length
                ? allMinor.map(({ key, label }) => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
                    <input type="checkbox" data-filter-minor="${esc(key)}" ${f.minor.includes(key) ? 'checked' : ''}> ${esc(label)}
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
          ${_datalist('dlFCountry', (m !== null && m !== undefined) ? m.countries : null)}
          <input type="text" id="filterCity" value="${esc(f.user_location_city)}" list="dlFCity" placeholder="City" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFCity', (m !== null && m !== undefined) ? m.cities : null)}
          <input type="text" id="filterArea" value="${esc(f.user_location_area)}" list="dlFArea" placeholder="Area" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFArea', (m !== null && m !== undefined) ? m.areas : null)}
        </div>
      </div>
      <div class="filter-row">
        <label>Tag</label>
        <input type="text" id="filterTag" value="${esc(f.tag)}" placeholder="any tag" list="dlFTag" autocomplete="off">
        ${_datalist('dlFTag', (m !== null && m !== undefined) ? m.tags : null)}
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
        <div class="field-hint">Columns: tx_date_time, tx_timezone, tx_type, source_account, target_account, source_amount, target_amount, major_category, minor_category, description, counterparty_name, tx_tags, beneficiaries, user_location_area, user_location_city, user_location_country, user_location_latitude, user_location_longitude</div>
      </div>
    </div>
    <div id="txImportStatus">${_txImportResult !== null ? _txImportResult : ''}</div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="txImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="txImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="txImportError"></div>
  </div>`;
}

function _parseTxCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { transactions: [], errors: ['File is empty.'] };

  const headers  = parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const nameToId = {};
  ((state.accounts !== undefined && state.accounts !== null) ? state.accounts : []).forEach(a => { nameToId[a.name.trim().toLowerCase()] = a.id; });

  const transactions = [];
  const errors       = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] !== undefined && vals[idx] !== null ? vals[idx] : '').trim(); });

    const rowErrors = [];
    if (row.tx_date_time === '')    rowErrors.push('missing tx_date_time');
    if (row.tx_type === '')         rowErrors.push('missing tx_type');
    if (row.source_amount === '' && row.target_amount === '') rowErrors.push('missing amount (source_amount or target_amount)');
    if (row.major_category === '')  rowErrors.push('missing major_category');
    if (row.minor_category === '')  rowErrors.push('missing minor_category');

    let sourceId = '';
    let targetId = '';
    if (row.source_account !== undefined && row.source_account !== null && row.source_account.trim() !== '') {
      const _srcLookup = nameToId[row.source_account.trim().toLowerCase()];
      sourceId = (_srcLookup !== undefined && _srcLookup !== null) ? _srcLookup : '';
      if (sourceId === '') rowErrors.push(`unknown account: "${row.source_account}"`);
    }
    if (row.target_account !== undefined && row.target_account !== null && row.target_account.trim() !== '') {
      const _tgtLookup = nameToId[row.target_account.trim().toLowerCase()];
      targetId = (_tgtLookup !== undefined && _tgtLookup !== null) ? _tgtLookup : '';
      if (targetId === '') rowErrors.push(`unknown account: "${row.target_account}"`);
    }

    if (rowErrors.length) { errors.push(`Row ${i + 1}: ${rowErrors.join('; ')}`); continue; }

    const tx_date_time = localToUtcISO(row.tx_date_time);

    transactions.push({
      tx_date_time,
      tx_timezone:              (row.tx_timezone              !== undefined && row.tx_timezone              !== null && row.tx_timezone              !== '') ? row.tx_timezone              : '',
      tx_type:                  row.tx_type,
      source_account:           sourceId,
      target_account:           targetId,
      user_location_area:       (row.user_location_area       !== undefined && row.user_location_area       !== null && row.user_location_area       !== '') ? row.user_location_area       : '',
      user_location_city:       (row.user_location_city       !== undefined && row.user_location_city       !== null && row.user_location_city       !== '') ? row.user_location_city       : '',
      user_location_country:    (row.user_location_country    !== undefined && row.user_location_country    !== null && row.user_location_country    !== '') ? row.user_location_country    : '',
      user_location_latitude:   (row.user_location_latitude   !== undefined && row.user_location_latitude   !== null && row.user_location_latitude   !== '') ? parseFloat(row.user_location_latitude)  : '',
      user_location_longitude:  (row.user_location_longitude  !== undefined && row.user_location_longitude  !== null && row.user_location_longitude  !== '') ? parseFloat(row.user_location_longitude) : '',
      source_amount:            (row.source_amount !== undefined && row.source_amount !== null && row.source_amount !== '') ? parseFloat(row.source_amount) : '',
      target_amount:            (row.target_amount !== undefined && row.target_amount !== null && row.target_amount !== '') ? parseFloat(row.target_amount) : '',
      major_category:           row.major_category,
      minor_category:           row.minor_category,
      description:              (row.description       !== undefined && row.description       !== null && row.description       !== '') ? row.description       : '',
      counterparty_name:        (row.counterparty_name !== undefined && row.counterparty_name !== null && row.counterparty_name !== '') ? row.counterparty_name : '',
      tx_tags:                  (row.tx_tags           !== undefined && row.tx_tags           !== null && row.tx_tags           !== '') ? row.tx_tags           : '',
      beneficiaries:            (row.beneficiaries     !== undefined && row.beneficiaries     !== null && row.beneficiaries     !== '') ? row.beneficiaries     : '',
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
  if (transactions.length === 0) return errHtml + '<p class="placeholder">No valid rows found.</p>';
  const countMsg = `${transactions.length} transaction${transactions.length !== 1 ? 's' : ''} ready to import` +
    (errors.length ? ` · ${errors.length} row${errors.length !== 1 ? 's' : ''} skipped` : '');
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${countMsg}</p>`;
}

const _TX_IMPORT_CHUNK = 25;

async function _geocodeImportRows(rows) {
  const status = el('txImportStatus');

  // Forward: has area/city/country but missing lat+lon.
  const fwdPairs = new Map();
  rows.forEach(r => {
    if (r.user_location_latitude !== undefined && r.user_location_latitude !== null && r.user_location_latitude !== '') return;
    if (r.user_location_longitude !== undefined && r.user_location_longitude !== null && r.user_location_longitude !== '') return;
    const area    = ((r.user_location_area    !== undefined && r.user_location_area    !== null) ? r.user_location_area    : '').trim();
    const city    = ((r.user_location_city    !== undefined && r.user_location_city    !== null) ? r.user_location_city    : '').trim();
    const country = ((r.user_location_country !== undefined && r.user_location_country !== null) ? r.user_location_country : '').trim();
    if (area === '' && city === '' && country === '') return;
    const key = area + '|' + city + '|' + country;
    if (!fwdPairs.has(key)) fwdPairs.set(key, { area, city, country });
  });

  // Reverse: has lat+lon but missing all of area/city/country.
  const revPairs = new Map();
  rows.forEach(r => {
    if (r.user_location_latitude === undefined || r.user_location_latitude === null || r.user_location_latitude === '') return;
    if (r.user_location_longitude === undefined || r.user_location_longitude === null || r.user_location_longitude === '') return;
    if ((r.user_location_area !== undefined && r.user_location_area !== null && r.user_location_area !== '') ||
        (r.user_location_city !== undefined && r.user_location_city !== null && r.user_location_city !== '') ||
        (r.user_location_country !== undefined && r.user_location_country !== null && r.user_location_country !== '')) return;
    const key = String(r.user_location_latitude).trim() + '|' + String(r.user_location_longitude).trim();
    if (!revPairs.has(key)) revPairs.set(key, { lat: r.user_location_latitude, lon: r.user_location_longitude });
  });

  const total = fwdPairs.size + revPairs.size;
  if (total === 0) return rows; // nothing to do — skip with zero delay

  const fwdResolved = new Map();
  const revResolved = new Map();
  let done = 0;

  const showGeoProgress = () => {
    if (status === null || status === undefined) return;
    status.innerHTML = `
      <p style="font-size:13px;color:var(--muted);margin:0 0 6px">
        Geocoding… ${done} / ${total} unique locations
      </p>
      <div style="height:4px;border-radius:2px;background:var(--border)">
        <div style="height:100%;border-radius:2px;background:var(--ember);width:${Math.round(done/total*100)}%;transition:width .3s"></div>
      </div>`;
  };

  for (const [key, { area, city, country }] of fwdPairs) {
    done++;
    showGeoProgress();
    try {
      const q   = encodeURIComponent([area, city, country].filter(v => v !== undefined && v !== null && v !== '').join(', '));
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (data !== null && data !== undefined && data[0] !== undefined && data[0] !== null) fwdResolved.set(key, { lat: parseFloat(data[0].lat).toFixed(6), lon: parseFloat(data[0].lon).toFixed(6) });
    } catch (_) {}
    if (done < total) await new Promise(r => setTimeout(r, 1050));
  }

  for (const [key, { lat, lon }] of revPairs) {
    done++;
    showGeoProgress();
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json`, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (data !== null && data !== undefined && data.address !== undefined && data.address !== null) {
        const addr = data.address;
        const _revArea = (addr.suburb !== undefined && addr.suburb !== null) ? addr.suburb
          : ((addr.neighbourhood !== undefined && addr.neighbourhood !== null) ? addr.neighbourhood
          : ((addr.county !== undefined && addr.county !== null) ? addr.county : ''));
        const _revCity = (addr.city !== undefined && addr.city !== null) ? addr.city
          : ((addr.town !== undefined && addr.town !== null) ? addr.town
          : ((addr.village !== undefined && addr.village !== null) ? addr.village
          : ((addr.municipality !== undefined && addr.municipality !== null) ? addr.municipality : '')));
        const _revCountry = (addr.country !== undefined && addr.country !== null) ? addr.country : '';
        revResolved.set(key, { area: _revArea, city: _revCity, country: _revCountry });
      }
    } catch (_) {}
    if (done < total) await new Promise(r => setTimeout(r, 1050));
  }

  return rows.map(r => {
    const out = Object.assign({}, r);
    if ((out.user_location_latitude === undefined || out.user_location_latitude === null || out.user_location_latitude === '') &&
        (out.user_location_longitude === undefined || out.user_location_longitude === null || out.user_location_longitude === '')) {
      const area    = ((r.user_location_area    !== undefined && r.user_location_area    !== null) ? r.user_location_area    : '').trim();
      const city    = ((r.user_location_city    !== undefined && r.user_location_city    !== null) ? r.user_location_city    : '').trim();
      const country = ((r.user_location_country !== undefined && r.user_location_country !== null) ? r.user_location_country : '').trim();
      const coords  = fwdResolved.get(area + '|' + city + '|' + country);
      if (coords !== undefined && coords !== null) { out.user_location_latitude = coords.lat; out.user_location_longitude = coords.lon; }
    } else if ((r.user_location_area === undefined || r.user_location_area === null || r.user_location_area === '') &&
               (r.user_location_city === undefined || r.user_location_city === null || r.user_location_city === '') &&
               (r.user_location_country === undefined || r.user_location_country === null || r.user_location_country === '')) {
      const key  = String(r.user_location_latitude).trim() + '|' + String(r.user_location_longitude).trim();
      const addr = revResolved.get(key);
      if (addr) { out.user_location_area = addr.area; out.user_location_city = addr.city; out.user_location_country = addr.country; }
    }
    return out;
  });
}

async function _submitTxImport(transactions) {
  const btn    = el('txImportConfirm');
  const errEl  = el('txImportError');
  const status = el('txImportStatus');
  if (btn !== null && btn !== undefined)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl !== null && errEl !== undefined) errEl.textContent = '';

  // Strip display-only fields and deduplicate before chunking.
  const seen    = new Set();
  const payload = [];
  transactions.forEach(tx => {
    const clean = Object.assign({}, tx);
    delete clean._src_name;
    delete clean._tgt_name;
    const key = [clean.tx_date_time, clean.tx_type, (clean.source_account !== undefined && clean.source_account !== null) ? clean.source_account : '', (clean.target_account !== undefined && clean.target_account !== null) ? clean.target_account : '', clean.source_amount].join('|');
    if (!seen.has(key)) { seen.add(key); payload.push(clean); }
  });

  const chunks = [];
  for (let i = 0; i < payload.length; i += _TX_IMPORT_CHUNK)
    chunks.push(payload.slice(i, i + _TX_IMPORT_CHUNK));

  let totalCreated = 0;
  let totalFailed  = 0;
  let allResults   = [];

  const setProgress = (chunkIdx) => {
    if (status === null || status === undefined) return;
    const done = Math.min(chunkIdx * _TX_IMPORT_CHUNK, payload.length);
    const pct  = payload.length > 0 ? Math.round((done / payload.length) * 100) : 0;
    status.innerHTML = `
      <p style="font-size:13px;color:var(--muted);margin:0 0 6px">
        Importing… ${done} / ${payload.length} rows (chunk ${chunkIdx} of ${chunks.length})
      </p>
      <div style="height:4px;border-radius:2px;background:var(--border)">
        <div style="height:100%;border-radius:2px;background:var(--ember);width:${pct}%;transition:width .3s"></div>
      </div>`;
  };

  showLoading();
  try {
    for (let c = 0; c < chunks.length; c++) {
      setProgress(c);
      const res = await ExpenseAPI.createTransactionsBulk({ transactions: chunks[c] });

      if (!res.ok && (res.results === undefined || res.results === null)) {
        if (errEl !== null && errEl !== undefined) errEl.textContent = 'Error on chunk ' + (c + 1) + ': ' + ((res.error !== undefined && res.error !== null && String(res.error).trim() !== '') ? res.error : '[no error code]');
        if (btn !== null && btn !== undefined)   { btn.disabled = false; btn.textContent = 'Import'; }
        return;
      }

      if (res.created !== undefined && res.created !== null) totalCreated += res.created;
      if (res.failed  !== undefined && res.failed  !== null) totalFailed  += res.failed;
      if (res.results !== undefined && res.results !== null) allResults    = allResults.concat(res.results);
    }

    // All chunks done
    if (totalFailed === 0) {
      _txImportParsed    = null;
      _txImportResult    = null;
      state.txImportOpen = false;
      showMsg(`${totalCreated} transaction${totalCreated !== 1 ? 's' : ''} imported.`);
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      const enriched   = allResults.map((r, i) => ({ ...r, tx: (payload[i] !== undefined && payload[i] !== null) ? payload[i] : {} }));
      const failedOnly = enriched.filter(r => !r.ok);
      const dupCount   = failedOnly.filter(r => r.error === 'duplicate_transaction').length;
      const errCount   = failedOnly.length - dupCount;

      const resultRows = failedOnly.map(r => {
        const tx    = r.tx;
        const isDup = r.error === 'duplicate_transaction';
        const _txAcctId = (tx.account_id !== undefined && tx.account_id !== null && String(tx.account_id).trim() !== '') ? tx.account_id
          : ((tx.source_account !== undefined && tx.source_account !== null && String(tx.source_account).trim() !== '') ? tx.source_account : '');
        const _txCatStr = (tx.major_category !== undefined && tx.major_category !== null && String(tx.major_category).trim() !== '')
          ? ((tx.minor_category !== undefined && tx.minor_category !== null && String(tx.minor_category).trim() !== '') ? `${tx.major_category} / ${tx.minor_category}` : tx.major_category)
          : '';
        const parts = [
          (tx.source_amount !== undefined && tx.source_amount !== null && tx.source_amount !== '') ? String(tx.source_amount) : '',
          _txAcctId,
          _txCatStr,
        ].filter(v => v !== undefined && v !== null && v !== '');
        const _rLabel = (r.label !== undefined && r.label !== null) ? r.label : '';
        const _rError = (r.error !== undefined && r.error !== null && String(r.error).trim() !== '') ? r.error : '[no error code]';
        return `<tr>
          <td style="font-size:12px">
            <div style="color:var(--ink);font-family:var(--mono)">${esc(_rLabel)}</div>
            ${parts.length ? `<div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(parts.join(' · '))}</div>` : ''}
          </td>
          <td>${isDup
            ? `<span class="badge" style="color:var(--muted)">duplicate</span>`
            : `<span class="badge badge-et-out" style="font-family:var(--mono);font-size:11px">${esc(_rError)}</span>`}
          </td>
        </tr>`;
      }).join('');

      const summary = [
        `${totalCreated} created`,
        errCount  ? `<span style="color:var(--ember)">${errCount} error${errCount > 1 ? 's' : ''}</span>` : '',
        dupCount  ? `<span style="color:var(--muted)">${dupCount} duplicate${dupCount > 1 ? 's' : ''}</span>` : '',
      ].filter(v => v !== undefined && v !== null && v !== '').join(' · ');

      _txImportResult = `
        <div style="margin-bottom:8px;font-size:13px">${summary}</div>
        <div class="table-wrap" style="margin-bottom:8px">
          <table>
            <thead><tr><th>Failed transaction</th><th>Error</th></tr></thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>`;
      if (status !== null && status !== undefined) status.innerHTML = _txImportResult;
      _txImportParsed = null;
      if (btn !== null && btn !== undefined) { btn.disabled = true; btn.textContent = 'Import'; }
      if (totalCreated > 0) document.dispatchEvent(new CustomEvent('et:reload'));
      const toastParts = [`${totalCreated} imported`];
      if (errCount > 0) toastParts.push(`${errCount} error${errCount > 1 ? 's' : ''}`);
      if (dupCount > 0) toastParts.push(`${dupCount} duplicate${dupCount > 1 ? 's' : ''}`);
      showMsg(toastParts.join(' · '), 'warn');
    }
  } catch (err) {
    console.error('[transactions] _submitTxImport failed:', err);
    if (errEl !== null && errEl !== undefined) errEl.textContent = 'Connection error.';
    if (btn !== null && btn !== undefined)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}

function _attachSuggestionEvents() {
  el('suggestionsToggle').addEventListener('click', () => {
    state.suggestionsOpen = !state.suggestionsOpen;
    renderTransactions();
  });
}

function _positionDropdown(triggerId, dropdownId) {
  const trigger  = el(triggerId);
  const dropdown = el(dropdownId);
  if (trigger === null || trigger === undefined || dropdown === null || dropdown === undefined) return;
  const rect = trigger.getBoundingClientRect();
  dropdown.style.top   = (rect.bottom + 4) + 'px';
  dropdown.style.left  = rect.left + 'px';
  dropdown.style.width = rect.width + 'px';
}

const _FILTER_DROPDOWN_IDS = ['filterDateRangeDropdown','filterTypeDropdown','filterAccTypeDropdown','filterAccountDropdown','filterMajorDropdown','filterMinorDropdown'];
const _FILTER_WRAP_IDS     = ['filterDateRangeWrap','filterTypeWrap','filterAccTypeWrap','filterAccountWrap','filterMajorWrap','filterMinorWrap'];

function _closeAllFilterDropdowns(exceptId) {
  _FILTER_DROPDOWN_IDS.forEach(id => { const d = el(id); if ((d !== null && d !== undefined) && id !== exceptId) d.classList.add('hidden'); });
}

function _attachFilterEvents() {
  if (_filterEventsAbort) _filterEventsAbort.abort();
  _filterEventsAbort = new AbortController();
  const { signal: filterSignal } = _filterEventsAbort;

  el('filterToggle').addEventListener('click', () => { filterOpen = !filterOpen; renderTransactions(); }, { signal: filterSignal });

  // ── Date range ────────────────────────────────────────────────────────────
  const dateRangeTrigger  = el('filterDateRangeTrigger');
  const dateRangeDropdown = el('filterDateRangeDropdown');
  if (dateRangeTrigger && dateRangeDropdown) {
    dateRangeTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = dateRangeDropdown.classList.contains('hidden');
      if (opening) _closeAllFilterDropdowns('filterDateRangeDropdown');
      dateRangeDropdown.classList.toggle('hidden');
      if (opening) _positionDropdown('filterDateRangeTrigger', 'filterDateRangeDropdown');
    });
    dateRangeDropdown.querySelectorAll('[data-range-val]').forEach(item => {
      item.addEventListener('click', () => {
        state.dateRange  = item.dataset.rangeVal;
        state.customFrom = '';
        state.customTo   = '';
        renderTransactions();
      });
    });
  }
  el('filterDateFrom').addEventListener('change', e => {
    state.customFrom = e.target.value;
    state.dateRange  = 'custom';
    renderTransactions();
  });
  el('filterDateTo').addEventListener('change', e => {
    state.customTo  = e.target.value;
    state.dateRange = 'custom';
    renderTransactions();
  });

  const typeTrigger  = el('filterTypeTrigger');
  const typeDropdown = el('filterTypeDropdown');
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
        if (lbl) lbl.textContent = state.filters.types.length ? state.filters.types.map(v => (_txTypeMap()[v] !== undefined && _txTypeMap()[v] !== null) ? _txTypeMap()[v] : v).join(', ') : 'All types';
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
        if (lbl) lbl.textContent = state.filters.major.length
          ? state.filters.major.map(k => { const c = state.categories.find(x => x.major_category_key === k); return (c !== undefined && c !== null && c.major_category_label !== undefined && c.major_category_label !== null) ? c.major_category_label : k; }).join(', ')
          : 'All major';
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
        if (lbl) lbl.textContent = state.filters.minor.length
          ? state.filters.minor.map(k => { const c = state.categories.find(x => x.minor_category_key === k); return (c !== undefined && c !== null && c.minor_category_label !== undefined && c.minor_category_label !== null) ? c.minor_category_label : k; }).join(', ')
          : 'All minor';
      });
    });
  }

  // ── Global outside-click: close all dropdowns when clicking outside every wrap ──
  document.addEventListener('click', e => {
    const inAnyWrap = _FILTER_WRAP_IDS.some(id => { const w = el(id); return (w !== null && w !== undefined) && w.contains(e.target); });
    if (!inAnyWrap) _closeAllFilterDropdowns();
  }, { signal: filterSignal });

  const bindText = (id, key) => el(id).addEventListener('input', e => {
    state.filters[key] = e.target.value.trim();
  });

  bindText('filterCountry', 'user_location_country');
  bindText('filterCity',    'user_location_city');
  bindText('filterArea',    'user_location_area');
  bindText('filterTag',     'tag');
  bindText('filterSearch',  'search');
  _attachTagAutocomplete('filterTag', 'dlFTag');

  el('applyFilters').addEventListener('click', () => {
    state.txPage = 1; renderTransactions();
  });

  el('clearFilters').addEventListener('click', () => {
    _accTypeSel.clear();
    state.filters = { types:[], accounts:[], major:[], minor:[], user_location_country:'', user_location_city:'', user_location_area:'', tag:'', search:'' };
    state.dateRange  = 'last_30';
    state.customFrom = '';
    state.customTo   = '';
    state.txPage = 1; renderTransactions();
  });

  el('transactionsContent').querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.chipKey;
      const val = btn.dataset.chipVal;
      if (key === 'dateRange') {
        state.dateRange  = 'last_30';
        state.customFrom = '';
        state.customTo   = '';
      } else if (Array.isArray(state.filters[key])) {
        state.filters[key] = state.filters[key].filter(x => x !== val);
      } else {
        state.filters[key] = '';
      }
      state.txPage = 1; renderTransactions();
    });
  });
}
