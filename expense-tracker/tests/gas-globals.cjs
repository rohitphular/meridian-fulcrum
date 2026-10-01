// All api/*.gs files share one GAS global namespace: a duplicate top-level
// function silently overrides another, and a duplicate const/let fails at load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const API = path.resolve(__dirname, '../api');

test('no two api/*.gs files declare the same top-level function, const, let or var', () => {
  const seen = new Map();
  const duplicates = [];
  for (const file of fs.readdirSync(API).filter(name => name.endsWith('.gs')).sort()) {
    const source = fs.readFileSync(path.join(API, file), 'utf8');
    for (const match of source.matchAll(/^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm)) {
      const name = match[1] || match[2];
      if (seen.has(name)) duplicates.push(name + ' (' + seen.get(name) + ', ' + file + ')');
      else seen.set(name, file);
    }
  }
  assert.deepEqual(duplicates, []);
  assert.ok(seen.size > 100, 'scanner found the project globals');
});
