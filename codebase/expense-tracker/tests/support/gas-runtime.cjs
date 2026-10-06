// Shared node-vm GAS runtime for backend tests of the view foundations.
// Stubs PropertiesService / CacheService / Utilities / SpreadsheetApp with
// in-memory fakes so data_version bumps and cache entries are observable.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const API = path.resolve(__dirname, '../../api');

function memoryProperties(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store, writes,
    service: { getScriptProperties: () => ({
      getProperty: key => (store.has(key) ? store.get(key) : null),
      setProperty: (key, value) => { writes.push([key, value]); store.set(key, String(value)); },
    }) },
  };
}

function memoryCache() {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    service: { getScriptCache: () => ({
      get: key => (store.has(key) ? store.get(key) : null),
      put: (key, value, ttl) => { puts.push({ key, bytes: Buffer.byteLength(value, 'utf8'), ttl }); store.set(key, value); },
      remove: key => store.delete(key),
    }) },
  };
}

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => row.slice()); this.reads = 0; this.writes = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getDataRange() { return { getValues: () => { this.reads++; return this.rows.map(row => row.slice()); } }; }
  setFrozenRows() {}
  appendRow(row) { this.writes++; this.rows.push(row.slice()); }
  getRange(start, column, count = 1, width = 1) {
    const write = values => {
      this.writes++;
      values.forEach((row, offset) => {
        while (this.rows.length < start + offset) this.rows.push([]);
        row.forEach((value, index) => { this.rows[start - 1 + offset][column - 1 + index] = value; });
      });
    };
    return {
      getValues: () => Array.from({ length: count }, (_, o) => Array.from({ length: width }, (_, i) => this.rows[start - 1 + o]?.[column - 1 + i] ?? '')),
      setValues: write,
      setValue: value => write([[value]]),
    };
  }
}

function spreadsheet(sheets) {
  return {
    getSheets: () => sheets,
    getSheetByName: name => sheets.find(sheet => sheet.name === name) || null,
    insertSheet: name => { const sheet = new Sheet(name); sheets.push(sheet); return sheet; },
    getSpreadsheetTimeZone: () => 'Europe/London',
  };
}

// Loads api files (default: all .gs) into one context.
function gasRuntime({ files, globals = {}, properties = {}, sheets = [] } = {}) {
  const props = memoryProperties(properties);
  const cache = memoryCache();
  const logs = [];
  const ss = spreadsheet(sheets);
  const ctx = vm.createContext({
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push('WARN ' + args.join(' ')), error: (...args) => logs.push('ERR ' + args.join(' ')) },
    PropertiesService: props.service, CacheService: cache.service,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { getUuid: () => require('node:crypto').randomUUID(), formatDate: date => date.toISOString() },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, getContent: () => text, setMimeType() { return this; } }) },
    ...globals,
  });
  const list = files || fs.readdirSync(API).filter(file => file.endsWith('.gs')).sort();
  for (const file of list) vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx, { filename: file });
  return { ctx, props, cache, logs, sheets, Sheet };
}

module.exports = { API, Sheet, gasRuntime, memoryCache, memoryProperties };
