// ── DOM / string ─────────────────────────────────────────────────────────────

export const el = id => document.getElementById(id);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Date (display and form defaults only) ─────────────────────────────────────

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowLocalISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(v) {
  if (!v) return '—';
  try {
    const d = new Date(String(v).replace(' ', 'T'));
    if (isNaN(d)) return String(v).slice(0, 16) || '—';
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
  } catch (_) { return '—'; }
}

// Currency conversion, money formatting and date-range math live on the server
// (api/fx-utils.gs, api/ledger-core.gs); views return display-ready values.

// ── Export / download — caller supplies rows, filename and columns ────────────
// Rows and columns come from the server export actions; this only serialises.

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
