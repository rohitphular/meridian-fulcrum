// =============================================================================
// FULCRUM FORGE — Report store: read what the analytics job published
//
// The job (data-synchronization/analytics) writes job-owned tabs through the
// Sheets API (contract/sheet-tabs.json): report_meta names the live slot and
// generation; report_index_<slot> lists each payload's rows in
// report_data_<slot>, where a payload is split into chunks of text. This file:
// - reads report_meta (one small range) on every request;
// - reads the slot's index once per generation (cached by generation_id), then
//   only the rows of the requested payload; joins the chunks; parses;
// - converts money from XAU grams to the display currency: value × rate[quote]
//   for every value whose format is money (contract/report-payload.md). Nothing
//   else is computed here.
// Job-owned tabs are read with getSheetByName and never created: a missing tab
// means "not published yet" (the documented exception to getOrCreateSheet).
// Cache keys carry the generation id: the job's writes do not bump data_version.
// GET actions (registered through viewReportStoreRegister):
//   get_report      params: id, period?, tab?, drill?, <control>?  (or variant)
//   get_home_view   the Home layout with its 8 published payloads
// Globals in this file use the rs / _rs prefix.
// =============================================================================

const _RS_MONEY_FORMATS = ['money', 'money2', 'money_delta'];
const _RS_CACHE_TTL_SECONDS = 21600;
const _RS_CACHE_MAX_CHARS = 90000;

function viewReportStoreRegister(actions) {
  actions.get_report = { handler: function(ctx) { return getReportView(ctx); }, cache: 'published', ttl: 600 };
  actions.get_home_view = { handler: function(ctx) { return getHomeView(ctx); }, cache: 'published', ttl: 600 };
}

function _rsText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function _rsCache() {
  try { return CacheService.getScriptCache(); }
  catch (error) { console.error('rsCache: error=cache_unavailable'); return null; }
}

function _rsCacheGet(key) {
  const cache = _rsCache();
  if (cache === null) return null;
  try { return cache.get(key); }
  catch (error) { console.error('rsCacheGet: error=cache_read_failed'); return null; }
}

function _rsCachePut(entries) {
  const cache = _rsCache();
  if (cache === null) return;
  const fitting = {};
  Object.keys(entries).forEach(function(key) { if (entries[key].length <= _RS_CACHE_MAX_CHARS) fitting[key] = entries[key]; });
  try { cache.putAll(fitting, _RS_CACHE_TTL_SECONDS); }
  catch (error) { console.error('rsCachePut: error=cache_write_failed'); }
}

// ── report_meta ───────────────────────────────────────────────────────────────

// The live generation: { active_slot, generation_id, published_at, … } or null
// when nothing is published yet (no tab, no row, or an unreadable row).
function rsMeta() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_META_SHEET);
  if (sheet === null) return null;
  const columns = rptSheetTab(REPORT_META_SHEET).columns;
  const values = sheet.getRange(1, 1, 2, columns.length).getValues();
  const header = values[0].map(_rsText);
  const meta = {};
  columns.forEach(function(column) {
    const at = header.indexOf(column);
    meta[column] = at === -1 ? '' : _rptCellText('updated_at', values[1][at]);
  });
  if (REPORT_SHEET_TABS.slots.indexOf(meta.active_slot) === -1 || meta.generation_id === '') return null;
  return meta;
}

// ── Index and payloads (cached per generation) ────────────────────────────────

function _rsIndexKey(meta, reportId) {
  return 'rs:' + meta.generation_id + ':i:' + reportId;
}

// { variant_key: { first_row, row_count, payload_hash } } for one report in the
// live slot ({} when the report has no payload). The whole index is read once
// per generation and cached per report.
function _rsIndexFor(meta, reportId) {
  const cached = _rsCacheGet(_rsIndexKey(meta, reportId));
  if (cached !== null) {
    try { return JSON.parse(cached); }
    catch (error) { console.warn('rsIndexFor: skipped_reason=invalid_cache_entry'); }
  }
  if (_rsCacheGet('rs:' + meta.generation_id + ':i') !== null) return {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(meta.active_slot === 'a' ? REPORT_INDEX_A_SHEET : REPORT_INDEX_B_SHEET);
  if (sheet === null) return {};
  const byReport = {};
  sheet.getDataRange().getValues().slice(1).forEach(function(row) {
    const id = _rsText(row[0]).toLowerCase();
    if (id === '') return;
    if (byReport[id] === undefined) byReport[id] = {};
    byReport[id][_rsText(row[1])] = { first_row: Number(row[2]), row_count: Number(row[3]), payload_hash: _rsText(row[4]) };
  });
  const entries = {};
  entries['rs:' + meta.generation_id + ':i'] = '1';
  Object.keys(byReport).forEach(function(id) { entries[_rsIndexKey(meta, id)] = JSON.stringify(byReport[id]); });
  _rsCachePut(entries);
  console.log('rsIndexFor: generation_id=' + meta.generation_id + ' reports=' + Object.keys(byReport).length);
  return byReport[reportId] === undefined ? {} : byReport[reportId];
}

// The payload object (still in XAU), or null when its rows are missing or do
// not parse (a publish in progress never shows: the slot is inactive until
// report_meta switches to it).
function _rsPayload(meta, reportId, variantKey, entry) {
  const key = 'rs:' + meta.generation_id + ':p:' + _vcHash(reportId + '|' + variantKey);
  let text = _rsCacheGet(key);
  if (text === null) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(meta.active_slot === 'a' ? REPORT_DATA_A_SHEET : REPORT_DATA_B_SHEET);
    if (sheet === null || !(entry.first_row >= 2) || !(entry.row_count >= 1)) return null;
    const rows = sheet.getRange(entry.first_row, 1, entry.row_count, 4).getValues();
    const intact = rows.every(function(row, index) {
      return _rsText(row[0]).toLowerCase() === reportId && _rsText(row[1]) === variantKey && Number(row[2]) === index + 1;
    });
    if (!intact) { console.error('rsPayload: error=chunks_out_of_place generation_id=' + meta.generation_id); return null; }
    text = rows.map(function(row) { return row[3] === undefined || row[3] === null ? '' : String(row[3]); }).join('');
    const entries = {};
    entries[key] = text;
    _rsCachePut(entries);
  }
  try { return JSON.parse(text); }
  catch (error) { console.error('rsPayload: error=payload_not_json generation_id=' + meta.generation_id); return null; }
}

// ── Money conversion (XAU grams → display currency) ───────────────────────────

function _rsIsMoney(format) {
  return _RS_MONEY_FORMATS.indexOf(format) !== -1;
}

function _rsMoney(value, rate) {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) return null;
  return rate === null ? null : value * rate;
}

// Text with values: { text, values:[{ value, format }] } (a plain string is left alone).
function _rsTextValues(text, rate) {
  if (text === null || typeof text !== 'object' || !Array.isArray(text.values)) return text;
  return Object.assign({}, text, {
    values: text.values.map(function(item) { return _rsIsMoney(item.format) ? Object.assign({}, item, { value: _rsMoney(item.value, rate) }) : item; }),
  });
}

function _rsChart(chart, rate) {
  const formatFor = function(axis) { return axis === 'y2' ? chart.y2_format : chart.y_format; };
  const out = Object.assign({}, chart);
  out.datasets = (chart.datasets || []).map(function(dataset) {
    if (!_rsIsMoney(formatFor(dataset.axis))) return dataset;
    return Object.assign({}, dataset, {
      data: (dataset.data || []).map(function(point) {
        return Array.isArray(point) ? point.map(function(value) { return _rsMoney(value, rate); }) : _rsMoney(point, rate);
      }),
    });
  });
  out.ref_lines = (chart.ref_lines || []).map(function(line) {
    return _rsIsMoney(formatFor(line.axis)) ? Object.assign({}, line, { value: _rsMoney(line.value, rate) }) : line;
  });
  return out;
}

function _rsCells(cells, formats, rate) {
  const out = {};
  Object.keys(cells || {}).forEach(function(key) {
    const value = cells[key];
    if (value !== null && typeof value === 'object') out[key] = _rsTextValues(value, rate);
    else out[key] = _rsIsMoney(formats[key]) ? _rsMoney(value, rate) : value;
  });
  return out;
}

function _rsTable(table, rate) {
  const formats = {};
  (table.columns || []).forEach(function(column) { formats[column.key] = column.format; });
  const out = Object.assign({}, table);
  out.rows = (table.rows || []).map(function(row) { return Object.assign({}, row, { cells: _rsCells(row.cells, formats, rate) }); });
  if (table.total_row) out.total_row = Object.assign({}, table.total_row, { cells: _rsCells(table.total_row.cells, formats, rate) });
  return out;
}

// A copy of the payload with every money value × rate (null when the rate is
// missing: never converted 1:1).
function rsConvert(payload, rate) {
  const out = Object.assign({}, payload);
  out.stat_cards = (payload.stat_cards || []).map(function(card) {
    const next = Object.assign({}, card, { sub: _rsTextValues(card.sub, rate) });
    if (card.sub === undefined) delete next.sub;
    if (_rsIsMoney(card.format)) next.value = _rsMoney(card.value, rate);
    return next;
  });
  out.charts = (payload.charts || []).map(function(chart) { return _rsChart(chart, rate); });
  out.tables = (payload.tables || []).map(function(table) { return _rsTable(table, rate); });
  out.notes = (payload.notes || []).map(function(note) { return _rsTextValues(note, rate); });
  if (payload.drill) {
    const drill = Object.assign({}, payload.drill, { title: _rsTextValues(payload.drill.title, rate), subtitle: _rsTextValues(payload.drill.subtitle, rate) });
    if (payload.drill.subtitle === undefined) delete drill.subtitle;
    if (Array.isArray(payload.drill.charts)) drill.charts = payload.drill.charts.map(function(chart) { return _rsChart(chart, rate); });
    if (payload.drill.table) drill.table = _rsTable(payload.drill.table, rate);
    out.drill = drill;
  }
  return out;
}

// ── Variant keys (contract/report-payload.md) ─────────────────────────────────

// Python urllib.parse.quote(value, safe=''): encodeURIComponent plus !'()*.
function _rsQuote(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, function(c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
}

// Parameters sorted by name, name=value joined by &, defaults and blanks left out.
function rsVariantKey(params, defaults) {
  return Object.keys(params).sort().filter(function(name) {
    const value = params[name];
    return value !== null && value !== undefined && String(value) !== '' && String(defaults[name]) !== String(value);
  }).map(function(name) { return name + '=' + _rsQuote(String(params[name])); }).join('&');
}

// { ok:true, key } or a vmError: the variant of a pre-built report from the
// request's period / tab / controls / drill (each checked against the catalogue).
function rsPredefinedVariant(entry, params) {
  const defaults = { period: entry.default_period, tab: entry.tabs.length > 0 ? entry.tabs[0].key : null };
  entry.controls.forEach(function(control) { defaults[control.param] = control.default; });
  const chosen = { period: _rsText(params.period) === '' ? defaults.period : _rsText(params.period) };
  if (entry.periods.length === 0 ? chosen.period !== defaults.period : entry.periods.indexOf(chosen.period) === -1) return vmError('invalid_period', 'period');
  chosen.tab = _rsText(params.tab) === '' ? defaults.tab : _rsText(params.tab);
  if (entry.tabs.length > 0 && !entry.tabs.some(function(tab) { return tab.key === chosen.tab; })) return vmError('invalid_tab', 'tab');
  for (let i = 0; i < entry.controls.length; i++) {
    const control = entry.controls[i];
    const text = _rsText(params[control.param]);
    const value = text === '' ? control.default : text;
    if (!control.values.some(function(allowed) { return String(allowed) === String(value); })) return vmError('invalid_filter', control.param);
    chosen[control.param] = value;
  }
  const drill = _rsText(params.drill);
  if (drill !== '') {
    const name = drill.split(':')[0];
    if (!entry.drills.some(function(item) { return item.param === name && item.published === 'aggregate'; }) || drill.indexOf(':') === -1) return vmError('invalid_drill', 'drill');
    chosen.drill = drill;
    // Drill variants are published for each period with the default tab and
    // controls only (analytics predefined_step.build_entry).
    chosen.tab = defaults.tab;
    entry.controls.forEach(function(control) { chosen[control.param] = control.default; });
  }
  return { ok: true, key: rsVariantKey(chosen, defaults) };
}

// ── Reading one report ────────────────────────────────────────────────────────

// Quote for the request: { currency, symbol, rate (units per gram) | null, rate_date }.
function rsQuote(ctx) {
  const fx = vmFx(ctx);
  const row = fx.rates.find(function(rate) { return _rsText(rate.currency).toUpperCase() === fx.quote_currency; });
  return {
    currency: fx.quote_currency, symbol: fx.quote_symbol,
    rate: fx.rate_available ? fx.rate_map[fx.quote_currency] : null,
    rate_date: row === undefined ? '' : _rptCellText('period_from', row.rate_date),
  };
}

// { payload (converted) | null, warnings } for a report id and variant key.
function rsReadReport(ctx, meta, reportId, variantKey) {
  if (meta === null) return { payload: null, warnings: [{ code: 'not_published' }] };
  const variants = _rsIndexFor(meta, reportId);
  const entry = variants[variantKey];
  if (entry === undefined) {
    const status = _vwRptStatusIndex()[reportId];
    if (status !== undefined && status.status === 'failed') return { payload: null, warnings: [{ code: 'report_failed', error_code: status.error_code }] };
    return { payload: null, warnings: [{ code: Object.keys(variants).length === 0 ? 'not_published' : 'variant_not_published' }] };
  }
  const payload = _rsPayload(meta, reportId, variantKey, entry);
  if (payload === null) return { payload: null, warnings: [{ code: 'not_published' }] };
  const quote = rsQuote(ctx);
  return { payload: rsConvert(payload, quote.rate), warnings: (payload.warnings || []).slice() };
}

// A pre-built report's published payload, unconverted (XAU grams), for server
// use (the advisor snapshot); null when it is not published.
function rsPublishedPayload(meta, predefinedKey, params) {
  const entry = rptPredefinedByKey(predefinedKey);
  if (meta === null || entry === null) return null;
  const variant = rsPredefinedVariant(entry, params === undefined ? {} : params);
  if (variant.ok !== true) return null;
  const found = _rsIndexFor(meta, entry.id)[variant.key];
  return found === undefined ? null : _rsPayload(meta, entry.id, variant.key, found);
}

// vmEnvelope plus the generation it read and the rate it converted with.
function rsEnvelope(ctx, meta, data, warnings) {
  const envelope = vmEnvelope(ctx, data, warnings);
  const quote = rsQuote(ctx);
  envelope.quote.rate = quote.rate;
  envelope.quote.rate_date = quote.rate_date;
  envelope.published_at = meta === null ? '' : meta.published_at;
  envelope.generation_id = meta === null ? '' : meta.generation_id;
  return envelope;
}

// GET get_report. Params: id (report uuid); for a pre-built report period, tab,
// drill and its controls (defaults when omitted); a user report has one variant.
function getReportView(ctx) {
  const id = _rsText(ctx.params.id).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return vmError('report_not_found', 'id');
  const entry = rptPredefinedById(id);
  let variantKey = '';
  if (entry !== null) {
    const variant = rsPredefinedVariant(entry, ctx.params);
    if (variant.ok !== true) return variant;
    variantKey = variant.key;
  } else if (!listReportRows().some(function(row) { return row.id === id && row.report_type === 'user_defined' && row.record_status !== 'deleted'; })) {
    return vmError('report_not_found', 'id');
  }
  const meta = rsMeta();
  const read = rsReadReport(ctx, meta, id, variantKey);
  console.log('getReportView: generation_id=' + (meta === null ? '' : meta.generation_id) + ' found=' + (read.payload !== null));
  return rsEnvelope(ctx, meta, { report_id: id, variant_key: variantKey, payload: read.payload }, read.warnings);
}

// GET get_home_view → data: { slots: [{ slot, area, report_id, title, payload|null, warnings }] }
// in layout order (tiles, then panels). Each slot shows its report's default variant.
function getHomeView(ctx) {
  const meta = rsMeta();
  const layout = readDashboardLayout();
  const catalog = dlReportCatalog();
  const slots = getDashboardSlots().map(function(slot) {
    const reportId = layout.slots[slot];
    const entry = reportId === '' ? undefined : catalog[reportId];
    const base = { slot: slot, area: rptSlotArea(slot), report_id: reportId, title: entry === undefined ? '' : entry.title, payload: null, warnings: [] };
    if (!_dlAvailable(entry)) return Object.assign(base, { report_id: '' });
    const read = rsReadReport(ctx, meta, reportId, '');
    return Object.assign(base, { payload: read.payload, warnings: read.warnings });
  });
  const warnings = meta === null ? [{ code: 'not_published' }] : [];
  console.log('getHomeView: generation_id=' + (meta === null ? '' : meta.generation_id) + ' filled=' + slots.filter(function(slot) { return slot.payload !== null; }).length);
  return rsEnvelope(ctx, meta, { is_default_layout: layout.is_default, slots: slots }, warnings);
}
