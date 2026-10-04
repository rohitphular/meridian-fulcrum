// Frontend test harness: loads app ES modules into one vm context (imports
// stripped, exports unwrapped) with a minimal fake DOM, and wires the real
// core/api.js to the real GAS router (doGet / doPost on the view fixture), so
// sections are tested against the server contract.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gasRuntime } = require('./gas-runtime.cjs');
const { seedViewFixture } = require('./view-fixture.cjs');

const ROOT = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flush = async (times = 4) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };
const plain = value => JSON.parse(JSON.stringify(value));
const CSS = { '--teal': '#14b8a6', '--ember': '#e4572e', '--muted': '#888888', '--ink': '#111111', '--hair': '#dddddd', '--panel': '#ffffff' };

class FakeChart {
  constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; FakeChart.instances.push(this); }
  destroy() { this.destroyed = true; }
}
FakeChart.instances = [];

// Every id resolves to one node. Nodes record listeners (with their abort
// signal), answer the few selectors the app uses, and expose their canvases
// from the HTML they were given.
function fakeDom() {
  const nodes = {};
  const canvases = (html, attr, key) => [...String(html).matchAll(new RegExp(`${attr}="(\\d+)"`, 'g'))]
    .map(match => ({ dataset: { [key]: match[1] }, parentElement: null }));
  // Setting innerHTML replaces the elements it names, as in a browser: their
  // next el() is a fresh node (no listeners, empty content).
  const node = id => {
    const created = _node(id);
    let html = '';
    Object.defineProperty(created, 'innerHTML', {
      get: () => html,
      set: value => {
        html = String(value);
        for (const match of html.matchAll(/\bid="([^"]+)"/g)) if (match[1] !== id) delete nodes[match[1]];
      },
    });
    return created;
  };
  const _node = id => ({
    id, value: '', checked: false, disabled: false, textContent: '', dataset: {}, listeners: [], children: [],
    style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn, options) { this.listeners.push({ type, fn, signal: options?.signal }); },
    appendChild(child) { this.children.push(child); },
    contains: () => true, scrollIntoView() {}, focus() {},
    querySelector(selector) {
      if (selector.startsWith('#')) return el(selector.slice(1));
      if (selector === '[data-role="report-drill"]') return this.innerHTML.includes('data-role="report-drill"') ? (this._drill ??= node(`${id}:drill`)) : null;
      const action = /^\[data-action="([^"]+)"\]$/.exec(selector);
      if (action) return this.innerHTML.includes(`data-action="${action[1]}"`) ? (this._actions ??= {})[action[1]] ??= node(`${id}:${action[1]}`) : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'canvas[data-chart-index]') return canvases(this.innerHTML, 'data-chart-index', 'chartIndex');
      if (selector === 'canvas[data-drill-chart-index]') return canvases(this.innerHTML, 'data-drill-chart-index', 'drillChartIndex');
      return [];
    },
  });
  const el = id => (nodes[id] ??= node(id));
  // Dispatches an event to a node's live listeners. target: a button dataset
  // ({ action, ... }) for clicks, or { id, value, checked, dataset } for inputs.
  const fire = (target, type, detail) => {
    const host = typeof target === 'string' ? el(target) : target;
    const button = { dataset: detail?.dataset ?? detail ?? {}, disabled: detail?.disabled === true };
    button.closest = () => (button.dataset.action ? button : null);
    const event = type === 'click' ? { target: button } : { target: { dataset: {}, ...detail } };
    host.listeners.filter(entry => entry.type === type && !entry.signal?.aborted).forEach(entry => entry.fn(event));
  };
  return { nodes, el, fire };
}

// files: app-relative paths; globals: extra context values; exposed: names to return.
function loadModules(files, globals, exposed, setup = '') {
  const source = files.map(file => read(file)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '')
    .replace(/^export \{[^}]*\}[^;\n]*;?\s*$/gm, '')).join('\n');
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, esc, Chart: FakeChart, setImmediate, Intl, Date,
    getComputedStyle: () => ({ getPropertyValue: name => CSS[name] ?? '' }),
    document: { documentElement: {}, dispatchEvent() {}, createElement: () => ({ className: '', innerHTML: '' }) },
    window: {}, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    AbortController, WeakMap, ...globals,
  });
  vm.runInContext(source + '\n' + setup + '\nglobalThis.exposed = {' + exposed.join(',') + '};', context);
  return context.exposed;
}

// The real GAS app on the view fixture. runtime.get / runtime.post go through
// doGet / doPost (PIN checked, messages added like in production);
// runtime.client is a SheetsClient for core/api.js that records every call.
function appServer() {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', ...params } }).getContent());
  runtime.post = body => JSON.parse(runtime.ctx.doPost({ postData: { contents: JSON.stringify({ pin: '1234', ...body }) } }).getContent());
  runtime.calls = [];
  runtime.client = {
    get: async params => { runtime.calls.push(['GET', plain(params)]); return runtime.get(params); },
    post: async body => { runtime.calls.push(['POST', plain(body)]); return runtime.post(body); },
  };
  return runtime;
}

// core/api.js wired to the runtime (state supplies quoteCurrency).
function loadApi(runtime, state) {
  return loadModules(['app/core/api.js'], { state, SheetsClient: runtime.client }, ['ExpenseAPI']).ExpenseAPI;
}

// core/utils.js helpers that only format (fmtAsOf …), without the DOM.
function loadUtils() {
  return loadModules(['app/core/utils.js'], { el() {}, fmtDateTime: value => String(value ?? ''), todayISO() {}, nowLocalISO() {}, _exportData() {} }, ['fmtAsOf']);
}

module.exports = { loadUtils, ROOT, read, esc, flush, plain, CSS, FakeChart, fakeDom, loadModules, appServer, loadApi };
