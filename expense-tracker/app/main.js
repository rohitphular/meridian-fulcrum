/* global SheetsClient */
import { state } from './core/state.js';
import { ExpenseAPI } from './core/api.js';
import { el, esc } from './core/utils.js';
import { showLoading, hideLoading, showMsg } from './core/ui.js';
import { showSection } from './core/nav.js';
import { renderTransactions } from './sections/transactions.js';
import { showPinGate, hidePinGate, fetchGeo, submitPin, readSession, clearSession } from './core/auth.js';
import { loadAccountSchema, loadTransactionSchema, loadCategorySchema } from './core/schema.js';

// ── Quote currency ────────────────────────────────────────────────────────────

function populateQuoteCurrencySelect() {
  const sel   = el('quoteCurrencySelect');
  const saved = localStorage.getItem('et_quote_currency') || 'GBP';
  sel.innerHTML = state.rates.map(r => {
    const rate = parseFloat(r.rate);
    const rateLabel = Number.isInteger(rate) ? rate.toFixed(2) : rate.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return `<option value="${esc(r.currency)}" ${r.currency === saved ? 'selected' : ''}>${esc(r.symbol || '')} ${esc(r.currency)} · ${rateLabel}</option>`;
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
    const [txRes, catRes, accRes, ratesRes, schemaRes, txSchemaRes, catSchemaRes, subRes] = await Promise.all([
      ExpenseAPI.listTransactions(),
      ExpenseAPI.listCategories(),
      ExpenseAPI.listAccounts(),
      ExpenseAPI.listRates(),
      loadAccountSchema(),
      loadTransactionSchema(),
      loadCategorySchema(),
      ExpenseAPI.listSubscriptions(),
    ]);

    if (!txRes.ok) {
      if (txRes.error === 'auth' || txRes.error === 'locked') {
        clearSession(); showPinGate(); return;
      }
      showMsg('Failed to load transactions: ' + (txRes.error || 'unknown'), 'warn');
    } else {
      state.transactions = txRes.data || [];
      sessionStorage.setItem('et_transactions_cache', JSON.stringify(state.transactions));
    }

    if (catRes.ok) {
      state.categories = catRes.data || [];
      state.categories.forEach(c => {
        const toBool = v => v === true || String(v).toLowerCase() === 'true';
        c.is_active                  = toBool(c.is_active);
        c.source_account_mandatory   = toBool(c.source_account_mandatory);
        c.target_account_mandatory   = toBool(c.target_account_mandatory);
        c.is_subscription_eligible   = toBool(c.is_subscription_eligible);
      });
    }
    if (accRes.ok) {
      state.accounts   = accRes.data || [];
      state.accounts.forEach(a => { a.is_active = a.is_active === true || String(a.is_active).toLowerCase() === 'true'; });
      state.accountMap = Object.fromEntries(state.accounts.map(a => [a.id, a]));
    }
    if (ratesRes.ok) {
      state.rates   = ratesRes.data || [];
      state.rateMap = {};
      state.rates.forEach(r => { state.rateMap[r.currency] = Number(r.rate) || 1; });
    }
    if (schemaRes)    state.accountSchema    = schemaRes;
    if (txSchemaRes)  state.transactionSchema = txSchemaRes;
    if (catSchemaRes) state.categorySchema   = catSchemaRes;

    if (subRes?.ok) {
      state.subscriptions = (subRes.data || []).map(s => ({
        ...s,
        is_active: s.is_active === true || String(s.is_active).toLowerCase() === 'true',
      }));
    } else {
      state.subscriptions = [];
    }

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

  // Date range buttons
  el('dateRangeBar')?.querySelectorAll('.range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === state.dateRange);
    btn.addEventListener('click', () => {
      state.dateRange = btn.dataset.range;
      el('customDates').classList.toggle('hidden', state.dateRange !== 'custom');
      el('dateRangeBar').querySelectorAll('.range-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.range === state.dateRange)
      );
      if (state.transactions.length) renderTransactions();
    });
  });

  el('customFrom')?.addEventListener('change', e => { state.customFrom = e.target.value; if (state.transactions.length) renderTransactions(); });
  el('customTo')?.addEventListener('change',   e => { state.customTo   = e.target.value; if (state.transactions.length) renderTransactions(); });

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

    const cached = sessionStorage.getItem('et_transactions_cache');
    if (cached) { try { state.transactions = JSON.parse(cached); } catch (_) {} }

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
