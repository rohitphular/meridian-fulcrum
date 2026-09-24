/* global SheetsClient */
import { state } from './core/state.js';
import { ExpenseAPI } from './core/api.js';
import { el, esc } from './core/utils.js';
import { showLoading, hideLoading, showMsg } from './core/ui.js';
import { showSection } from './core/nav.js';
import { renderTransactions } from './sections/transactions.js';
import { showPinGate, hidePinGate, fetchGeo, submitPin, readSession, clearSession } from './core/auth.js';
import { loadAccountSchema, loadTransactionSchema, loadCategorySchema, loadAccountTypeSchema, loadSubscriptionSchema } from './core/schema.js';

// ── Quote currency ────────────────────────────────────────────────────────────

function populateQuoteCurrencySelect() {
  const sel   = el('quoteCurrencySelect');
  const saved = localStorage.getItem('et_quote_currency') || 'GBP';
  sel.innerHTML = state.rates.map(r => {
    const rate = parseFloat(r.rate);
    const rateLabel = Number.isInteger(rate) ? rate.toFixed(2) : rate.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return `<option value="${esc(r.currency)}" ${r.currency === saved ? 'selected' : ''}>${esc(r.symbol ?? '')} ${esc(r.currency)} · ${rateLabel}</option>`;
  }).join('');
  state.quoteCurrency = sel.value || 'GBP';
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('et_theme', theme);
  const btn = el('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☽';
  if (!state.transactions.length) return;
  showSection(sessionStorage.getItem('et_section') || 'home');
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAll() {
  showLoading();
  try {
    const requests = [
      ['transactions', () => ExpenseAPI.listTransactions()],
      ['categories', () => ExpenseAPI.listCategories()],
      ['accounts', () => ExpenseAPI.listAccounts()],
      ['rates', () => ExpenseAPI.listRates()],
      ['account schema', loadAccountSchema],
      ['transaction schema', loadTransactionSchema],
      ['category schema', loadCategorySchema],
      ['subscriptions', () => ExpenseAPI.listSubscriptions()],
      ['account types', () => ExpenseAPI.listAccountTypes()],
      ['account type schema', loadAccountTypeSchema],
      ['subscription schema', loadSubscriptionSchema],
    ];
    const responses = await Promise.allSettled(requests.map(([, request]) => Promise.resolve().then(request)));
    const failures = [];
    responses.forEach((response, index) => {
      const entity = requests[index][0];
      if (response.status === 'rejected') {
        failures.push({ entity, code: response.reason?.code ?? 'connection_error' });
      } else if (index >= 4 && index <= 6) {
        if (response.value === null || !Array.isArray(response.value?.types)) failures.push({ entity, code: 'invalid_schema' });
      } else if (entity === 'account type schema') {
        if (!['fields', 'types', 'record_statuses', 'columns'].every(key => Array.isArray(response.value?.[key]))) failures.push({ entity, code: 'invalid_schema' });
      } else if (entity === 'subscription schema') {
        if (!['frequencies', 'tx_types', 'record_statuses'].every(key => Array.isArray(response.value?.[key]) && response.value[key].length > 0)
          || typeof response.value?.default_timezone !== 'string' || response.value.default_timezone === '') {
          failures.push({ entity, code: 'invalid_schema' });
        }
      } else if (response.value?.ok !== true || !Array.isArray(response.value.data)) {
        failures.push({ entity, code: response.value?.error ?? 'invalid_response' });
      }
    });
    if (failures.length > 0) {
      if (failures.some(failure => failure.code === 'auth' || failure.code === 'locked')) {
        clearSession();
        showPinGate();
      }
      const details = failures.map(failure => `${failure.entity}: ${failure.code}`).join('; ');
      const hint = failures.some(failure => failure.code === 'sheet_header_mismatch')
        ? ' Check the affected sheet headers against the current schema before retrying.'
        : ' Retry after resolving the error.';
      showMsg('Refresh failed — ' + details + '.' + hint + ' The last complete view is unchanged.', 'warn');
      return;
    }

    const [txRes, catRes, accRes, ratesRes, schemaRes, txSchemaRes, catSchemaRes, subRes, accountTypesRes, accountTypeSchemaRes, subSchemaRes] = responses.map(response => response.value);
    const toBool = value => value === true || String(value).toLowerCase() === 'true';
    const snapshot = {
      transactions: txRes.data,
      categories: catRes.data.map(category => ({
        ...category,
        source_account_mandatory: toBool(category.source_account_mandatory),
        target_account_mandatory: toBool(category.target_account_mandatory),
        is_subscription_eligible: toBool(category.is_subscription_eligible),
      })),
      accounts: accRes.data,
      accountMap: Object.fromEntries(accRes.data.map(account => [account.id, account])),
      rates: ratesRes.data,
      rateMap: Object.fromEntries(ratesRes.data.map(rate => [rate.currency, Number(rate.rate)])),
      accountSchema: schemaRes,
      transactionSchema: txSchemaRes,
      categorySchema: catSchemaRes,
      subscriptions: subRes.data,
      subscriptionSchema: subSchemaRes,
      accountTypes: accountTypesRes.data,
      accountTypeSchema: accountTypeSchemaRes,
    };
    // Commit only after every dependency and derived collection is ready.
    Object.assign(state, snapshot);

    populateQuoteCurrencySelect();
    showSection(sessionStorage.getItem('et_section') || 'home');

  } catch (_) {
    console.error('[main] loadAll failed:', _);
    showMsg('Connection error — check your internet and reload.', 'warn');
  } finally {
    hideLoading();
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
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

  // Config check
  if (window.__configMissing) {
    hidePinGate();
    el('setupBanner').classList.remove('hidden');
    return;
  }

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
