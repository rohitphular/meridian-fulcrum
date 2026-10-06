/* global SheetsClient */
import { state } from './state.js';

// A Sheet row number can move after an import. Every mutation carries the
// identity of the row in hand (id + updated_at from the view payload) so the
// server's stale_record check rejects an edit that would land on another row.
// No collection lookup: a caller without the row's id is refused locally.
// id / updated_at travel as expected_id / expected_updated_at; only account
// types also accept the id in the body (their core re-checks it).
function _mutateRow(action, fields, { forwardId = false } = {}) {
  const { id, updated_at: updatedAt, expected_updated_at: expectedUpdatedAt, ...body } = fields ?? {};
  if (typeof id !== 'string' || id.trim() === '') return Promise.resolve({ ok: false, error: 'stale_record' });
  const request = { action, ...body, expected_id: id.trim() };
  if (forwardId) request.id = id.trim();
  const version = expectedUpdatedAt ?? updatedAt;
  if (version !== undefined && version !== null && version !== '') request.expected_updated_at = version;
  return SheetsClient.post(request);
}

// Browser IANA zone for server-side "today" and calendar bucketing.
function _browserTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'Europe/London';
  } catch (_) { return 'Europe/London'; }
}

// SheetsClient appends pin + geo meta (ip, city, country, ua) to every GET and
// the server strips these names, so a view param with one of them would be
// silently replaced. Use e.g. user_location_country / user_location_city instead.
const _RESERVED_VIEW_PARAMS = ['action', 'pin', 'totp', 'ip', 'city', 'country', 'ua', '_'];

// Query-string values: arrays → csv, objects → JSON, blanks dropped.
function _viewParams(params) {
  const out = {};
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (_RESERVED_VIEW_PARAMS.includes(key)) throw new Error('reserved_view_param:' + key);
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) { if (value.length > 0) out[key] = value.join(','); return; }
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  return out;
}

// An auth / locked answer to any GET (a PIN rotated or the app locked while a
// screen was open) reopens the PIN gate through the handler main.js registers.
// get_app_context is exempt: loadAll decides itself, so only the newest refresh
// may reopen the gate.
const _AUTH_ERRORS = ['auth', 'locked'];
let _authErrorHandler = null;

async function _get(params, { authHook = true } = {}) {
  const response = await SheetsClient.get(params);
  if (authHook && _authErrorHandler !== null && _AUTH_ERRORS.includes(response?.error)) _authErrorHandler(response.error);
  return response;
}

// View GETs return ready-to-render payloads. quote_currency and tz are
// attached automatically; explicit params win (e.g. a test "today").
function _viewRequest(action, params) {
  return { quote_currency: state.quoteCurrency, tz: _browserTimezone(), ..._viewParams(params), action };
}

function _view(action, params) {
  return _get(_viewRequest(action, params));
}

// Reads are view GETs (ExpenseAPI.view) except verify, the advisor history and
// the suggestion list; every write is a POST. There are no raw list reads.
export const ExpenseAPI = {
  onAuthError:             fn => { _authErrorHandler = typeof fn === 'function' ? fn : null; },
  view:                    (action, params) => _view(action, params),
  getAppContext:           () => _get(_viewRequest('get_app_context'), { authHook: false }),
  verify:            totp => SheetsClient.get({ action: 'verify', totp }),
  updateAccountType:       f => _mutateRow('update_account_type', f, { forwardId: true }),
  deleteAccountType:       f => _mutateRow('delete_account_type', f, { forwardId: true }),
  restoreAccountType:      f => _mutateRow('restore_account_type', f, { forwardId: true }),
  createAccountTypesBulk:  f => SheetsClient.post({ action: 'create_account_types_bulk', ...f }),
  createTransaction:  f   => SheetsClient.post({ action: 'create_transaction',  ...f }),
  updateTransaction:  f   => _mutateRow('update_transaction', f),
  deleteTransaction:   f   => _mutateRow('delete_transaction', f),
  restoreTransaction:  f   => _mutateRow('restore_transaction', f),
  createCategory:    f    => SheetsClient.post({ action: 'create_category', ...f }),
  createCategoriesBulk: f => SheetsClient.post({ action: 'create_categories_bulk', ...f }),
  updateCategory:    f    => _mutateRow('update_category', f),
  deleteCategory:    f    => _mutateRow('delete_category', f),
  createAccount:     f    => SheetsClient.post({ action: 'create_account', ...f }),
  importAccountData:       f => SheetsClient.post({ action: 'import_account_data',        ...f }),
  createTransactionsBulk: f => SheetsClient.post({ action: 'create_transactions_bulk', ...f }),
  updateAccount:     f    => _mutateRow('update_account', f),
  deleteAccount:     f    => _mutateRow('delete_account', f),
  restoreAccount:    f    => _mutateRow('restore_account', f),
  advisorChat:         f  => SheetsClient.post({ action: 'advisor_chat', ...f }),
  getAdvisorHistory:   () => _get({ action: 'get_advisor_history' }),
  clearAdvisorHistory: () => SheetsClient.post({ action: 'clear_advisor_history' }),
  createSubscription:         f  => SheetsClient.post({ action: 'create_subscription',       ...f }),
  createSubscriptionsBulk:    f  => SheetsClient.post({ action: 'create_subscriptions_bulk', ...f }),
  updateSubscription:         f  => _mutateRow('update_subscription', f),
  deleteSubscription:         f  => _mutateRow('delete_subscription', f),
  restoreSubscription:        f  => _mutateRow('restore_subscription', f),
  getSuggestedTransactions:   () => _get({ action: 'get_suggested_transactions' }),
};
