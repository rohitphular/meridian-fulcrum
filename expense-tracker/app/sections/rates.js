import { state } from '../core/state.js';
import { el, esc, fmtDateTime, openContextMenu, closeContextMenu } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

let _rateMenuKey = null;

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderRates() {
  closeContextMenu(); _rateMenuKey = null;
  const content = el('ratesContent');

  const hasActiveRate = !!state.rateDeleteCurrency;

  const cardRows = state.rates.map(r => {
    const base = r.currency === 'GBP';
    if (state.rateDeleteCurrency === r.currency) return '';
    return `<div class="rate-card">
      <div class="rate-card-body">
        <div class="rate-card-code">${esc(r.currency)}${r.symbol ? ` <span class="rate-card-sym">${esc(r.symbol)}</span>` : ''}</div>
        <div class="rate-card-updated">${r.updated_at ? esc(fmtDateTime(r.updated_at)) : '—'}</div>
      </div>
      <div class="rate-card-rate td-mono">${parseFloat(r.rate).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
      ${base ? '<span></span>' : `<button class="tx-menu-trigger" data-action="rate-menu" data-currency="${esc(r.currency)}">⋮</button>`}
    </div>`;
  }).join('');

  const addOrEditOpen = state.rateAddOpen || !!state.rateEditCurrency;

  content.innerHTML = `
    <div class="sec-head">
      <button class="btn btn-primary btn-sm" id="rateAddBtn" style="margin-left:auto">${addOrEditOpen ? '× Close' : '+ Add'}</button>
    </div>
    <p class="sec-sub" style="margin:-8px 0 16px">Units of currency per 1 GBP. GBP is the base (read-only).</p>
    ${state.rateAddOpen    ? _renderAddForm()                                          : ''}
    ${state.rateEditCurrency ? _renderEditForm(state.rates.find(r => r.currency === state.rateEditCurrency)) : ''}
    <div class="table-wrap rate-table-wrap${hasActiveRate ? ' rate-has-active' : ''}">
      <table>
        <thead><tr>
          <th style="width:100px">Currency</th>
          <th style="width:80px">Symbol</th>
          <th style="width:140px">Rate (per £1)</th>
          <th>Updated</th>
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>
          ${state.rates.map(r => _rateRowHtml(r)).join('')}
        </tbody>
      </table>
    </div>
    <div class="rate-cards">${cardRows}</div>`;

  _attachRateEvents();
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
        <label for="rateNewRate">Rate per £1 *</label>
        <input type="number" id="rateNewRate" placeholder="e.g. 195.5" min="0.0001" step="any">
        <div class="field-hint">Units of this currency per 1 GBP.</div>
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
        <input type="text" id="rateEditSymbol" value="${esc(r.symbol || '')}" maxlength="8" placeholder="e.g. ¥">
        <div class="field-hint">Display prefix (optional).</div>
      </div>
      <div class="field">
        <label for="rateEditRate">Rate per £1 *</label>
        <input type="number" id="rateEditRate" value="${parseFloat(r.rate)}" min="0.0001" step="any">
        <div class="field-hint">Units of this currency per 1 GBP.</div>
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

function _rateRowHtml(r) {
  const base = r.currency === 'GBP';

  if (state.rateDeleteCurrency === r.currency) {
    // Blocked state — backend refused because accounts or transactions still
    // use this currency. Currency on an account is immutable, so the recovery
    // path is to delete those accounts/transactions first.
    if (state.rateDeleteBlocked) {
      const blocked = state.rateDeleteBlocked;
      const n       = blocked.referenced_count || 0;
      let body, hint;
      if (blocked.error === 'currency_in_use_by_accounts') {
        const names = state.accounts
          .filter(a => a.currency === r.currency)
          .map(a => `<strong>${esc(a.name)}</strong>`);
        const namesStr = names.length ? names.join(', ') : `${n} account${n === 1 ? '' : 's'}`;
        body = `Cannot delete <strong>${esc(r.currency)}</strong> — used by: ${namesStr}.`;
        hint = 'Delete those accounts first (an account\'s currency cannot be changed).';
      } else {
        const noun = n === 1 ? 'transaction is' : 'transactions are';
        body = `Cannot delete <strong>${esc(r.currency)}</strong> — <strong>${n}</strong> ${noun} recorded in this currency.`;
        hint = 'Delete or reassign those transactions first.';
      }
      return `<tr>
        <td class="td-mono"><strong>${esc(r.currency)}</strong></td>
        <td colspan="3">
          <span class="confirm-text">${body}</span>
          <div style="color:var(--muted);font-size:var(--text-sm);margin-top:4px">${hint}</div>
        </td>
        <td><div class="row-actions">
          <button class="btn-link muted" data-action="rate-cancel-delete">Cancel</button>
        </div></td>
      </tr>`;
    }
    return `<tr>
      <td class="td-mono"><strong>${esc(r.currency)}</strong></td>
      <td colspan="2"><span class="confirm-text">Delete <strong>${esc(r.currency)}</strong>?</span></td>
      <td></td>
      <td><div class="row-actions">
        <button class="btn-link danger" data-action="rate-confirm-delete" data-currency="${esc(r.currency)}">Yes, delete</button>
        <button class="btn-link muted"  data-action="rate-cancel-delete">Cancel</button>
      </div></td>
    </tr>`;
  }

  return `<tr>
    <td class="td-mono"><strong>${esc(r.currency)}</strong></td>
    <td>${esc(r.symbol || '—')}</td>
    <td class="td-mono">${parseFloat(r.rate).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
    <td class="td-muted td-mono">${r.updated_at ? esc(fmtDateTime(r.updated_at)) : '—'}</td>
    <td>${base ? '' : `<button class="tx-menu-trigger" data-action="rate-menu" data-currency="${esc(r.currency)}">⋮</button>`}</td>
  </tr>`;
}

// ── Events ────────────────────────────────────────────────────────────────────

function _attachRateEvents() {
  el('rateAddBtn')?.addEventListener('click', () => {
    if (state.rateAddOpen || state.rateEditCurrency) {
      state.rateAddOpen      = false;
      state.rateEditCurrency = null;
    } else {
      state.rateAddOpen = true;
    }
    renderRates();
  });

  // Add form
  el('rateSaveNew')?.addEventListener('click', _saveNewRate);
  el('rateCancelNew')?.addEventListener('click', () => { state.rateAddOpen = false; renderRates(); });
  el('rateNewRate')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  el('rateSaveNew')?.click();
    if (e.key === 'Escape') el('rateCancelNew')?.click();
  });

  // Edit form
  el('rateSaveEdit')?.addEventListener('click', () => _saveEdit(state.rateEditCurrency));
  el('rateCancelEdit')?.addEventListener('click', () => { state.rateEditCurrency = null; renderRates(); });
  el('rateEditRate')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  _saveEdit(state.rateEditCurrency);
    if (e.key === 'Escape') { state.rateEditCurrency = null; renderRates(); }
  });

  const handleRateAction = async e => {
    const btn      = e.target.closest('[data-action]');
    if (!btn) return;
    const action   = btn.dataset.action;
    const currency = btn.dataset.currency;

    if (action === 'rate-menu') {
      if (_rateMenuKey === currency) { closeContextMenu(); _rateMenuKey = null; return; }
      _rateMenuKey = currency;
      openContextMenu(btn, [
        { key: 'rate-edit',   label: 'Edit',   cls: '' },
        { key: 'rate-delete', label: 'Delete', cls: 'danger' },
      ], key => {
        _rateMenuKey = null;
        if (key === 'rate-edit') {
          state.rateEditCurrency = currency; state.rateAddOpen = false;
          state.rateDeleteCurrency = null; state.rateDeleteBlocked = null;
          renderRates(); el('rateEditRate')?.focus();
        }
        if (key === 'rate-delete') {
          state.rateDeleteCurrency = currency; state.rateDeleteBlocked = null;
          state.rateEditCurrency = null; renderRates();
        }
      });
      return;
    }
    if (action === 'rate-edit') {
      state.rateEditCurrency   = currency;
      state.rateAddOpen        = false;
      state.rateDeleteCurrency = null;
      state.rateDeleteBlocked  = null;
      renderRates();
      el('rateEditRate')?.focus();
    }
    if (action === 'rate-delete') {
      state.rateDeleteCurrency = currency;
      state.rateDeleteBlocked  = null;
      state.rateEditCurrency   = null;
      renderRates();
    }
    if (action === 'rate-cancel-delete') {
      state.rateDeleteCurrency = null;
      state.rateDeleteBlocked  = null;
      renderRates();
    }
    if (action === 'rate-confirm-delete') await _confirmDelete(currency);
  };

  const tableWrap = el('ratesContent')?.querySelector('.rate-table-wrap');
  const cardsWrap = el('ratesContent')?.querySelector('.rate-cards');
  tableWrap?.addEventListener('click', handleRateAction);
  cardsWrap?.addEventListener('click', handleRateAction);
}

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNewRate() {
  const currency = (el('rateNewCurrency')?.value || '').trim().toUpperCase();
  const symbol   = (el('rateNewSymbol')?.value   || '').trim();
  const rate     = parseFloat(el('rateNewRate')?.value || '');
  const errEl    = el('rateAddError');

  if (!currency) { errEl.textContent = 'Currency code is required.'; return; }
  if (state.rates.find(r => r.currency === currency)) {
    errEl.textContent = `${currency} already exists — use Edit to update it.`; return;
  }
  if (!rate || rate <= 0) { errEl.textContent = 'Rate must be a positive number.'; return; }

  const saveBtn = el('rateSaveNew');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  showLoading();
  try {
    const res = await ExpenseAPI.upsertRate({ currency, symbol, rate });
    if (res.ok) {
      state.rateAddOpen = false;
      showMsg('Currency added.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[rates] _saveNewRate failed:', res?.error);
      errEl.textContent = 'Failed: ' + (res.error || 'unknown');
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
  const rateVal   = parseFloat(el('rateEditRate')?.value || '');
  const symbolVal = (el('rateEditSymbol')?.value || '').trim();
  const errEl     = el('rateEditError');

  if (!rateVal || rateVal <= 0) {
    if (errEl) errEl.textContent = 'Rate must be a positive number.';
    return;
  }

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
      if (errEl) errEl.textContent = 'Failed: ' + (res.error || 'unknown');
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
        referenced_count: res.referenced_count || 0,
      };
      renderRates();
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
