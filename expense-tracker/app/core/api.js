/* global SheetsClient */
import { state } from './state.js';

// A Sheet row number can move after an import. Include the identity from the
// displayed snapshot so the server rejects a stale edit instead of another row.
function _mutateRow(action, rows, fields) {
  const original = rows.find(row => (row._row ?? row.row_num) === Number(fields.row_num));
  if (original === undefined || typeof original.id !== 'string' || original.id === '') {
    return Promise.resolve({ ok: false, error: 'stale_record' });
  }
  if (fields.id !== undefined && String(fields.id).toLowerCase() !== original.id.toLowerCase()) {
    return Promise.resolve({ ok: false, error: 'stale_record' });
  }
  const expected = { expected_id: original.id };
  const updatedAt = fields.expected_updated_at ?? original.updated_at;
  if (updatedAt !== undefined && updatedAt !== null && updatedAt !== '') {
    expected.expected_updated_at = updatedAt;
  }
  return SheetsClient.post({ action, ...fields, ...expected });
}

export const ExpenseAPI = {
  listAccountTypes:        () => SheetsClient.get({ action: 'list_account_types' }),
  getAccountTypeSchema:    () => SheetsClient.get({ action: 'get_account_type_schema' }),
  updateAccountType:       f => _mutateRow('update_account_type', state.accountTypes, f),
  deleteAccountType:       f => _mutateRow('delete_account_type', state.accountTypes, f),
  restoreAccountType:      f => _mutateRow('restore_account_type', state.accountTypes, f),
  createAccountTypesBulk:  f => SheetsClient.post({ action: 'create_account_types_bulk', ...f }),
  verify:            totp => SheetsClient.get({ action: 'verify', totp }),
  listTransactions:  ()   => SheetsClient.get({ action: 'list_transactions' }),
  listCategories:    ()   => SheetsClient.get({ action: 'list_categories' }),
  listAccounts:       ()   => SheetsClient.get({ action: 'list_accounts' }),
  listRates:          ()   => SheetsClient.get({ action: 'list_rates' }),
  getAccountSchema:      ()   => SheetsClient.get({ action: 'get_account_schema' }),
  getTransactionSchema:  ()   => SheetsClient.get({ action: 'get_transaction_schema' }),
  getCategorySchema:     ()   => SheetsClient.get({ action: 'get_category_schema' }),
  createTransaction:  f   => SheetsClient.post({ action: 'create_transaction',  ...f }),
  updateTransaction:  f   => _mutateRow('update_transaction', state.transactions, f),
  deleteTransaction:   f   => _mutateRow('delete_transaction', state.transactions, f),
  restoreTransaction:  f   => _mutateRow('restore_transaction', state.transactions, f),
  upsertRate:        f    => SheetsClient.post({ action: 'upsert_rate',  ...f }),
  deleteRate:        f    => SheetsClient.post({ action: 'delete_rate',  ...f }),
  createCategory:    f    => SheetsClient.post({ action: 'create_category', ...f }),
  createCategoriesBulk: f => SheetsClient.post({ action: 'create_categories_bulk', ...f }),
  updateCategory:    f    => _mutateRow('update_category', state.categories, f),
  deleteCategory:    f    => _mutateRow('delete_category', state.categories, f),
  createAccount:     f    => SheetsClient.post({ action: 'create_account', ...f }),
  createAccountsBulk:      f => SheetsClient.post({ action: 'create_accounts_bulk',      ...f }),
  importAccountData:       f => SheetsClient.post({ action: 'import_account_data',        ...f }),
  createTransactionsBulk: f => SheetsClient.post({ action: 'create_transactions_bulk', ...f }),
  updateAccount:     f    => _mutateRow('update_account', state.accounts, f),
  deleteAccount:     f    => _mutateRow('delete_account', state.accounts, f),
  restoreAccount:    f    => _mutateRow('restore_account', state.accounts, f),
  advisorChat:         f  => SheetsClient.post({ action: 'advisor_chat', ...f }),
  getAdvisorHistory:   () => SheetsClient.get({ action: 'get_advisor_history' }),
  clearAdvisorHistory: () => SheetsClient.post({ action: 'clear_advisor_history' }),
  listSubscriptions:          () => SheetsClient.get({ action: 'list_subscriptions' }),
  getSubscriptionSchema:      () => SheetsClient.get({ action: 'get_subscription_schema' }),
  createSubscription:         f  => SheetsClient.post({ action: 'create_subscription',       ...f }),
  createSubscriptionsBulk:    f  => SheetsClient.post({ action: 'create_subscriptions_bulk', ...f }),
  updateSubscription:         f  => _mutateRow('update_subscription', state.subscriptions, f),
  deleteSubscription:         f  => _mutateRow('delete_subscription', state.subscriptions, f),
  restoreSubscription:        f  => _mutateRow('restore_subscription', state.subscriptions, f),
  getSuggestedTransactions:   () => SheetsClient.get({ action: 'get_suggested_transactions' }),
  getTransactionMetadata:     () => SheetsClient.get({ action: 'get_transaction_metadata' }),
  getComputedInsights:        p  => SheetsClient.get({ action: 'get_computed_insights', ...p }),
};
