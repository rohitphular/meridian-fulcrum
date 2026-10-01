// =============================================================================
// FULCRUM FORGE — View context: request params, envelopes, per-request dataset
//
// Every view GET (get-registry.gs) gets a context built from e.parameter:
//   quote_currency (default GBP), tz (IANA, default Europe/London),
//   today (optional YYYY-MM-DD override; default = zoned today in tz),
//   data_version (read before any sheet), plus the remaining screen params.
// vmLoad(name) reads each sheet at most once per request and reuses the
// result; the memo is reset at the start of every doGet / doPost.
// Globals in this file use the vm / _vm prefix.
// =============================================================================

const VM_DEFAULT_QUOTE_CURRENCY = 'GBP';
const VM_DEFAULT_TIMEZONE = 'Europe/London';
// Auth, audit meta and transport keys never reach handlers or cache keys.
const _VM_RESERVED_PARAMS = ['action', 'pin', 'totp', 'ip', 'city', 'country', 'ua', '_'];

let _vmRequestState = { dataset: Object.create(null), ledgers: Object.create(null), fx: Object.create(null) };

function vmResetRequest() {
  _vmRequestState = { dataset: Object.create(null), ledgers: Object.create(null), fx: Object.create(null) };
}

function _vmText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// ── Messages / error envelope ─────────────────────────────────────────────────
// Human copy per error code for view/validation responses. Phase 1 extends it.
const _VM_MESSAGES = {
  invalid_timezone: 'Timezone must be a valid IANA zone such as Europe/London.',
  invalid_quote_currency: 'Quote currency must be a currency code such as GBP.',
  invalid_today: 'Date must be a real calendar date in YYYY-MM-DD format.',
  invalid_period: 'Choose a valid period. Custom ranges need real dates with the start on or before the end.',
  unknown_action: 'This action is not available.',
  invalid_filter: 'One of the filters has an unsupported value. Clear the filters and try again.',
  invalid_sort: 'Choose a column to sort by from the list.',
  invalid_page: 'That page does not exist. Go back to the first page.',
  invalid_page_size: 'Choose a page size from the list.',
  invalid_statuses: 'Choose record statuses from the list.',

  // Form validation (Phase 1). Forms render these verbatim; codes are shared
  // across entities, so the copy stays entity-neutral where a code is shared.
  // Records / concurrency
  invalid_row: 'This record could not be found. Refresh and try again.',
  missing_row_num: 'This record could not be found. Refresh and try again.',
  stale_record: 'This record moved or changed. Refresh, then reopen it before trying again.',
  record_locked: 'This record is locked and cannot be changed.',
  field_not_editable: 'This field cannot be changed.',
  invalid_id: 'The record id must be a UUID.',
  // Accounts
  duplicate_account: 'Another account already uses this name.',
  duplicate_account_id: 'Another account already uses this id.',
  account_id_exists: 'An account with this id already exists.',
  account_in_use: 'This account is used by transactions or subscriptions and cannot be removed.',
  missing_account_name: 'Enter an account name.',
  invalid_account_type: 'Choose an account type from the Account Types catalog.',
  missing_sub_type: 'Choose an account subtype.',
  invalid_sub_type: 'Choose a subtype that belongs to the selected account type.',
  missing_local_currency: 'Choose the account currency.',
  invalid_local_currency: 'The currency must be a three-letter code such as GBP.',
  unknown_currency: 'This currency has no exchange rate yet. Add it under Currencies first.',
  invalid_local_timezone: 'The timezone must be a valid IANA zone such as Europe/London.',
  missing_opening_value_local: 'Enter the opening balance.',
  invalid_opening_value_local: 'The opening balance must be a decimal number without separators.',
  missing_opening_date_local: 'Enter the opening date.',
  invalid_account_opening_date_local: 'The opening date must be a real local date and time.',
  invalid_account_closing_date_local: 'The closing date must be a real local date and time on or after the opening date.',
  invalid_tracking_start_date_local: 'The tracking start must be a real local date and time.',
  invalid_existing_account_field: 'An existing account value is invalid in the Sheet. Correct it there first.',
  not_deleted: 'Only deleted records can be restored.',
  invalid_record_status: 'Choose a valid status.',
  // Dates and places
  missing_date: 'Date and time are required.',
  invalid_tx_date_local: 'Enter a valid local date and time.',
  invalid_tx_timezone_local: 'The transaction timezone is invalid.',
  nonexistent_local_time: 'This time does not exist because the clocks moved forward. Choose a valid time.',
  ambiguous_local_time: 'This time occurs twice when the clocks move back. Choose an unambiguous time.',
  invalid_user_location_latitude: 'Latitude must be a number.',
  invalid_user_location_longitude: 'Longitude must be a number.',
  latitude_out_of_range: 'Latitude must be between −90 and 90.',
  longitude_out_of_range: 'Longitude must be between −180 and 180.',
  incomplete_location_coordinates: 'Enter both latitude and longitude, or clear both.',
  // Transactions
  invalid_transaction_type: 'Choose a valid type (money in or money out).',
  missing_source_amount: 'Enter a positive amount.',
  missing_target_amount: 'Enter a positive target amount. Transfers between accounts in different currencies need one.',
  invalid_amount: 'Enter a positive amount.',
  invalid_tx_amount: 'Enter a positive amount.',
  missing_category: 'Choose a major and a minor category.',
  unknown_category: 'This category is not available. Choose an active category for this type.',
  missing_source_account: 'Choose a source account.',
  missing_target_account: 'Choose a target account.',
  missing_account_id: 'Choose an account.',
  same_transfer_account: 'A transfer needs two different accounts.',
  missing_reverse_transfer_category: 'This transfer category has no matching category for the other direction. Add it in Categories first.',
  unknown_account_id: 'The account is not available. Choose an active account; deleted accounts cannot be used.',
  unknown_source_account: 'The source account is not available. Choose an active account.',
  unknown_target_account: 'The target account is not available. Choose an active account.',
  duplicate_transaction: 'An identical transaction (same date, type, account and amount) already exists.',
  transaction_deleted: 'This transaction is deleted. Restore it before editing.',
  invalid_transfer_pair: 'A transfer must link different accounts and opposite money-in / money-out directions.',
  transfer_parent_deleted: 'A live linked transaction needs its original transfer. Delete the linked transaction first, or restore the original.',
  insufficient_balance: 'Insufficient balance. Record an Adjustments / Balance correction first if the actual balance is higher.',
  beneficiary_empty_name: 'Every beneficiary needs a name.',
  beneficiary_inconsistent_percentage_format: 'Give a percentage for every beneficiary, or for none.',
  beneficiary_invalid_percentage: 'Beneficiary percentages must be positive numbers up to 100.',
  beneficiary_percentage_rounds_to_zero: 'A beneficiary percentage is too small.',
  beneficiary_percentages_do_not_sum_to_100: 'Beneficiary percentages must add up to 100.',
  too_many_beneficiaries: 'There are too many beneficiaries to split evenly.',
  duplicate_beneficiary: 'Each beneficiary can appear only once.',
  // Categories
  invalid_category_row: 'The category could not be read.',
  missing_major_category: 'Major category is required.',
  missing_minor_category: 'Minor category is required.',
  invalid_category_label: 'Category names need at least one letter or digit.',
  invalid_boolean: 'Choose yes or no.',
  invalid_source_account_types: 'Choose source account types from the list.',
  invalid_target_account_types: 'Choose target account types from the list.',
  duplicate_category: 'This category already exists.',
  // Subscriptions
  missing_name: 'Name is required.',
  missing_subscription_amount_local: 'Amount is required.',
  invalid_subscription_amount_local: 'Amount must be a positive number.',
  invalid_source_account: 'Choose a source account from the list.',
  source_account_not_active: 'The source account is not active. Choose an active account.',
  category_not_active: 'This category is not active. Choose an active category.',
  category_not_subscription_eligible: 'This category cannot be used for subscriptions.',
  missing_frequency: 'Frequency is required.',
  invalid_frequency: 'Choose a valid frequency.',
  missing_day_of_week: 'Choose the day of the week for weekly payments.',
  invalid_day_of_week: 'Day of week must be a whole number from 1 to 7.',
  missing_day_of_month: 'Day of month is required for this frequency.',
  invalid_day_of_month: 'Day of month must be a whole number from 1 to 31.',
  invalid_subscription_timezone_local: 'Timezone must be a valid IANA zone such as Europe/London.',
  missing_subscription_timezone_local: 'Timezone is required when a start or end date is set.',
  invalid_subscription_start_date_local: 'Start date must be a real local date and time.',
  invalid_subscription_end_date_local: 'End date must be a real local date and time.',
  missing_subscription_start_date_local: 'Start date is required to anchor quarterly or annual payments.',
  end_before_start: 'End date must not be before the start date.',
  invalid_tx_type: 'Choose a valid type (money in or money out).',
  duplicate_subscription: 'A subscription with this name already exists.',
  // Rates
  missing_currency: 'Currency code is required.',
  invalid_currency_code: 'Currency code must be 1–8 letters or digits.',
  base_currency_readonly: 'XAU is the base currency and cannot be changed.',
  missing_rate: 'Rate is required.',
  rate_must_be_positive: 'Rate must be a positive number.',
  invalid_rate_mode: 'This rate action is not supported.',
  rate_already_exists: 'This currency already exists. Use Edit to update it.',
  symbol_too_long: 'Symbol must be at most 8 characters.',
  invalid_symbol_characters: 'Symbol cannot contain < > & " \' ` or \\.',
  invalid_rate_table: 'The rates Sheet is invalid. Fix it in the Sheet, then retry.',
};

function vmMessage(code, fallback) {
  if (Object.prototype.hasOwnProperty.call(_VM_MESSAGES, code)) return _VM_MESSAGES[code];
  return fallback === undefined ? '' : fallback;
}

// { ok:false, error, field?, message?, details? }; message defaults from the map.
function vmError(error, field, message, details) {
  const out = { ok: false, error: error };
  if (field !== undefined && field !== null && field !== '') out.field = field;
  const text = message === undefined || message === null || message === '' ? vmMessage(error, '') : message;
  if (text !== '') out.message = text;
  if (details !== undefined && details !== null) out.details = details;
  return out;
}

// ── Zoned today ───────────────────────────────────────────────────────────────

function vmZonedToday(timezone, now) {
  const parts = zonedDateParts(now === undefined ? new Date() : now, ianaDateFormatter(timezone));
  return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
}

// The zone name as given when it is a valid IANA zone, else null (offsets,
// unknown names). Not canonicalised: ICU may map Asia/Kolkata to Asia/Calcutta.
function vmCanonicalTimezone(value) {
  const text = _vmText(value);
  if (text === '') return null;
  try { ianaDateFormatter(text); return text; }
  catch (_) { return null; }
}

// ── Request context ───────────────────────────────────────────────────────────

// Returns { ok:true, ctx } or a vmError envelope. ctx:
// { action, params, quote_currency, tz, today, data_version, computed_at, cache_params }
function vmRequestContext(e, action) {
  const raw = e !== undefined && e !== null && e.parameter !== undefined && e.parameter !== null ? e.parameter : {};
  // Read data_version before any sheet so a concurrent POST can only make the
  // cached entry older-keyed, never fresh-keyed with stale data.
  const dataVersion = vcDataVersion();
  const params = {};
  Object.keys(raw).forEach(function(key) {
    if (_VM_RESERVED_PARAMS.indexOf(key) !== -1) return;
    params[key] = _vmText(raw[key]);
  });
  const quoteText = params.quote_currency === undefined || params.quote_currency === '' ? VM_DEFAULT_QUOTE_CURRENCY : params.quote_currency.toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(quoteText)) return vmError('invalid_quote_currency', 'quote_currency');
  const tzText = params.tz === undefined || params.tz === '' ? VM_DEFAULT_TIMEZONE : params.tz;
  const tz = vmCanonicalTimezone(tzText);
  if (tz === null) return vmError('invalid_timezone', 'tz');
  let today = params.today === undefined ? '' : params.today;
  if (today !== '' && !ldgIsDateKey(today)) return vmError('invalid_today', 'today');
  if (today === '') today = vmZonedToday(tz);
  params.quote_currency = quoteText;
  params.tz = tz;
  params.today = today;
  return {
    ok: true,
    ctx: {
      action: action, params: params, quote_currency: quoteText, tz: tz, today: today,
      data_version: dataVersion, computed_at: new Date().toISOString(), cache_params: params,
    },
  };
}

// ── Per-request dataset ───────────────────────────────────────────────────────

// Accounts exactly as listAccounts() normalises them, without balances.
function _vmReadAccountsRaw() {
  const sheet = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  return sheetToObjectsWithRow(sheet).map(function(account) {
    ['account_opening_date_local', 'account_closing_date_local', 'tracking_start_date_local'].forEach(function(field) {
      account[field] = sheetLocalDateTimeText(account[field]);
    });
    return account;
  });
}

// listAccounts() equivalent from the shared transaction read: same rows, same
// failures (invalid opening / tracking start), current_value_local via ledger-core.
function _vmBuildAccounts() {
  const raw = vmLoad('accounts_raw');
  raw.forEach(function(account) {
    const opening = Number(account.opening_value_local);
    if (account.opening_value_local === undefined || account.opening_value_local === null
        || String(account.opening_value_local).trim() === '' || !Number.isFinite(opening))
      throw new Error('invalid_account_opening_value');
  });
  const ledger = vmLedger(VM_DEFAULT_TIMEZONE);
  if (ledger.invalid_account_ids.length > 0) throw new Error('invalid_account_tracking_start');
  const current = ldgCurrentBalances(ledger);
  return raw.map(function(account) {
    return Object.assign({}, account, { current_value_local: current[account.id] });
  });
}

const _VM_LOADERS = {
  transactions: function() { return listTransactions(); },
  accounts_raw: _vmReadAccountsRaw,
  accounts: _vmBuildAccounts,
  categories: function() { return listCategories(); },
  rates: function() { return listRates(); },
  subscriptions: function() { return listSubscriptions(); },
  account_types: function() { return listAccountTypes(); },
};

// Memoized per request. Names: transactions, accounts_raw, accounts (with
// current_value_local), categories, rates, subscriptions, account_types.
// Returned arrays are shared: callers must not mutate them.
function vmLoad(name) {
  if (!Object.prototype.hasOwnProperty.call(_VM_LOADERS, name)) throw new Error('unknown_dataset');
  if (_vmRequestState.dataset[name] === undefined) _vmRequestState.dataset[name] = _VM_LOADERS[name]();
  return _vmRequestState.dataset[name];
}

// Ledger (ldgBuild) over accounts_raw + transactions for a bucketing tz.
function vmLedger(tz) {
  const zone = _vmText(tz) === '' ? VM_DEFAULT_TIMEZONE : _vmText(tz);
  if (_vmRequestState.ledgers[zone] === undefined)
    _vmRequestState.ledgers[zone] = ldgBuild(vmLoad('accounts_raw'), vmLoad('transactions'), { tz: zone });
  return _vmRequestState.ledgers[zone];
}

// fx-utils context for the request's quote currency (rates read once).
function vmFx(ctx) {
  const quote = ctx === undefined || ctx === null ? VM_DEFAULT_QUOTE_CURRENCY : ctx.quote_currency;
  if (_vmRequestState.fx[quote] === undefined) _vmRequestState.fx[quote] = fxContext(vmLoad('rates'), quote);
  return _vmRequestState.fx[quote];
}

// ── Success envelope ──────────────────────────────────────────────────────────

// { ok:true, data_version, computed_at, quote:{currency,symbol,rate_available}, warnings, data }
function vmEnvelope(ctx, data, warnings) {
  const fx = vmFx(ctx);
  const list = (Array.isArray(warnings) ? warnings : []).filter(function(item) { return item !== null && item !== undefined; });
  if (!fx.rate_available && !list.some(function(item) { return item.code === 'missing_rate'; }))
    list.push({ code: 'missing_rate', currencies: [fx.quote_currency] });
  return {
    ok: true,
    data_version: ctx.data_version,
    computed_at: ctx.computed_at,
    quote: { currency: fx.quote_currency, symbol: fx.quote_symbol, rate_available: fx.rate_available },
    warnings: list,
    data: data,
  };
}
