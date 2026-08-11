// ── DOM / string ─────────────────────────────────────────────────────────────

export const el = id => document.getElementById(id);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Date ──────────────────────────────────────────────────────────────────────

export function parseLocalDate(s) {
  if (!s) return new Date(NaN);
  const parts = String(s).slice(0, 10).split('-').map(Number);
  return parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date(NaN);
}

export function fmtDate(v) {
  if (!v) return '—';
  try {
    const d = v instanceof Date ? v : parseLocalDate(String(v).slice(0, 10));
    if (isNaN(d)) return String(v).slice(0, 10) || '—';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) { return '—'; }
}

export function toDateInputVal(v) {
  if (!v) return '';
  const s = String(v).trim();
  return s.length >= 10 ? s.slice(0, 10) : '';
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowLocalISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Converts a local datetime string (datetime-local input or CSV tx_date_time) to UTC ISO.
// Strings without a timezone suffix are treated as local time by the browser's Date parser.
// Strings already ending in Z are normalised to full ISO format without re-converting.
export function localToUtcISO(s) {
  if (!s) return '';
  const d = new Date(String(s).trim());
  return isNaN(d) ? String(s) : d.toISOString();
}

// Converts a stored UTC ISO string to the value needed by <input type="datetime-local">.
// Produces YYYY-MM-DDTHH:MM in the browser's local timezone.
export function utcToLocalInput(s) {
  if (!s) return '';
  const d = new Date(String(s).trim());
  if (isNaN(d)) return String(s).slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(v) {
  if (!v) return '—';
  try {
    const d = new Date(String(v));
    if (isNaN(d)) return String(v).slice(0, 16) || '—';
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
  } catch (_) { return '—'; }
}

// ── Currency — caller supplies required data ──────────────────────────────────

export function getSymbol(currency, rates) {
  const r = rates.find(r => r.currency === currency);
  return r ? String(r.symbol || '') : (currency ? currency + ' ' : '');
}

export function toBase(amount, fromCurrency, rowFxRate, rateMap, quoteCurrency) {
  const amt = parseFloat(amount) || 0;
  const to  = rateMap[quoteCurrency];
  if (!to) return amt;
  if (rowFxRate && parseFloat(rowFxRate) > 0) return (amt / parseFloat(rowFxRate)) * to;
  const from = rateMap[fromCurrency];
  if (!from) return amt;
  return (amt / from) * to;
}

export function toQuote(amount, fromCurrency, rateMap, quoteCurrency) {
  const from = rateMap[fromCurrency];
  const to   = rateMap[quoteCurrency];
  if (!from || !to) return parseFloat(amount) || 0;
  return ((parseFloat(amount) || 0) / from) * to;
}

export function fmtBase(amount, fromCurrency, rowFxRate, rateMap, quoteCurrency, rates) {
  const val = toBase(amount, fromCurrency, rowFxRate, rateMap, quoteCurrency);
  const sym = getSymbol(quoteCurrency, rates);
  return sym + val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNative(amount, currency, rates) {
  const sym = getSymbol(currency, rates);
  const val = parseFloat(amount) || 0;
  return sym + val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtAmount(amount, currency, symbolMap) {
  const num = parseFloat(amount) || 0;
  const sym = symbolMap[currency] ?? (currency + ' ');
  return sym + num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Export / download — caller supplies filename and columns ──────────────────

export function exportData(format, rows, filename, cols) {
  if (format === 'json') {
    _download(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }), `${filename}-${todayISO()}.json`);
  } else {
    const lines = [cols.join(','), ...rows.map(row =>
      cols.map(c => '"' + String(row[c] ?? '').replace(/"/g, '""') + '"').join(',')
    )];
    _download(new Blob([lines.join('\n')], { type: 'text/csv' }), `${filename}-${todayISO()}.csv`);
  }
}

function _download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
