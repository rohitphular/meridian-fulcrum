// Chart theme and presentation helpers for Home and Reports.
// Chart configuration and display formatting only: every number and label
// comes from the server (get_home_view / get_report payloads, already converted
// to the display currency by GAS); nothing is computed here.
// ── CSS colors (read at render time — picks up dark/light theme) ──────────────

export function getCssColors() {
  const s   = getComputedStyle(document.documentElement);
  const get = v => s.getPropertyValue(v).trim();
  return {
    teal:    get('--teal'),
    ember:   get('--ember'),
    muted:   get('--muted'),
    ink:     get('--ink'),
    hair:    get('--hair'),
    panel:   get('--panel'),
    mono:    get('--mono') || "'IBM Plex Mono', monospace",
    grotesk: get('--grotesk') || "'Space Grotesk', sans-serif",
  };
}

export const PREV_PERIOD_COLOR = '#f59e0b';

export function buildPalette(C) {
  return [C.teal, PREV_PERIOD_COLOR, C.ember, '#8b5cf6', '#3b82f6', '#10b981', '#f97316', C.muted];
}

// Server tone / style keys → colours (the only colour decisions on the client).
export function toneColor(tone, C) {
  switch (tone) {
    case 'positive':  return '#34d399';
    case 'negative':  return '#f87171';
    case 'warn':      return '#f59e0b';
    case 'muted':     return C.hair;
    case 'highlight': return 'rgba(52,211,153,1)';
    case 'primary':   return C.teal;
    default:          return C.ink;
  }
}

export function styleColor(style, C, index = 0) {
  const palette = buildPalette(C);
  if (typeof style === 'string' && style.startsWith('palette:')) return palette[Number(style.slice(8)) % palette.length];
  switch (style) {
    case 'compare':   return PREV_PERIOD_COLOR;
    case 'income':    return '#34d399';
    case 'expense':   return '#f87171';
    case 'savings':   return '#60a5fa';
    case 'asset':     return C.teal;
    case 'liability': return C.ember;
    case 'muted':     return C.muted;
    case 'palette':   return palette[index % palette.length];
    default:          return C.teal;
  }
}

// ── Value formatting (display only) ───────────────────────────────────────────

function _num(value, decimals) {
  return Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Formats a server value by its format key (contract/report-payload.md FORMAT).
// 'local' is an amount in an account's own currency (never converted): with the
// row's currency code when the caller has one, else a plain number.
export function fmtValue(value, format, sym, currency = '') {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' && format !== 'month' && format !== 'date') return value;
  const n = Number(value);
  switch (format) {
    case 'money':         return (n < 0 ? '−' : '') + sym + _num(n, 0);
    case 'money2':        return (n < 0 ? '−' : '') + sym + _num(n, 2);
    case 'money_delta':   return (n < 0 ? '−' : '+') + sym + _num(n, 0);
    case 'local':         return (n < 0 ? '−' : '') + _num(n, 2) + (currency ? ' ' + currency : '');
    case 'percent':
    case 'progress':      return (n < 0 ? '−' : '') + _num(n, 1) + '%';
    case 'percent_delta': return (n < 0 ? '−' : '+') + _num(n, 1) + '%';
    case 'count':         return Number.isFinite(n) ? n.toLocaleString('en-GB') : String(value);
    case 'days':          return Number.isFinite(n) ? `${n} day${n === 1 ? '' : 's'}` : String(value);
    case 'month':         return fmtMonthKey(String(value));
    case 'date':          return fmtDateKey(String(value));
    default:              return String(value);
  }
}

// Text with values: { text: 'Down {0} on last month', values: [{ value, format }] }
// → the text with each {n} replaced by its formatted value. A plain string is
// returned as is. The result is plain text: callers esc() it.
export function fmtText(text, sym) {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'object') return String(text);
  const values = Array.isArray(text.values) ? text.values : [];
  return String(text.text ?? '').replace(/\{(\d+)\}/g, (match, index) => {
    const item = values[Number(index)];
    return item === undefined ? match : fmtValue(item?.value, item?.format, sym);
  });
}

// Axis tick text for a format key.
export function fmtTick(value, format, sym) {
  const n = Number(value);
  if (format === 'percent' || format === 'percent_delta') return Math.round(n) + '%';
  if (format === 'count') return String(Math.round(n));
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1000) return sign + sym + Math.round(abs / 1000) + 'k';
  // money2 axes (per-day rates) keep pence below 100 so small ticks stay distinct.
  if (format === 'money2' && abs < 100) return sign + sym + abs.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  return sign + sym + Math.round(abs);
}

// 'YYYY-MM-DD' (UTC calendar date) → '30 Sep 2026'.
export function fmtDateKey(key) {
  const [yr, mo, dy] = key.split('-').map(Number);
  if (!yr || !mo || !dy) return key;
  return new Date(Date.UTC(yr, mo - 1, dy)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtMonthKey(key) {
  const [yr, mo] = key.split('-');
  return new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

// ── Shared Chart.js base options ──────────────────────────────────────────────

export function baseChartOptions(sym, C, format = 'money') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: C.ink, font: { size: 13 }, boxWidth: 14, padding: 12 },
      },
      tooltip: {
        backgroundColor: C.panel,
        borderColor: C.hair, borderWidth: 1,
        titleColor: C.muted,
        bodyColor: C.ink,
        callbacks: {
          label: ctx => {
            const raw = ctx.parsed.y !== undefined ? ctx.parsed.y : (ctx.parsed.x !== undefined ? ctx.parsed.x : 0);
            const lbl = (ctx.dataset.label !== undefined && ctx.dataset.label !== null) ? ctx.dataset.label : '';
            if (format === 'money') return `  ${lbl}: ${sym}${Math.abs(raw).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
            return `  ${lbl}: ${fmtValue(raw, format, sym)}`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: C.muted, font: { size: 12 }, maxRotation: 0, maxTicksLimit: 8 },
        grid:  { color: C.hair },
        border: { display: false },
      },
      y: {
        ticks: {
          color: C.muted, font: { size: 12 }, maxTicksLimit: 5,
          callback: v => (format === 'money'
            ? sym + (Math.abs(v) >= 1000 ? Math.round(Math.abs(v) / 1000) + 'k' : Math.round(Math.abs(v)))
            : fmtTick(v, format, sym)),
        },
        grid:  { color: C.hair },
        border: { display: false },
      },
    },
  };
}
