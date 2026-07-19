const test = require('node:test');
const assert = require('node:assert/strict');

const { csvCell, toCsv, parseCsv } = require('../src/utils/csv');

test('csvCell quotes cells containing commas, quotes, or newlines', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('csvCell neutralizes spreadsheet formula injection', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('+1234'), "'+1234");
  assert.equal(csvCell('-1234'), "'-1234");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('normal text'), 'normal text');
});

test('csvCell handles null/undefined as empty string', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('toCsv joins header and rows with CRLF', () => {
  const csv = toCsv(['a', 'b'], [['1', '2'], ['3', '4']]);
  assert.equal(csv, 'a,b\r\n1,2\r\n3,4');
});

test('parseCsv round-trips a simple table', () => {
  const rows = parseCsv('name,price\nJollof,25\nWaakye,20\n');
  assert.deepEqual(rows, [['name', 'price'], ['Jollof', '25'], ['Waakye', '20']]);
});

test('parseCsv handles quoted fields with embedded commas and escaped quotes', () => {
  const rows = parseCsv('name,description\n"Jollof, Special","Say ""hi"" to spice"\n');
  assert.deepEqual(rows, [
    ['name', 'description'],
    ['Jollof, Special', 'Say "hi" to spice']
  ]);
});

test('parseCsv handles CRLF line endings and trailing blank lines', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parseCsv on empty input returns no rows', () => {
  assert.deepEqual(parseCsv(''), []);
});
