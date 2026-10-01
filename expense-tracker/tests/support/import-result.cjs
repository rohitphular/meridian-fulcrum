// Loads the shared import-result renderer from app/core/utils.js for panel tests,
// which evaluate section files without their ES module imports.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../app/core/utils.js'), 'utf8');
const start = source.indexOf('// ── Form errors (shared by every add/edit form)');
const end = source.indexOf('export async function shareSnapshot');
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const context = vm.createContext({ esc });
const helperSource = source.slice(start, end).replace(/\bexport (?=function)/g, '');
vm.runInContext(helperSource + '\nthis.helpers = { renderImportResult, importErrorText };', context);
module.exports = () => ({ ...context.helpers });
// Creates a test context with the shared UI helpers defined inside it, so they
// resolve the test's own `el` and `esc` (clearFormError / showFormError need `el`).
module.exports.context = globals => {
  const created = vm.createContext({ esc, ...globals });
  vm.runInContext(helperSource, created);
  return created;
};
