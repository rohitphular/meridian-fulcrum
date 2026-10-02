const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
let uuid = 0;
const ctx = vm.createContext({ console: { log() {} }, Utilities: { getUuid: () => 'ABCDEF00-0000-4000-8000-' + String(++uuid).padStart(12, '0') } });
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

test('fill_csv_ids adds a lowercase UUID to blank ids only and keeps every other byte', () => {
  const source = '\uFEFFid,description,amount\r\nkeep-1,"Line one\nLine, two",10.50\r\n,plain,1\r\n  ,"q ""x""",2\r\n';
  const result = ctx.fillCsvIds({ csv: source });
  assert.equal(result.ok, true);
  assert.equal(result.filled, 2);
  assert.equal(result.csv, '\uFEFFid,description,amount\r\nkeep-1,"Line one\nLine, two",10.50\r\nabcdef00-0000-4000-8000-000000000001,plain,1\r\nabcdef00-0000-4000-8000-000000000002,"q ""x""",2\r\n');
  const untouched = 'id,a\nx,1';
  assert.equal(ctx.fillCsvIds({ csv: untouched }).csv, untouched);
  assert.equal(ctx.fillCsvIds({ csv: untouched }).filled, 0);
  assert.equal(ctx.fillCsvIds({ csv: 'name,a\n,1' }).id_column, false);
  assert.equal(ctx.fillCsvIds({ csv: 'id,a\n"open' }).error, 'invalid_csv');
  assert.equal(ctx.fillCsvIds({}).error, 'missing_csv');
});

test('fill_csv_ids pads a short row that stops before the id column and fills its id', () => {
  const result = ctx.fillCsvIds({ csv: 'name,amount,id,note\nRent,10\nFood\nKept,5,keep-1,x\n' });
  assert.equal(result.ok, true);
  assert.equal(result.filled, 2);
  const lines = result.csv.split('\n');
  assert.match(lines[1], /^Rent,10,[0-9a-f-]{36}$/);
  assert.match(lines[2], /^Food,,[0-9a-f-]{36}$/);
  assert.equal(lines[3], 'Kept,5,keep-1,x');
  // The filled ids stick: a second pass finds nothing to fill.
  assert.equal(ctx.fillCsvIds({ csv: result.csv }).filled, 0);
});
