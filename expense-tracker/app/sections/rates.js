import { state } from '../core/state.js';
import { el, esc, fmtDateTime } from '../core/utils.js';
import { showLoading, hideLoading } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// Read-only: forex-database-load publishes the rates (publish-sheet) and owns
// the tab. The server owns the list (list_rates_view): order, labels, rate
// dates and which accounts use each currency.
const LIST_VIEW = 'list_rates_view';
let _sort    = { col: 'sheet', dir: 'asc' };
let _viewSeq = 0;
let _viewError = '';

function _viewRows() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true ? response.data.rows : null;
}

async function _loadView() {
  const seq = ++_viewSeq;
  let response;
  // Every list request (open, sort) shows the loader, as on Transactions.
  showLoading();
  try { response = await ExpenseAPI.view(LIST_VIEW, { sort: _sort.col, dir: _sort.dir }); }
  catch (error) { console.error('[rates] list view failed:', error); response = null; }
  finally { hideLoading(); }
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

function _rateRowHtml(r) {
  return `<tr>
    <td class="td-mono"><strong>${esc(r.currency)}</strong></td>
    <td>${esc(r.symbol === '' ? '—' : r.symbol)}</td>
    <td class="td-mono">${esc(r.rate_label)}</td>
    <td class="td-mono">${r.rate_date ? esc(r.rate_date) : '—'}</td>
    <td class="td-muted td-mono">${r.updated_at ? esc(fmtDateTime(r.updated_at)) : '—'}</td>
  </tr>`;
}

function _listHtml() {
  const rows = _viewRows();
  if (rows === null) return _viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : '<p class="placeholder">Loading currencies…</p>';
  if (rows.length === 0) return '<p class="placeholder">No rates published yet. Run forex-database-load (publish-sheet).</p>';
  const cardRows = rows.map(r => `<div class="rate-card">
      <div class="rate-card-body">
        <div class="rate-card-code">${esc(r.currency)}${r.symbol ? ` <span class="rate-card-sym">${esc(r.symbol)}</span>` : ''}</div>
        <div class="rate-card-updated">${r.rate_date ? esc(r.rate_date) : '—'}</div>
      </div>
      <div class="rate-card-rate td-mono">${esc(r.rate_label)}</div>
      <span></span>
    </div>`).join('');
  const th = (col, label, width) => `<th${width ? ` style="width:${width}px"` : ''}${_sort.col === col ? ` class="sort-${_sort.dir}"` : ''} data-rate-sort="${col}">${label}</th>`;
  return `
    ${_viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : ''}
    <div class="table-wrap rate-table-wrap">
      <table>
        <thead><tr>
          ${th('currency', 'Currency', 100)}
          <th style="width:80px">Symbol</th>
          ${th('rate', 'Rate (per 1g XAU)', 140)}
          ${th('rate_date', 'Rate date', 110)}
          ${th('updated_at', 'Published')}
        </tr></thead>
        <tbody>
          ${rows.map(r => _rateRowHtml(r)).join('')}
        </tbody>
      </table>
    </div>
    <div class="rate-cards">${cardRows}</div>`;
}

function _render() {
  const content = el('ratesContent');
  content.innerHTML = `
    <p class="sec-sub" style="margin:0 0 16px">Units of currency per 1g XAU (the base). Published from the rates database; read-only.</p>
    <div id="rateListRegion">${_listHtml()}</div>`;
  const region = el('rateListRegion');
  if (region !== null && region !== undefined) _attachListEvents(region);
}

function _renderList() {
  const region = el('rateListRegion');
  if (region === null || region === undefined) { _render(); return; }
  region.innerHTML = _listHtml();
  _attachListEvents(region);
}

function _attachListEvents(region) {
  region.querySelectorAll?.('th[data-rate-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.rateSort;
      _sort = { col, dir: _sort.col === col && _sort.dir === 'asc' ? 'desc' : 'asc' };
      _renderList();
      _loadView();
    });
  });
}
