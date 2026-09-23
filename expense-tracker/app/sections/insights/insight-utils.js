import { state } from '../../core/state.js';
import { toBase, esc } from '../../core/utils.js';

// ── Period bounds ─────────────────────────────────────────────────────────────

export function getPeriodBounds(period, customFrom, customTo) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let from, to;

  switch (period) {
    case 'this_week': {
      const dow = today.getDay();
      from = new Date(today); from.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
      to   = new Date(from);  to.setDate(from.getDate() + 6);
      break;
    }
    case 'last_week': {
      const dow = today.getDay();
      const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
      from = new Date(mon); from.setDate(mon.getDate() - 7);
      to   = new Date(mon); to.setDate(mon.getDate() - 1);
      break;
    }
    case 'last_7':
      from = new Date(today); from.setDate(today.getDate() - 7);
      to   = today;
      break;
    case 'last_30':
      from = new Date(today); from.setDate(today.getDate() - 30);
      to   = today;
      break;
    case 'last_60':
      from = new Date(today); from.setDate(today.getDate() - 60);
      to   = today;
      break;
    case 'last_90':
      from = new Date(today); from.setDate(today.getDate() - 90);
      to   = today;
      break;
    case 'this_month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'last_month':
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to   = new Date(now.getFullYear(), now.getMonth(), 0);
      break;
    case 'last_3':
      from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'last_6':
      from = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'last_12':
      from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      from = new Date(now.getFullYear(), q * 3, 1);
      to   = new Date(now.getFullYear(), q * 3 + 3, 0);
      break;
    }
    case 'last_quarter': {
      const q  = Math.floor(now.getMonth() / 3);
      const pq = q === 0 ? 3 : q - 1;
      const yr = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
      from = new Date(yr, pq * 3, 1);
      to   = new Date(yr, pq * 3 + 3, 0);
      break;
    }
    case 'ytd':
      from = new Date(now.getFullYear(), 0, 1);
      to   = today;
      break;
    case 'last_year':
      from = new Date(now.getFullYear() - 1, 0, 1);
      to   = new Date(now.getFullYear() - 1, 11, 31);
      break;
    case 'custom':
      from = customFrom ? new Date(customFrom + 'T00:00:00') : new Date(now.getFullYear(), now.getMonth(), 1);
      to   = customTo   ? new Date(customTo   + 'T23:59:59') : today;
      break;
    default:
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = today;
  }

  const durationMs  = to.getTime() - from.getTime();
  const compareFrom = new Date(from.getTime() - durationMs - 86400000);
  const compareTo   = new Date(from.getTime() - 86400000);

  return { from, to, compareFrom, compareTo };
}

// ── Filtering ─────────────────────────────────────────────────────────────────

export function filterTxByRange(txs, from, to) {
  return txs.filter(tx => {
    const d = new Date(tx.tx_date_local);
    if (isNaN(d)) return false;
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return local >= from && local <= to;
  });
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export function groupByDay(txs) {
  const map = new Map();
  txs.forEach(tx => {
    const d = new Date(tx.tx_date_local);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  });
  return map;
}

export function groupByWeek(txs) {
  const map = new Map();
  txs.forEach(tx => {
    const d = new Date(tx.tx_date_local);
    if (isNaN(d)) return;
    const key = _isoWeekKey(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  });
  return map;
}

export function groupByMonth(txs) {
  const map = new Map();
  txs.forEach(tx => {
    const d = new Date(tx.tx_date_local);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  });
  return map;
}

export function groupByQuarter(txs) {
  const map = new Map();
  txs.forEach(tx => {
    const d = new Date(tx.tx_date_local);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  });
  return map;
}

// Build an ordered array of 'YYYY-MM' keys spanning from → to (inclusive)
export function monthRange(from, to) {
  const months = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const end    = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${_pad(cursor.getMonth() + 1)}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

// ── Monetary ──────────────────────────────────────────────────────────────────

export function sumAmountBase(txs) {
  return txs.reduce((sum, tx) => {
    const acc = state.accounts ? state.accounts.find(a => a.id === tx.account_id) : null;
    const currency = acc ? acc.account_currency_local : null;
    if (!currency) return sum;
    const v = toBase(Number(tx.tx_amount_local), currency);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);
}

export function cumulativeByDay(txs, from, to) {
  const labels = [];
  const values = [];
  const byDay  = groupByDay(txs);
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let running  = 0;

  while (cursor <= to) {
    const key = `${cursor.getFullYear()}-${_pad(cursor.getMonth() + 1)}-${_pad(cursor.getDate())}`;
    labels.push(String(cursor.getDate()));
    running += sumAmountBase(byDay.get(key) ?? []);
    values.push(running);
    cursor.setDate(cursor.getDate() + 1);
  }
  return { labels, values };
}

// ── Account balance replay ────────────────────────────────────────────────────

// Opening balances and transactions are events in the account's local timeline.
// Historical transactions before tracking start must not double-count the opening value.
function _balanceEvents(accounts, txs) {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const starts = new Map();
  const events = [];
  accounts.forEach(account => {
    const rawStart = String(account.tracking_start_date_local ?? '').trim();
    const start = rawStart === '' ? -Infinity : new Date(rawStart.replace(' ', 'T')).getTime();
    starts.set(account.id, start);
    const opening = toBase(Number(account.opening_value_local), account.account_currency_local);
    if (!Number.isNaN(start) && Number.isFinite(opening)) {
      events.push({ time: start, accountId: account.id, amount: opening });
    }
  });
  txs.forEach(tx => {
    const account = accountMap.get(tx.account_id);
    if (account === undefined || tx.record_status === 'deleted') return;
    const time = new Date(String(tx.tx_date_local).replace(' ', 'T')).getTime();
    if (!Number.isFinite(time) || !(time >= starts.get(account.id))) return;
    const native = Number(tx.tx_amount_local);
    if (!Number.isFinite(native) || native <= 0) return;
    const amount = toBase(native, account.account_currency_local);
    if (!Number.isFinite(amount)) return;
    if (tx.tx_type === 'money-in' || tx.tx_type === 'money-out') {
      events.push({ time, accountId: account.id, amount: tx.tx_type === 'money-out' ? -amount : amount });
    }
  });
  return events.sort((a, b) => a.time - b.time);
}

function _balanceSnapshots(accounts, txs, dates) {
  const events = _balanceEvents(accounts, txs);
  const balances = Object.fromEntries(accounts.map(account => [account.id, 0]));
  let eventIndex = 0;
  return dates.map(date => {
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
    while (eventIndex < events.length && events[eventIndex].time <= end) {
      const event = events[eventIndex++];
      balances[event.accountId] += event.amount;
    }
    return { ...balances };
  });
}

export function accountBalanceByMonth(accounts, txs, months) {
  const orderedMonths = [...months].sort();
  const dates = orderedMonths.map(month => {
    const [year, monthNumber] = month.split('-').map(Number);
    return new Date(year, monthNumber, 0);
  });
  const snapshots = _balanceSnapshots(accounts, txs, dates);
  return new Map(orderedMonths.map((month, index) => [month, snapshots[index]]));
}

export function computeBalancesAt(accounts, allTxs, date) {
  return new Map(Object.entries(_balanceSnapshots(accounts, allTxs, [date])[0]));
}

export function computeDailyTotalAssets(assetAccounts, allTxs, from, to) {
  const dates = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor <= to) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return _balanceSnapshots(assetAccounts, allTxs, dates)
    .map(balances => Object.values(balances).reduce((sum, amount) => sum + amount, 0));
}

// ── Country normalisation (shared by D24 and D25) ────────────────────────────

export const COUNTRY_NORM = {
  'uk': 'United Kingdom', 'gb': 'United Kingdom', 'england': 'United Kingdom',
  'us': 'United States',  'usa': 'United States',  'america': 'United States',
  'uae': 'UAE', 'in': 'India',
};

// Maps quote currency → domestic country name for D25's domestic/international split.
const _CURRENCY_COUNTRY = {
  GBP: 'United Kingdom', USD: 'United States', INR: 'India',
  AUD: 'Australia', CAD: 'Canada', CHF: 'Switzerland', SGD: 'Singapore',
  HKD: 'Hong Kong', JPY: 'Japan', NZD: 'New Zealand',
};

export function normCountry(raw) {
  if (!raw || !raw.trim()) return '';
  const t = raw.trim();
  return COUNTRY_NORM[t.toLowerCase()] || (t.charAt(0).toUpperCase() + t.slice(1));
}

export function domesticCountry() {
  return state.quoteCurrency in _CURRENCY_COUNTRY ? _CURRENCY_COUNTRY[state.quoteCurrency] : null;
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export function splitTags(txs) {
  const pairs = [];
  txs.forEach(tx => {
    const tags = String(tx.tx_tags !== undefined && tx.tx_tags !== null ? tx.tx_tags : '').split(';').map(t => t.trim()).filter(Boolean);
    const tagCount = tags.length;
    tags.forEach(tag => pairs.push({ tag, tx, tagCount }));
  });
  return pairs;
}

// ── Missing rates ─────────────────────────────────────────────────────────────

export function findMissingRates(txs, accounts) {
  const missing = new Set();
  const { rateMap, quoteCurrency } = state;
  // Currency is derived from the linked account — check account currencies only
  (accounts ?? []).forEach(acc => {
    if (acc.account_currency_local && acc.account_currency_local !== quoteCurrency && !rateMap[acc.account_currency_local]) missing.add(acc.account_currency_local);
  });
  return [...missing];
}

// ── Labels ────────────────────────────────────────────────────────────────────

export function parsePeriodLabel(period) {
  const now = new Date();
  const q   = Math.floor(now.getMonth() / 3);
  const pq  = q === 0 ? 3 : q - 1;
  const pqYr = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const map = {
    this_week:    'This week',
    last_week:    'Last week',
    last_7:       'Last 7 days',
    last_30:      'Last 30 days',
    last_60:      'Last 60 days',
    last_90:      'Last 90 days',
    this_month:   now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    last_month:   new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    last_3:       'Last 3 months',
    last_6:       'Last 6 months',
    last_12:      'Last 12 months',
    this_quarter: `Q${q + 1} ${now.getFullYear()}`,
    last_quarter: `Q${pq} ${pqYr}`,
    ytd:          `${now.getFullYear()} to date`,
    last_year:    String(now.getFullYear() - 1),
    custom:       'Custom range',
  };
  return map[period] || period;
}

export function fmtMonthKey(key) {
  const [yr, mo] = key.split('-');
  return new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

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

// ── Shared Chart.js base options ──────────────────────────────────────────────

export function baseChartOptions(sym, C) {
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
            const _py = ctx.parsed.y !== undefined ? ctx.parsed.y : (ctx.parsed.x !== undefined ? ctx.parsed.x : 0);
            const raw = _py;
            const _lbl = (ctx.dataset.label !== undefined && ctx.dataset.label !== null) ? ctx.dataset.label : '';
            return `  ${_lbl}: ${sym}${Math.abs(raw).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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
          callback: v => sym + (Math.abs(v) >= 1000 ? Math.round(Math.abs(v) / 1000) + 'k' : Math.round(Math.abs(v))),
        },
        grid:  { color: C.hair },
        border: { display: false },
      },
    },
  };
}

// ── Shared drilldown transaction table ───────────────────────────────────────

export function renderDrillTxTable(txs, sym) {
  const rows = txs.map(t => {
    const date = ((t.tx_date_local !== undefined && t.tx_date_local !== null) ? String(t.tx_date_local) : '').slice(0, 10) || '—';
    const cp   = (t.counterparty_name !== undefined && t.counterparty_name !== null && String(t.counterparty_name).trim() !== '') ? t.counterparty_name : '—';
    const cat  = (t.minor_category !== undefined && t.minor_category !== null && String(t.minor_category).trim() !== '') ? t.minor_category : (t.major_category !== undefined && t.major_category !== null && String(t.major_category).trim() !== '') ? t.major_category : '—';
    const amt  = sumAmountBase([t]);
    const amtFmt = sym + Math.abs(amt).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `<tr class="drill-row">
      <td class="drill-td drill-td-muted">${esc(date)}</td>
      <td class="drill-td">${esc(cp)}</td>
      <td class="drill-td drill-td-muted">${esc(cat)}</td>
      <td class="drill-td drill-td-num">${esc(amtFmt)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="drill-table-wrap">
      <table class="drill-table">
        <thead>
          <tr class="drill-thead-row">
            <th class="drill-th">Date</th>
            <th class="drill-th">Counterparty</th>
            <th class="drill-th">Category</th>
            <th class="drill-th drill-th-num">Amount</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="4" class="drill-empty">No transactions</td></tr>`}</tbody>
      </table>
    </div>`;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _pad(n) { return String(n).padStart(2, '0'); }

function _isoWeekKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4     = new Date(d.getFullYear(), 0, 4);
  const weekNum  = 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${_pad(weekNum)}`;
}
