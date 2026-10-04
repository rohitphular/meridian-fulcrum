// =============================================================================
// FULCRUM FORGE — GET action registry for view endpoints
//
// app-router.gs delegates any action it does not handle itself to
// grDispatchGet (after PIN check and audit). View files register actions via
// their hook (see grGetActions); never edit the router's if-chain.
//
// Entry: action: { handler: function(ctx) { return fn(ctx); }, cache: true|false, ttl: seconds }
// - Always wrap the handler in a call-time function: GAS evaluates files in
//   order, so a direct reference to a function in a later file can be
//   undefined at load time.
// - handler(ctx) receives the view-context.gs ctx and returns a response
//   object: vmEnvelope(ctx, data, warnings) on success, vmError(...) on failure.
// - cache: true stores { ok:true } payloads in view-cache.gs keyed by
//   data_version + action + params (quote_currency, tz, today included).
// - cache: 'published' does the same with the live report generation added to
//   the key (report-store.gs rsMeta), for views that read what the analytics job
//   published: its Sheets API writes do not bump data_version.
// Globals in this file use the gr / _gr prefix.
// =============================================================================

function grGetActions() {
  const actions = Object.create(null);
  actions.get_app_context = { handler: function(ctx) { return getAppContext(ctx); }, cache: true, ttl: 600 };
  // Each view file registers its own actions through one hook, so view files
  // never edit this registry: function <hook>(actions) { actions.x = {...}; }
  if (typeof viewTransactionsRegister === 'function') viewTransactionsRegister(actions);
  if (typeof viewAccountsRegister === 'function') viewAccountsRegister(actions);
  if (typeof viewConfigListsRegister === 'function') viewConfigListsRegister(actions);
  if (typeof viewSubscriptionsRegister === 'function') viewSubscriptionsRegister(actions);
  if (typeof viewCategoriesRegister === 'function') viewCategoriesRegister(actions);
  if (typeof viewReportsRegister === 'function') viewReportsRegister(actions);
  if (typeof viewReportStoreRegister === 'function') viewReportStoreRegister(actions);
  return actions;
}

function grHasGetAction(action) {
  return typeof action === 'string' && action !== '' && grGetActions()[action] !== undefined;
}

// Returns the response object for a registered action, or null when the
// action is not registered (the router then answers unknown_action).
function grDispatchGet(action, e) {
  const entry = typeof action === 'string' && action !== '' ? grGetActions()[action] : undefined;
  if (entry === undefined) return null;
  const built = vmRequestContext(e, action);
  if (built.ok !== true) return built;
  const ctx = built.ctx;
  if (entry.cache !== true && entry.cache !== 'published') return entry.handler(ctx);
  let version = ctx.data_version;
  if (entry.cache === 'published') {
    const meta = rsMeta();
    version += ':' + (meta === null ? 'unpublished' : meta.generation_id);
  }
  const cached = vcGetOrCompute(version, action, ctx.cache_params, entry.ttl, function() { return entry.handler(ctx); });
  return cached.value;
}
