const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ctx = vm.createContext({});
const plain = value => JSON.parse(JSON.stringify(value));
vm.runInContext(fs.readFileSync(path.join(__dirname, '../api/csv-import.gs'), 'utf8'), ctx);

test('CSV records keep quoted commas, escaped quotes and embedded newlines, with physical line numbers', () => {
  const parsed = ctx.parseCsvRecords('﻿id,description\r\n1,"Line one\nLine two, ""quoted"""\n\n2,plain\n');
  assert.deepEqual(Array.from(parsed.errors), []);
  assert.deepEqual(plain(parsed.records.map(record => [record.line, record.values])), [
    [1, ['id', 'description']], [2, ['1', 'Line one\nLine two, "quoted"']], [5, ['2', 'plain']],
  ]);
});

test('malformed quoting is reported with its line and yields no records', () => {
  assert.match(ctx.parseCsvRecords('a,b\n1,"open').errors[0], /Row 2: a quoted CSV field is not closed/);
  assert.match(ctx.parseCsvRecords('a,b\n1,"x"y').errors[0], /Row 2: invalid characters after a quoted CSV field/);
  assert.equal(ctx.parseCsvRecords('a,b\n1,"x"y').records.length, 0);
});

test('imports normalise headers, trim cells and attach CSV lines; file-level problems return a code', () => {
  const parsed = ctx.parseCsvImport({ csv: ' Account Name ,Amount\n  Bank , 10.50 \n"Multi\nline",2' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(Array.from(parsed.headers), ['account_name', 'amount']);
  assert.deepEqual(plain(parsed.rows), [{ _line: 2, account_name: 'Bank', amount: '10.50' }, { _line: 3, account_name: 'Multi\nline', amount: '2' }]);
  assert.equal(ctx.parseCsvImport({}).error, 'missing_csv');
  assert.equal(ctx.parseCsvImport({ csv: '  ' }).error, 'missing_csv');
  assert.equal(ctx.parseCsvImport({ csv: 'a,b' }).error, 'csv_has_no_rows');
  assert.equal(ctx.parseCsvImport({ csv: 'a,a\n1,2' }).error, 'invalid_csv_headers');
  assert.equal(ctx.parseCsvImport({ csv: 'a,\n1,2' }).error, 'invalid_csv_headers');
  const counts = ctx.parseCsvImport({ csv: 'a,b\n1\n2,3,4' });
  assert.equal(counts.error, 'invalid_csv_rows');
  assert.deepEqual(Array.from(counts.errors), ['Row 2: expected 2 columns, found 1.', 'Row 3: expected 2 columns, found 3.']);
  assert.equal(ctx.isDryRun({ dry_run: true }), true);
  assert.equal(ctx.isDryRun({ dry_run: 'true' }), false);
});
