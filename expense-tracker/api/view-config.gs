// =============================================================================
// FULCRUM FORGE — View config: get_app_context (startup bootstrap)
//
// One GET returning what the app needs at startup: schemas / enums / labels,
// quote currencies with symbols, account and category option trees, period
// options, the insights registry (placeholder until phase 4) and data_version.
// The old get_*_schema / list_* actions stay available.
// Globals in this file use the cfg / _cfg prefix (getAppContext is public).
// =============================================================================

function _cfgText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// Display label for a rate: 2 decimals for integers, else up to 4 (as main.js did).
function _cfgRateLabel(rate) {
  if (!Number.isFinite(rate)) return '';
  if (Number.isInteger(rate)) return rate.toFixed(2);
  return rate.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function _cfgQuoteCurrencies(rates) {
  return rates.map(function(row) {
    const rate = Number(row.rate);
    return {
      currency: _cfgText(row.currency).toUpperCase(),
      symbol: row.symbol === undefined || row.symbol === null ? '' : String(row.symbol),
      rate: Number.isFinite(rate) ? rate : null,
      rate_label: _cfgRateLabel(rate),
    };
  });
}

// Accounts grouped by type family (all statuses except deleted), sorted by name.
function _cfgAccountOptions(accounts, accountSchema, fx) {
  const typeLabels = accountSchema !== null && accountSchema !== undefined && accountSchema.type_labels !== undefined ? accountSchema.type_labels : {};
  const subtypeLabels = accountSchema !== null && accountSchema !== undefined && accountSchema.subtype_labels !== undefined ? accountSchema.subtype_labels : {};
  const groups = [];
  const byType = Object.create(null);
  accounts.filter(function(account) { return _cfgText(account.record_status) !== 'deleted' && _cfgText(account.id) !== ''; })
    .slice().sort(function(a, b) { return _cfgText(a.account_name).localeCompare(_cfgText(b.account_name)); })
    .forEach(function(account) {
      const type = _cfgText(account.type);
      if (byType[type] === undefined) {
        byType[type] = { type: type, type_label: typeLabels[type] !== undefined ? typeLabels[type] : type, accounts: [] };
        groups.push(byType[type]);
      }
      const subType = _cfgText(account.sub_type);
      const currency = _cfgText(account.account_currency_local).toUpperCase();
      byType[type].accounts.push({
        id: _cfgText(account.id), account_name: _cfgText(account.account_name),
        sub_type: subType, sub_type_label: subtypeLabels[subType] !== undefined ? subtypeLabels[subType] : subType,
        currency: currency, currency_symbol: fxSymbol(currency, fx.symbols), record_status: _cfgText(account.record_status),
      });
    });
  return groups;
}

// tx_type → majors → minors (deleted rows omitted). A major is active when any
// of its minors is active (ports transactions.js _catMajorOpts).
function _cfgCategoryOptions(categories, categorySchema) {
  const typeLabels = Object.create(null);
  (categorySchema.types || []).forEach(function(type) { typeLabels[type.value] = type.label; });
  const tree = [];
  const byType = Object.create(null);
  const byMajor = Object.create(null);
  categories.filter(function(row) { return _cfgText(row.record_status) !== 'deleted'; }).forEach(function(row) {
    const type = _cfgText(row.tx_type_key), major = _cfgText(row.major_category_key), minor = _cfgText(row.minor_category_key);
    if (type === '' || major === '' || minor === '') return;
    if (byType[type] === undefined) {
      byType[type] = { tx_type: type, label: typeLabels[type] !== undefined ? typeLabels[type] : type, majors: [] };
      tree.push(byType[type]);
    }
    const majorKey = type + '|' + major;
    if (byMajor[majorKey] === undefined) {
      byMajor[majorKey] = { key: major, label: _cfgText(row.major_category_label) === '' ? major : _cfgText(row.major_category_label), is_active: false, minors: [] };
      byType[type].majors.push(byMajor[majorKey]);
    }
    const status = _cfgText(row.record_status);
    if (status === 'active') byMajor[majorKey].is_active = true;
    byMajor[majorKey].minors.push({
      key: minor, label: _cfgText(row.minor_category_label) === '' ? minor : _cfgText(row.minor_category_label),
      record_status: status, is_active: status === 'active',
      source_account_mandatory: toBool(row.source_account_mandatory),
      target_account_mandatory: toBool(row.target_account_mandatory),
      is_subscription_eligible: toBool(row.is_subscription_eligible),
    });
  });
  tree.forEach(function(type) {
    type.majors.sort(function(a, b) { return a.label.localeCompare(b.label); });
    type.majors.forEach(function(major) { major.minors.sort(function(a, b) { return a.label.localeCompare(b.label); }); });
  });
  return tree;
}

// Phase 4 defines insightsRegistryForClient() in insights-registry.gs.
function _cfgInsightsRegistry() {
  return typeof insightsRegistryForClient === 'function' ? insightsRegistryForClient() : [];
}

// GET get_app_context → vmEnvelope with data:
// { default_quote, default_timezone, tz, today, quote_currencies, schemas,
//   options: { accounts, categories }, periods, nav: { insights_registry } }
function getAppContext(ctx) {
  const fx = vmFx(ctx);
  const schemas = {
    account: getAccountSchemaForClient(),
    transaction: getTransactionSchemaForClient(),
    category: getCategorySchemaForClient(),
    subscription: getSubscriptionSchemaForClient(),
    account_type: getAccountTypeSchemaForClient(),
    rate: getRateSchemaForClient(),
  };
  const accounts = vmLoad('accounts_raw');
  const data = {
    default_quote: VM_DEFAULT_QUOTE_CURRENCY,
    default_timezone: VM_DEFAULT_TIMEZONE,
    tz: ctx.tz,
    today: ctx.today,
    quote_currencies: _cfgQuoteCurrencies(fx.rates),
    schemas: schemas,
    options: {
      accounts: _cfgAccountOptions(accounts, schemas.account, fx),
      categories: _cfgCategoryOptions(vmLoad('categories'), schemas.category),
    },
    periods: LDG_PERIODS.map(function(key) { return { value: key, label: LDG_PERIOD_LABELS[key] }; }),
    nav: { insights_registry: _cfgInsightsRegistry() },
  };
  const warning = fxMissingRateWarning(accounts.filter(function(account) { return _cfgText(account.record_status) !== 'deleted'; })
    .map(function(account) { return account.account_currency_local; }), fx);
  return vmEnvelope(ctx, data, [warning]);
}
