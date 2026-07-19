/**
 * Minimal CSV helpers shared by every export/import route.
 */

/** Escape one cell: quote if it contains a delimiter/quote/newline, and
 * neutralize spreadsheet formula injection (Excel/Sheets execute cells
 * starting with = + - @ or a leading tab/CR). */
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

/**
 * Parse RFC4180-ish CSV text into an array of row arrays (no header
 * handling — callers zip the first row against expected columns
 * themselves). Handles quoted fields, escaped quotes (""), and both
 * \r\n and \n line endings.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

module.exports = { csvCell, toCsv, parseCsv };
