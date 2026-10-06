/* global SheetsClient */
import { state } from './core/state.js';
import { ExpenseAPI } from './core/api.js';
import { el, esc } from './core/utils.js';
import { showLoading, hideLoading, showMsg } from './core/ui.js';
import { showSection } from './core/nav.js';
import { renderTransactions } from './sections/transactions.js';
import { showPinGate, hidePinGate, fetchGeo, submitPin, readSession, clearSession } from './core/auth.js';

// ── Quote currency ────────────────────────────────────────────────────────────

function populateQuoteCurrencySelect() {
  const sel   = el('quoteCurrencySelect');
  const saved = localStorage.getItem('et_quote_currency') || 'GBP';
  const currencies = state.context?.quote_currencies ?? [];
  sel.innerHTML = currencies.map(q =>
    `<option value="${esc(q.currency)}" ${q.currency === saved ? 'selected' : ''}>${esc(q.symbol)} ${esc(q.currency)} · ${esc(q.rate_label)}</option>`
  ).join('');
  state.quoteCurrency = sel.value || 'GBP';
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('et_theme', theme);
  const btn = el('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☽';
  if (state.context === null || state.context === undefined) return;
  showSection(sessionStorage.getItem('et_section') || 'home');
}

// ── Data loading ──────────────────────────────────────────────────────────────

let _refreshVersion = 0;

// get_app_context carries every schema. Each schema is still checked
// separately so a refresh failure names the schema that is wrong.
function _contextFailures(entity, response) {
  if (response?.ok !== true || response.data === null || typeof response.data !== 'object') {
    return [{ entity, code: response?.error ?? 'invalid_response' }];
  }
  const schemas = response.data.schemas ?? {};
  const arrays = (value, keys) => keys.every(key => Array.isArray(value?.[key]));
  const failures = [];
  if (!Array.isArray(response.data.quote_currencies)) failures.push({ entity, code: 'invalid_response' });
  for (const [name, key] of [['account schema', 'account'], ['transaction schema', 'transaction'], ['category schema', 'category']]) {
    if (!arrays(schemas[key], ['types'])) failures.push({ entity: name, code: 'invalid_schema' });
  }
  if (!arrays(schemas.account_type, ['fields', 'types', 'record_statuses', 'columns'])) failures.push({ entity: 'account type schema', code: 'invalid_schema' });
  const subscription = schemas.subscription;
  if (!['frequencies', 'tx_types', 'record_statuses'].every(key => Array.isArray(subscription?.[key]) && subscription[key].length > 0)
    || typeof subscription?.default_timezone !== 'string' || subscription.default_timezone === '') {
    failures.push({ entity: 'subscription schema', code: 'invalid_schema' });
  }
  return failures;
}

function _reopenPinGate() {
  clearSession();
  showPinGate();
}

// A refresh loads get_app_context only; the active section then requests its
// own view (showSection → render<Section> → ExpenseAPI.view). No raw lists are
// held in the browser. A new state.context object also tells sections that
// the data changed (transactions.js drops its cached facets / form options).
async function loadAll() {
  const refreshVersion = ++_refreshVersion;
  showLoading();
  try {
    let response = null;
    let failures;
    try {
      response = await ExpenseAPI.getAppContext();
      failures = _contextFailures('app context', response);
    } catch (error) {
      failures = [{ entity: 'app context', code: error?.code ?? 'connection_error' }];
    }
    // An earlier read may finish after a post-save refresh. Only the newest
    // requested snapshot may replace state or reopen the authentication gate.
    if (refreshVersion !== _refreshVersion) return;
    if (failures.length > 0) {
      if (failures.some(failure => failure.code === 'auth' || failure.code === 'locked')) _reopenPinGate();
      const details = failures.map(failure => `${failure.entity}: ${failure.code}`).join('; ');
      const hint = failures.some(failure => failure.code === 'sheet_header_mismatch')
        ? ' Check the affected sheet headers against the current schema before retrying.'
        : ' Retry after resolving the error.';
      showMsg('Refresh failed — ' + details + '.' + hint + ' The last complete view is unchanged.', 'warn');
      return;
    }

    const context = response.data;
    const schemas = context.schemas;
    // Sections read these schemas (import panels, record statuses, Configure fields).
    Object.assign(state, {
      context,
      categorySchema: schemas.category,
      subscriptionSchema: schemas.subscription,
      accountTypeSchema: schemas.account_type,
    });

    populateQuoteCurrencySelect();
    showSection(sessionStorage.getItem('et_section') || 'home');

  } catch (_) {
    if (refreshVersion !== _refreshVersion) return;
    console.error('[main] loadAll failed:', _);
    showMsg('Connection error — check your internet and reload.', 'warn');
  } finally {
    hideLoading();
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────

// Browser caches retired by the dumb-UI refactor: schemas, metadata and the
// old suggestion format now come from the server on every refresh.
const _RETIRED_STORAGE_KEYS = ['et_transaction_schema_v1', 'et_metadata_v1', 'et_suggestions_v2'];

async function init() {
  _RETIRED_STORAGE_KEYS.forEach(key => { try { localStorage.removeItem(key); } catch (_) {} });

  // Theme
  const savedTheme  = localStorage.getItem('et_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(savedTheme || (prefersDark ? 'dark' : 'light'));

  el('themeToggle')?.addEventListener('click', () => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // Tab nav
  el('tabNav')?.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (btn) showSection(btn.dataset.section);
  });

  // Quote currency change
  el('quoteCurrencySelect')?.addEventListener('change', e => {
    state.quoteCurrency = e.target.value;
    localStorage.setItem('et_quote_currency', state.quoteCurrency);
    showSection(sessionStorage.getItem('et_section') || 'home');
  });

  // Reload events — fired by mutations instead of calling loadAll directly
  document.addEventListener('et:reload', loadAll);
  // Any view GET answered auth / locked reopens the PIN gate.
  ExpenseAPI.onAuthError(_reopenPinGate);
  el('refreshBtn')?.addEventListener('click', loadAll);

  // Config check
  if (window.__configMissing || !window.CONFIG?.SCRIPT_URL) {
    hidePinGate();
    el('setupBanner').classList.remove('hidden');
    return;
  }

  // Views use the saved quote currency from the first request.
  state.quoteCurrency = localStorage.getItem('et_quote_currency') || 'GBP';

  // PIN gate
  const session = readSession();
  if (session) {
    const meta = await fetchGeo();
    SheetsClient.init({ scriptUrl: window.CONFIG.SCRIPT_URL, pin: session.pin, meta });
    hidePinGate();

    await loadAll();
  } else {
    showPinGate();
  }

  // PIN form
  el('pinSubmit')?.addEventListener('click', submitPin);
  el('totpInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitPin(); });
  el('pinInput')?.addEventListener('keydown',  e => { if (e.key === 'Enter') el('totpInput').focus(); });
}

document.addEventListener('DOMContentLoaded', init);
