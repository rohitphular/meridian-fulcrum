import { ExpenseAPI } from './api.js';

const TX_CACHE_KEY   = 'et_transaction_schema_v1';

export async function loadAccountSchema() {
  // Choices are configuration data; refresh them after every mutation and reload.
  const res = await ExpenseAPI.getAccountSchema();
  if (res.ok && res.data) {
    return res.data;
  }
  console.warn('[schema] account schema fetch failed:', res?.error);
  throw Object.assign(new Error('Schema fetch failed'), { code: res?.error ?? 'invalid_schema' });
}

export async function loadTransactionSchema() {
  const cached = localStorage.getItem(TX_CACHE_KEY);
  if (cached) {
    try {
      const schema = JSON.parse(cached);
      if (Array.isArray(schema?.record_statuses) && schema.record_statuses.length > 0) return schema;
    } catch (_) {}
  }
  const res = await ExpenseAPI.getTransactionSchema();
  if (res.ok && res.data) {
    // Older deployments omit lifecycle choices. Do not retain their schema
    // across reloads, so deploying the new backend resolves CSV validation.
    if (Array.isArray(res.data.record_statuses) && res.data.record_statuses.length > 0)
      localStorage.setItem(TX_CACHE_KEY, JSON.stringify(res.data));
    return res.data;
  }
  console.warn('[schema] transaction schema fetch failed:', res?.error);
  throw Object.assign(new Error('Schema fetch failed'), { code: res?.error ?? 'invalid_schema' });
}

export async function loadCategorySchema() {
  const res = await ExpenseAPI.getCategorySchema();
  if (res.ok && res.data) {
    return res.data;
  }
  console.warn('[schema] category schema fetch failed:', res?.error);
  throw Object.assign(new Error('Schema fetch failed'), { code: res?.error ?? 'invalid_schema' });
}

export async function loadSubscriptionSchema() {
  const res = await ExpenseAPI.getSubscriptionSchema();
  if (res?.ok === true && res.data) return res.data;
  throw Object.assign(new Error('Schema fetch failed'), { code: res?.error ?? 'invalid_schema' });
}

export async function loadAccountTypeSchema() {
  const res = await ExpenseAPI.getAccountTypeSchema();
  if (res?.ok === true && res.data) return res.data;
  throw Object.assign(new Error('Schema fetch failed'), { code: res?.error ?? 'invalid_schema' });
}
