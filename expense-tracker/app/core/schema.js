import { ExpenseAPI } from './api.js';

const ACCT_CACHE_KEY = 'et_account_schema_v2';
const TX_CACHE_KEY   = 'et_transaction_schema_v1';
const CAT_CACHE_KEY  = 'et_category_schema_v1';

export async function loadAccountSchema() {
  const cached = localStorage.getItem(ACCT_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  const res = await ExpenseAPI.getAccountSchema();
  if (res.ok && res.data) {
    localStorage.setItem(ACCT_CACHE_KEY, JSON.stringify(res.data));
    return res.data;
  }
  console.warn('[schema] account schema fetch failed:', res?.error);
  return null;
}

export async function loadTransactionSchema() {
  const cached = localStorage.getItem(TX_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  const res = await ExpenseAPI.getTransactionSchema();
  if (res.ok && res.data) {
    localStorage.setItem(TX_CACHE_KEY, JSON.stringify(res.data));
    return res.data;
  }
  console.warn('[schema] transaction schema fetch failed:', res?.error);
  return null;
}

export async function loadCategorySchema() {
  const cached = localStorage.getItem(CAT_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  const res = await ExpenseAPI.getCategorySchema();
  if (res.ok && res.data) {
    localStorage.setItem(CAT_CACHE_KEY, JSON.stringify(res.data));
    return res.data;
  }
  console.warn('[schema] category schema fetch failed:', res?.error);
  return null;
}
