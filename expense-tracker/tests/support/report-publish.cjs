// Writes the analytics job's published tabs into mock Sheets exactly as
// data-synchronization/analytics/core/publish.py lays them out (payload_rows):
// report_data_<slot> chunks, report_index_<slot>, report_status, report_meta last.
const fs = require('node:fs');
const path = require('node:path');
const { Sheet } = require('./gas-runtime.cjs');

const CONTRACT = path.resolve(__dirname, '../../../data-synchronization/analytics/contract');
const TABS = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'sheet-tabs.json'), 'utf8'));
const PREDEFINED = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'predefined-reports.json'), 'utf8'));
const columns = name => TABS.tabs.find(tab => tab.name === name).columns;
const predefinedId = key => PREDEFINED.reports.find(report => report.key === key).id;

// A minimal valid payload (contract/report-payload.md) with the given fields.
function payload(fields = {}) {
  return {
    contract_version: 1, report_id: null, predefined_key: null, variant_key: '', anchor_date: '2026-09-30', title: '', description: '',
    period: null, compare: null, tab: null, tabs: [], controls: [], stat_cards: [], charts: [], tables: [], drill: null,
    breadcrumbs: [], notes: [], empty: null, warnings: [], ...fields,
  };
}

function upsert(sheets, name, rows) {
  const found = sheets.find(sheet => sheet.name === name);
  if (found) { found.rows = rows.map(row => row.slice()); return found; }
  const sheet = new Sheet(name, rows);
  sheets.push(sheet);
  return sheet;
}

// outputs: [{ report_id, variant_key?, payload }]; results: [{ report_id, status, error_code?, definition_updated_at? }].
// Returns the meta row as an object.
function publish(sheets, { generation_id = 'gen-1', slot = 'a', outputs = [], results, chunk = 45000, published_at = '2026-09-30T06:00:00.000Z', skipMeta = false } = {}) {
  const data = [], index = [];
  for (const output of outputs) {
    const text = JSON.stringify(output.payload);
    const parts = [];
    for (let at = 0; at < text.length; at += chunk) parts.push(text.slice(at, at + chunk));
    index.push([output.report_id, output.variant_key || '', data.length + 2, parts.length, 'hash']);
    parts.forEach((part, number) => data.push([output.report_id, output.variant_key || '', number + 1, part]));
  }
  upsert(sheets, `report_data_${slot}`, [columns(`report_data_${slot}`), ...data]);
  upsert(sheets, `report_index_${slot}`, [columns(`report_index_${slot}`), ...index]);
  const statusRows = (results || [...new Set(outputs.map(output => output.report_id))].map(report_id => ({ report_id, status: 'ready' })))
    .map(result => [result.report_id, result.definition_updated_at || '', result.status, result.error_code || '', published_at]);
  upsert(sheets, 'report_status', [columns('report_status'), ...statusRows]);
  const meta = { active_slot: slot, generation_id, published_at, contract_version: 1, anchor_date: '2026-09-30', source_watermark: '{}', reports_ok: outputs.length, reports_failed: 0, rows_not_loaded: 0, missing_currencies: '' };
  if (!skipMeta) upsert(sheets, 'report_meta', [columns('report_meta'), columns('report_meta').map(column => meta[column])]);
  return meta;
}

module.exports = { publish, payload, predefinedId, PREDEFINED, CONTRACT };
