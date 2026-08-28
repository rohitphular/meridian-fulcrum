// =============================================================================
// FULCRUM FORGE — Router: doGet / doPost entry points
// Deploy as: Execute as Me · Anyone can access
//
// Script Properties required (Extensions → Apps Script → Project Settings):
//   PIN_SECRET   — your chosen PIN
//   TOTP_SECRET  — Base32 secret key, same as entered in Google Authenticator
// =============================================================================

function doGet(e) {
  const meta   = extractMeta(e.parameter);
  const action = e.parameter.action || '';

  if (checkLocked(meta.ip)) return json({ ok: false, error: 'locked' });

  if (action === 'verify') {
    if (!checkPin(e.parameter.pin)) {
      console.log('checkPin: fail ip=' + meta.ip);
      recordAccess(meta, false);
      return json({ ok: false, error: 'auth' });
    }
    if (!verifyTotp(e.parameter.totp)) {
      return json({ ok: false, error: 'totp_invalid' });
    }
    recordAccess(meta, true);
    return json({ ok: true });
  }

  if (!checkPin(e.parameter.pin)) {
    console.log('checkPin: fail ip=' + meta.ip);
    recordAccess(meta, false);
    return json({ ok: false, error: 'auth' });
  }
  recordAccess(meta, true);

  // Migration helpers (migrateTransactionColumnHeaders, migrateCategoryMandatoryFlags) were
  // removed — getOrCreateSheet() handles new columns via column-append on every call.
  if (action === 'list_transactions')  { return json({ ok: true, data: listTransactions() }); }
  if (action === 'list_categories')    { return json({ ok: true, data: listCategories() }); }
  if (action === 'list_accounts')      return json({ ok: true, data: listAccounts() });
  if (action === 'list_rates')         return json({ ok: true, data: listRates() });
  if (action === 'get_account_schema')      return json({ ok: true, data: getAccountSchemaForClient() });
  if (action === 'get_transaction_schema')  return json({ ok: true, data: getTransactionSchemaForClient() });
  if (action === 'get_category_schema')     return json({ ok: true, data: getCategorySchemaForClient() });
  if (action === 'get_rate_schema')         return json({ ok: true, data: getRateSchemaForClient() });
  if (action === 'get_advisor_history')          return json({ ok: true, data: getAdvisorHistory() });
  if (action === 'list_subscriptions')           return json({ ok: true, data: listSubscriptions() });
  if (action === 'get_subscription_schema')      return json({ ok: true, data: getSubscriptionSchemaForClient() });
  if (action === 'get_suggested_transactions')   return json({ ok: true, suggestions: getSuggestedTransactions() });
  if (action === 'get_transaction_metadata')     return json(getTransactionMetadata());
  if (action === 'get_computed_insights')        return json(getComputedInsights(e.parameter));

  return json({ ok: false, error: 'unknown_action' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (_) { return json({ ok: false, error: 'invalid_json' }); }

  const meta = extractMeta(body);

  if (checkLocked(meta.ip)) return json({ ok: false, error: 'locked' });

  if (!checkPin(body.pin)) {
    console.log('checkPin: fail ip=' + meta.ip);
    recordAccess(meta, false);
    return json({ ok: false, error: 'auth' });
  }
  recordAccess(meta, true);

  if (body.action === 'create_transaction')      return json(createTransaction(body));
  if (body.action === 'update_transaction')      return json(updateTransaction(body));
  if (body.action === 'delete_transaction')      return json(deleteTransaction(body));
  if (body.action === 'restore_transaction')     return json(restoreTransaction(body));
  if (body.action === 'create_transactions_bulk') return json(createTransactionsBulk(body));
  if (body.action === 'upsert_rate')        return json(upsertRate(body));
  if (body.action === 'delete_rate')        return json(deleteRate(body));
  if (body.action === 'create_category')    return json(createCategory(body));
  if (body.action === 'create_categories_bulk') return json(createCategoriesBulk(body));
  if (body.action === 'update_category')    return json(updateCategory(body));
  if (body.action === 'delete_category')    return json(deleteCategory(body));
  if (body.action === 'create_account')      return json(createAccount(body));
  if (body.action === 'create_accounts_bulk') return json(createAccountsBulk(body));
  if (body.action === 'update_account')     return json(updateAccount(body));
  if (body.action === 'delete_account')     return json(deleteAccount(body));
  if (body.action === 'advisor_chat')              return json(advisorChat(body));
  if (body.action === 'clear_advisor_history')     return json(clearAdvisorHistory());
  if (body.action === 'create_subscription')       return json(createSubscription(body));
  if (body.action === 'create_subscriptions_bulk') return json(createSubscriptionsBulk(body));
  if (body.action === 'update_subscription')       return json(updateSubscription(body));
  if (body.action === 'delete_subscription')       return json(deleteSubscription(body));

  return json({ ok: false, error: 'unknown_action' });
}
