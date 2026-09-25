/* =============================================================================
   FULCRUM FORGE — SheetsClient
   Shared HTTP layer for all forge modules. Handles all communication with the
   Google Apps Script Web App. Module-specific code never calls fetch() directly.

   Usage:
     SheetsClient.init({ scriptUrl: '...', pin: '...', meta: { ip, city, country, ua } });
     const res = await SheetsClient.list();          // { ok, data }
     const res = await SheetsClient.create({});      // { ok, error? }
     const res = await SheetsClient.update(id, {});  // { ok, error? }
     const res = await SheetsClient.remove(id);      // { ok, error? }

   meta fields are included in every request for server-side audit logging.
============================================================================= */

const SheetsClient = (() => {
  let _url  = null;
  let _pin  = null;
  let _meta = {};

  function init({ scriptUrl, pin, meta = {} }) {
    _url  = scriptUrl;
    _pin  = pin;
    _meta = meta;
  }

  // Bound loading on interrupted mobile connections. A POST timeout does not
  // cancel server execution: callers must refresh/check before a manual retry.
  async function _request(url, options = {}) {
    const controller = new AbortController();
    const mutation = options.method === 'POST';
    const timer = setTimeout(() => controller.abort(), mutation ? 180000 : 60000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error('http_error');
      return await response.json();
    } catch (_) {
      throw new Error(controller.signal.aborted ? 'request_timeout' : 'connection_error');
    } finally {
      clearTimeout(timer);
    }
  }

  async function _get(params) {
    const qs  = new URLSearchParams({ ...params, pin: _pin, ..._meta }).toString();
    return _request(`${_url}?${qs}`);
  }

  async function _post(body) {
    // Content-Type: text/plain avoids CORS preflight (Apps Script limitation).
    // Apps Script reads the raw body via e.postData.contents and parses it as JSON.
    return _request(_url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ ...body, pin: _pin, ..._meta })
    });
  }

  return {
    init,
    verify: (totp)       => _get({ action: 'verify', totp }),
    list:   ()           => _get({ action: 'list' }),
    create: (fields)     => _post({ action: 'create', ...fields }),
    update: (id, fields) => _post({ action: 'update', id, ...fields }),
    remove: (id)         => _post({ action: 'delete', id }),
    get:    (params)     => _get(params),
    post:   (body)       => _post(body)
  };
})();
