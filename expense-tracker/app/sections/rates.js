import { state } from '../core/state.js';
import { el, esc, fmtDateTime, openContextMenu, closeContextMenu, clearFormError, showFormError } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

let _rateMenuKey = null;

// The server owns the list (list_rates_view): order, search, labels, the XAU
// read-only flag (allowed_actions) and which accounts use each currency.
const LIST_VIEW = 'list_rates_view';
let _sort    = { col: 'sheet', dir: 'asc' };
let _viewSeq = 0;
let _viewError = '';

function _viewRows() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true ? response.data.rows : null;
}

function _rateRow(currency) {
  return (_viewRows() ?? []).find(row => row.currency === currency) ?? null;
}

async function _loadView() {
  const seq = ++_viewSeq;
  let response;
  try { response = await ExpenseAPI.view(LIST_VIEW, { sort: _sort.col, dir: _sort.dir }); }
  catch (error) { console.error('[rates] list view failed:', error); response = null; }
  if (seq !== _viewSeq) return;
  if (response?.ok !== true) {
    _viewError = response?.message || 'Currencies could not be loaded. Check your connection and refresh.';
  } else {
    _viewError = '';
    state.views[LIST_VIEW] = response;
  }
  _renderList();
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Navigation, quote changes and reloads: render the last payload, then refresh.
export function renderRates() {
  if (state.views === undefined || state.views === null) state.views = {};
  _render();
  _loadView();
}

function _listHtml() {
  const rows = _viewRows();
  if (rows === null) return _viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : '<p class="placeholder">Loading currencies…</p>';
  const cardRows = rows.map(r => {
    if (state.rateDeleteCurrency === r.currency) return `<div class="card record-confirm-card">${_renderRateDelete(r)}</div>`;
    return `<div class="rate-card">
      <div class="rate-card-body">
        <div class="rate-card-code">${esc(r.currency)}${r.symbol ? ` <span class="rate-card-sym">${esc(r.symbol)}</span>` : ''}</div>
        <div class="rate-card-updated">${r.updated_at ? esc(fmtDateTime(r.updated_at)) : '—'}</div>
      </div>
      <div class="rate-card-rate td-mono">${esc(r.rate_label)}</div>
      ${_menuButton(r) || '<span></span>'}
    </div>`;
  }).join('');
  const th = (col, label, width) => `<th${width ? ` style="width:${width}px"` : ''}${_sort.col === col ? ` class="sort-${_sort.dir}"` : ''} data-rate-sort="${col}">${label}</th>`;
  return `
    ${_viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : ''}
    <div class="table-wrap rate-table-wrap">
      <table>
        <thead><tr>
          ${th('currency', 'Currency', 100)}
          <th style="width:80px">Symbol</th>
          ${th('rate', 'Rate (per 1g XAU)', 140)}
          ${th('updated_at', 'Updated')}
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => _rateRowHtml(r)).join('')}
        </tbody>
      </table>
    </div>
    <div class="rate-cards">${cardRows}</div>`;
}

function _render() {
  closeContextMenu(); _rateMenuKey = null;
  const content = el('ratesContent');
  const addOrEditOpen = state.rateAddOpen || !!state.rateEditCurrency;
  content.innerHTML = `
    <div class="sec-head">
      <button class="btn btn-primary btn-sm" id="rateAddBtn" style="margin-left:auto">${addOrEditOpen ? '× Close' : '+ Add'}</button>
    </div>
    <p class="sec-sub" style="margin:-8px 0 16px">Units of currency per 1g XAU. XAU is the base (read-only).</p>
    ${state.rateAddOpen    ? _renderAddForm()                                          : ''}
    ${state.rateEditCurrency ? _renderEditForm(_rateRow(state.rateEditCurrency)) : ''}
    <div id="rateListRegion">${_listHtml()}</div>`;

  _attachRateEvents();
}

// A landing response re-renders only the list, so typed form input survives.
function _renderList() {
  const region = el('rateListRegion');
  if (region === null || region === undefined) { _render(); return; }
  closeContextMenu(); _rateMenuKey = null;
  region.innerHTML = _listHtml();
  _attachListEvents(region);
}

function _menuButton(r) {
  return r.allowed_actions.length === 0 ? '' : `<button class="tx-menu-trigger" data-action="rate-menu" data-currency="${esc(r.currency)}">⋮</button>`;
}

// ── Add form ──────────────────────────────────────────────────────────────────

function _renderAddForm() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="form-grid form-grid-4">
      <div class="field">
        <label for="rateNewCurrency">Currency code *</label>
        <input type="text" id="rateNewCurrency" placeholder="e.g. JPY" maxlength="4" style="text-transform:uppercase">
        <div class="field-hint">ISO 4217 code (3–4 letters).</div>
      </div>
      <div class="field">
        <label for="rateNewSymbol">Symbol</label>
        <input type="text" id="rateNewSymbol" placeholder="e.g. ¥" maxlength="8">
        <div class="field-hint">Display prefix (optional).</div>
      </div>
      <div class="field">
        <label for="rateNewRate">Rate per 1g XAU *</label>
        <input type="number" id="rateNewRate" placeholder="e.g. 195.5" min="0.0001" step="any">
        <div class="field-hint">Units of this currency per 1g XAU.</div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" id="rateSaveNew">Save</button>
      <button class="btn btn-secondary" id="rateCancelNew">Cancel</button>
    </div>
    <div class="pin-error" id="rateAddError"></div>
  </div>`;
}

// ── Edit form ─────────────────────────────────────────────────────────────────

function _renderEditForm(r) {
  if (!r) return '';
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="form-grid form-grid-4">
      <div class="field">
        <label>Currency code</label>
        <input type="text" value="${esc(r.currency)}" disabled>
        <div class="field-hint">Currency code cannot be changed.</div>
      </div>
      <div class="field">
        <label for="rateEditSymbol">Symbol</label>
        <input type="text" id="rateEditSymbol" value="${esc(r.symbol ?? '')}" maxlength="8" placeholder="e.g. ¥">
        <div class="field-hint">Display prefix (optional).</div>
      </div>
      <div class="field">
        <label for="rateEditRate">Rate per 1g XAU *</label>
        <input type="number" id="rateEditRate" value="${esc(r.rate ?? '')}" min="0.0001" step="any">
        <div class="field-hint">Units of this currency per 1g XAU.</div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" id="rateSaveEdit">Save</button>
      <button class="btn btn-secondary" id="rateCancelEdit">Cancel</button>
    </div>
    <div class="pin-error" id="rateEditError"></div>
  </div>`;
}

// ── Table rows ────────────────────────────────────────────────────────────────

function _renderRateDelete(r) {
    // Blocked state — backend refused because accounts or transactions still
    // use this currency. Currency on an account is immutable, so the recovery
    // path is to delete those accounts/transactions first.
    if (state.rateDeleteBlocked) {
      const blocked = state.rateDeleteBlocked;
      const n       = blocked.referenced_count;
      let body, hint;
      if (blocked.error === 'currency_in_use_by_accounts') {
        const names = r.used_by_accounts.map(name => `<strong>${esc(name)}</strong>`);
        const namesStr = names.length ? names.join(', ') : `${esc(n)} account${n === 1 ? '' : 's'}`;
        body = `Cannot delete <strong>${esc(r.currency)}</strong> — used by: ${namesStr}.`;
        hint = 'Delete those accounts first (an account\'s currency cannot be changed).';
      } else {
        const noun = n === 1 ? 'transaction is' : 'transactions are';
        body = `Cannot delete <strong>${esc(r.currency)}</strong> — <strong>${n}</strong> ${noun} recorded in this currency.`;
        hint = 'Delete or reassign those transactions first.';
      }
      return `
          <span class="confirm-text">${body}</span>
          <div style="color:var(--muted);font-size:var(--text-sm);margin-top:4px">${hint}</div>
        <div class="row-actions">
          <button class="btn-link muted" data-action="rate-cancel-delete">Cancel</button>
        </div>`;
    }
    return `<span class="confirm-text">Delete <strong>${esc(r.currency)}</strong>?</span>
      <div class="row-actions">
        <button class="btn-link danger" data-action="rate-confirm-delete" data-currency="${esc(r.currency)}">Yes, delete</button>
        <button class="btn-link muted"  data-action="rate-cancel-delete">Cancel</button>
      </div>`;
}

function _rateRowHtml(r) {
  if (state.rateDeleteCurrency === r.currency) {
    return `<tr><td colspan="5">${_renderRateDelete(r)}</td></tr>`;
  }

  return `<tr>
    <td class="td-mono"><strong>${esc(r.currency)}</strong></td>
    <td>${esc(r.symbol === '' ? '—' : r.symbol)}</td>
    <td class="td-mono">${esc(r.rate_label)}</td>
    <td class="td-muted td-mono">${r.updated_at ? esc(fmtDateTime(r.updated_at)) : '—'}</td>
    <td>${_menuButton(r)}</td>
  </tr>`;
}

// ── Events ────────────────────────────────────────────────────────────────────

const _MENU_LABELS = { edit: 'Edit', delete: 'Delete' };

function _attachRateEvents() {
  el('rateAddBtn')?.addEventListener('click', () => {
    if (state.rateAddOpen || state.rateEditCurrency) {
      state.rateAddOpen      = false;
      state.rateEditCurrency = null;
    } else {
      state.rateAddOpen = true;
    }
    _render();
  });

  // Add form
  el('rateSaveNew')?.addEventListener('click', _saveNewRate);
  el('rateCancelNew')?.addEventListener('click', () => { state.rateAddOpen = false; _render(); });
  el('rateNewRate')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  el('rateSaveNew')?.click();
    if (e.key === 'Escape') el('rateCancelNew')?.click();
  });

  // Edit form
  el('rateSaveEdit')?.addEventListener('click', () => _saveEdit(state.rateEditCurrency));
  el('rateCancelEdit')?.addEventListener('click', () => { state.rateEditCurrency = null; _render(); });
  el('rateEditRate')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  _saveEdit(state.rateEditCurrency);
    if (e.key === 'Escape') { state.rateEditCurrency = null; _render(); }
  });

  const region = el('rateListRegion');
  if (region !== null && region !== undefined) _attachListEvents(region);
}

function _attachListEvents(region) {
  const handleRateAction = async e => {
    const btn      = e.target.closest('[data-action]');
    if (!btn) return;
    const action   = btn.dataset.action;
    const currency = btn.dataset.currency;

    if (action === 'rate-menu') {
      if (_rateMenuKey === currency) { closeContextMenu(); _rateMenuKey = null; return; }
      const row = _rateRow(currency);
      if (row === null) return;
      _rateMenuKey = currency;
      openContextMenu(btn, row.allowed_actions.map(key => ({ key: 'rate-' + key, label: _MENU_LABELS[key] ?? key, cls: key === 'delete' ? 'danger' : '' })), key => {
        _rateMenuKey = null;
        if (key === 'rate-edit') {
          state.rateEditCurrency = currency; state.rateAddOpen = false;
          state.rateDeleteCurrency = null; state.rateDeleteBlocked = null;
          _render(); el('rateEditRate')?.focus();
        }
        if (key === 'rate-delete') {
          state.rateDeleteCurrency = currency; state.rateDeleteBlocked = null;
          state.rateEditCurrency = null; _render();
        }
      });
      return;
    }
    if (action === 'rate-cancel-delete') {
      state.rateDeleteCurrency = null;
      state.rateDeleteBlocked  = null;
      _render();
    }
    if (action === 'rate-confirm-delete') await _confirmDelete(currency);
  };

  region.querySelector('.rate-table-wrap')?.addEventListener('click', handleRateAction);
  region.querySelector('.rate-cards')?.addEventListener('click', handleRateAction);
  region.querySelectorAll?.('th[data-rate-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.rateSort;
      _sort = { col, dir: _sort.col === col && _sort.dir === 'asc' ? 'desc' : 'asc' };
      _renderList();
      _loadView();
    });
  });
}

// ── Server errors ─────────────────────────────────────────────────────────────
// upsertRate validates (currency, rate > 0, mode 'create' → rate_already_exists)
// and returns `field` + `message`; the forms render them as-is.
const _RATE_FIELD_IDS = {
  add:  { currency: 'rateNewCurrency', symbol: 'rateNewSymbol', rate: 'rateNewRate' },
  edit: { symbol: 'rateEditSymbol', rate: 'rateEditRate' },
};

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNewRate() {
  const currency = (el('rateNewCurrency')?.value ?? '').trim().toUpperCase();
  const symbol   = (el('rateNewSymbol')?.value   ?? '').trim();
  const rate     = (el('rateNewRate')?.value ?? '').trim();
  const errEl    = el('rateAddError');
  const saveBtn  = el('rateSaveNew');
  if (saveBtn.disabled) return;
  clearFormError(errEl);

  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  showLoading();
  try {
    const res = await ExpenseAPI.upsertRate({ currency, symbol, rate, mode: 'create' });
    if (res.ok) {
      state.rateAddOpen = false;
      showMsg('Currency added.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[rates] _saveNewRate failed:', res?.error);
      showFormError(errEl, res, _RATE_FIELD_IDS.add);
      saveBtn.disabled = false; saveBtn.textContent = 'Save';
    }
  } catch (_) {
    console.warn('[rates] _saveNewRate failed:', _);
    errEl.textContent = 'Connection error.';
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveEdit(currency) {
  const rateVal   = (el('rateEditRate')?.value ?? '').trim();
  const symbolVal = (el('rateEditSymbol')?.value ?? '').trim();
  const errEl     = el('rateEditError');
  clearFormError(errEl);

  const saveBtn = el('rateSaveEdit');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.upsertRate({ currency, rate: rateVal, symbol: symbolVal });
    if (res.ok) {
      state.rateEditCurrency = null;
      showMsg('Rate updated.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[rates] _saveEdit failed:', res?.error);
      showFormError(errEl, res, _RATE_FIELD_IDS.edit);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }
  } catch (_) {
    console.warn('[rates] _saveEdit failed:', _);
    if (errEl) errEl.textContent = 'Connection error.';
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function _confirmDelete(currency) {
  showLoading();
  try {
    const res = await ExpenseAPI.deleteRate({ currency });
    if (res.ok) {
      state.rateDeleteCurrency = null;
      state.rateDeleteBlocked  = null;
      showMsg('Currency removed.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else if (res.error === 'currency_in_use_by_accounts' || res.error === 'currency_in_use_by_transactions') {
      // T-05: keep the row in delete-confirm state, switch to blocked variant.
      state.rateDeleteBlocked = {
        error: res.error,
        referenced_count: res.referenced_count,
      };
      _render();
    } else {
      console.warn('[rates] _confirmDelete failed:', res?.error);
      showMsg('Failed: ' + (res.error || 'unknown'), 'warn');
    }
  } catch (_) {
    console.warn('[rates] _confirmDelete failed:', _);
    showMsg('Connection error.', 'warn');
  } finally {
    hideLoading();
  }
}
