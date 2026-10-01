// =============================================================================
// FULCRUM FORGE — View cache: CacheService view payloads keyed by data_version
//
// data_version lives in Script Properties and changes on every successful POST
// (app-router.gs) and on every direct Sheet edit (onEdit in category-core.gs).
// Values are unique tokens, not counters: onEdit runs outside the script lock,
// so a read-modify-write increment could lose a bump and reuse a version.
// Globals in this file use the vc / _vc prefix.
// =============================================================================

const VC_DATA_VERSION_PROPERTY = 'DATA_VERSION';
const VC_MAX_TTL_SECONDS = 600;
const VC_MAX_PAYLOAD_BYTES = 90 * 1024;
const _VC_KEY_PARAMS_MAX = 180;

// Returns the current data_version token ('0' before the first bump).
function vcDataVersion() {
  try {
    const value = PropertiesService.getScriptProperties().getProperty(VC_DATA_VERSION_PROPERTY);
    return value === null || value === undefined || String(value).trim() === '' ? '0' : String(value);
  } catch (error) {
    console.error('vcDataVersion: error=properties_read_failed');
    return '0';
  }
}

// Replaces data_version with a new unique token. Never throws: a failed bump
// after a committed write must not turn the write into an error response.
function vcBumpDataVersion() {
  const token = Date.now().toString(36) + '-' + Math.floor(Math.random() * 2176782336).toString(36);
  try {
    PropertiesService.getScriptProperties().setProperty(VC_DATA_VERSION_PROPERTY, token);
    return token;
  } catch (error) {
    console.error('vcBumpDataVersion: error=properties_write_failed');
    return null;
  }
}

// Canonical, order-independent text for a params object (string values only).
function _vcCanonicalParams(params) {
  const keys = Object.keys(params === undefined || params === null ? {} : params).sort();
  return keys.map(function(key) {
    const value = params[key];
    return encodeURIComponent(key) + '=' + encodeURIComponent(value === undefined || value === null ? '' : String(value));
  }).join('&');
}

// Two independent 32-bit FNV-1a passes; collisions are also ruled out by
// storing the canonical params inside the cached value.
function _vcHash(text) {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code ^ (i & 0xff), 0x811c9dc5) >>> 0;
  }
  return first.toString(36) + second.toString(36);
}

// Key: v:{data_version}:{action}:{params}. Params must already include
// quote_currency, tz and today (vmRequestContext puts them in cache_params).
function vcKey(dataVersion, action, params) {
  const canonical = _vcCanonicalParams(params);
  const suffix = canonical.length <= _VC_KEY_PARAMS_MAX ? canonical : 'h' + _vcHash(canonical);
  return 'v:' + dataVersion + ':' + action + ':' + suffix;
}

function _vcUtf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function _vcCache() {
  try { return CacheService.getScriptCache(); }
  catch (error) { console.error('vcCache: error=cache_unavailable'); return null; }
}

// Returns the cached payload for (dataVersion, action, params), or computes it
// with compute(). Only { ok: true } payloads up to 90 KB (UTF-8) are stored.
// Returns { value, hit }.
function vcGetOrCompute(dataVersion, action, params, ttlSeconds, compute) {
  const canonical = _vcCanonicalParams(params);
  const key = vcKey(dataVersion, action, params);
  const cache = _vcCache();
  if (cache !== null) {
    let raw = null;
    try { raw = cache.get(key); } catch (error) { console.error('vcGetOrCompute: error=cache_read_failed action=' + action); }
    if (raw !== null && raw !== undefined) {
      try {
        const entry = JSON.parse(raw);
        if (entry !== null && typeof entry === 'object' && entry.p === canonical && entry.v !== undefined) return { value: entry.v, hit: true };
      } catch (error) { console.warn('vcGetOrCompute: skipped_reason=invalid_cache_entry action=' + action); }
    }
  }
  const value = compute();
  if (cache === null || value === null || typeof value !== 'object' || value.ok !== true) return { value: value, hit: false };
  let text;
  try { text = JSON.stringify({ p: canonical, v: value }); }
  catch (error) { console.error('vcGetOrCompute: error=serialise_failed action=' + action); return { value: value, hit: false }; }
  if (_vcUtf8Bytes(text) > VC_MAX_PAYLOAD_BYTES) {
    console.warn('vcGetOrCompute: skipped_reason=payload_too_large action=' + action);
    return { value: value, hit: false };
  }
  const ttl = Math.max(1, Math.min(VC_MAX_TTL_SECONDS, Number.isFinite(Number(ttlSeconds)) ? Math.floor(Number(ttlSeconds)) : VC_MAX_TTL_SECONDS));
  try { cache.put(key, text, ttl); }
  catch (error) { console.error('vcGetOrCompute: error=cache_write_failed action=' + action); }
  return { value: value, hit: false };
}

// Sheet edit hook: a direct edit invalidates every cached view.
function vcOnSheetEdit() {
  vcBumpDataVersion();
}
