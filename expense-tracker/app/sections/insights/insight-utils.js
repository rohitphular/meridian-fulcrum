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
    const d = new Date(tx.tx_date_time);
    if (isNaN(d)) return false;
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return local >= from && local <= to;
  });
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export function groupByDay(txs) {
  const map = new Map();
  txs.forEach(tx => {
    const d = new Date(tx.tx_date_time);
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
    const d = new Date(tx.tx_date_time);
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
    const d = new Date(tx.tx_date_time);
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
    const d = new Date(tx.tx_date_time);
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
    const v = toBase(tx.amount, tx.currency, tx.fx_rate);
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
    running += sumAmountBase(byDay.get(key) || []);
    values.push(running);
    cursor.setDate(cursor.getDate() + 1);
  }
  return { labels, values };
}

// ── Account balance replay ────────────────────────────────────────────────────

export function accountBalanceByMonth(accounts, txs, months) {
  const result = new Map();
  months.forEach(m => result.set(m, {}));

  accounts.forEach(acc => {
    let balance = Number(acc.opening_value) || 0;
    const accTxs = txs
      .filter(tx => tx.source_account === acc.id || tx.target_account === acc.id)
      .sort((a, b) => new Date(a.tx_date_time) - new Date(b.tx_date_time));

    let txIdx = 0;
    months.forEach(monthKey => {
      const [yr, mo] = monthKey.split('-').map(Number);
      const endOfMonth = new Date(yr, mo, 0, 23, 59, 59);

      while (txIdx < accTxs.length) {
        const d = new Date(accTxs[txIdx].tx_date_time);
        if (d > endOfMonth) break;
        const tx  = accTxs[txIdx];
        const amt = toBase(tx.amount, tx.currency, tx.fx_rate);
        if (tx.source_account === acc.id) balance -= (isNaN(amt) ? 0 : amt);
        if (tx.target_account === acc.id) balance += (isNaN(amt) ? 0 : amt);
        txIdx++;
      }
      result.get(monthKey)[acc.id] = balance;
    });
  });
  return result;
}

// ── Per-account balance at a single point in time ────────────────────────────
// Single O(T) pass over sorted transactions; returns Map<accountId, balance>.
// More efficient than calling computeDailyTotalAssets once per account.

export function computeBalancesAt(accounts, allTxs, date) {
  const dateEnd    = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const accountIds = new Set(accounts.map(a => a.id));
  const balance    = {};
  accounts.forEach(a => {
    balance[a.id] = toBase(Number(a.opening_value) || 0, a.currency, null);
  });

  const sorted = [...allTxs].sort(
    (a, b) => new Date(a.tx_date_time) - new Date(b.tx_date_time)
  );

  for (const tx of sorted) {
    if (new Date(tx.tx_date_time) > dateEnd) break;
    const amt = toBase(Number(tx.amount) || 0, tx.currency, tx.fx_rate);
    if (tx.tx_type === 'money-out' && accountIds.has(tx.source_account)) {
      balance[tx.source_account] = (balance[tx.source_account] || 0) - amt;
    } else if (tx.tx_type === 'money-in' && accountIds.has(tx.target_account)) {
      balance[tx.target_account] = (balance[tx.target_account] || 0) + amt;
    } else if (tx.tx_type === 'money-transfer') {
      if (accountIds.has(tx.source_account)) balance[tx.source_account] = (balance[tx.source_account] || 0) - amt;
      if (accountIds.has(tx.target_account)) balance[tx.target_account] = (balance[tx.target_account] || 0) + amt;
    }
  }

  return new Map(Object.entries(balance));
}

// ── Daily total asset balance replay ─────────────────────────────────────────
//
// Replays ALL transactions chronologically from each account's opening_value,
// returning one total-asset-value entry per calendar day in [from, to].
// Used by MoM, YoY, WoW and Net Worth insights.

export function computeDailyTotalAssets(assetAccounts, allTxs, from, to) {
  const accountIds = new Set(assetAccounts.map(a => a.id));
  const balance    = {};
  assetAccounts.forEach(a => {
    balance[a.id] = toBase(Number(a.opening_value) || 0, a.currency, null);
  });

  const sorted = [...allTxs].sort(
    (a, b) => new Date(a.tx_date_time) - new Date(b.tx_date_time)
  );
  const daysInPeriod = Math.round((to - from) / 86400000) + 1;
  const dailyTotals  = [];
  let txIdx          = 0;
  const cursor       = new Date(from.getFullYear(), from.getMonth(), from.getDate());

  for (let d = 0; d < daysInPeriod; d++) {
    const endOfDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 23, 59, 59, 999);
    while (txIdx < sorted.length) {
      const txDate = new Date(sorted[txIdx].tx_date_time);
      if (txDate > endOfDay) break;
      const tx  = sorted[txIdx];
      const amt = toBase(Number(tx.amount) || 0, tx.currency, tx.fx_rate);
      if (tx.tx_type === 'money-out' && accountIds.has(tx.source_account)) {
        balance[tx.source_account] = (balance[tx.source_account] || 0) - amt;
      } else if (tx.tx_type === 'money-in' && accountIds.has(tx.target_account)) {
        balance[tx.target_account] = (balance[tx.target_account] || 0) + amt;
      } else if (tx.tx_type === 'money-transfer') {
        if (accountIds.has(tx.source_account)) balance[tx.source_account] = (balance[tx.source_account] || 0) - amt;
        if (accountIds.has(tx.target_account)) balance[tx.target_account] = (balance[tx.target_account] || 0) + amt;
      }
      txIdx++;
    }
    dailyTotals.push(Object.values(balance).reduce((s, v) => s + v, 0));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dailyTotals;
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
  return _CURRENCY_COUNTRY[state.quoteCurrency] || null;
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export function splitTags(txs) {
  const pairs = [];
  txs.forEach(tx => {
    const tags = String(tx.tags || '').split(';').map(t => t.trim()).filter(Boolean);
    const tagCount = tags.length;
    tags.forEach(tag => pairs.push({ tag, tx, tagCount }));
  });
  return pairs;
}

// ── Missing rates ─────────────────────────────────────────────────────────────

export function findMissingRates(txs, accounts) {
  const missing = new Set();
  const { rateMap, quoteCurrency } = state;
  txs.forEach(tx => {
    if (tx.currency && tx.currency !== quoteCurrency && !rateMap[tx.currency]) missing.add(tx.currency);
  });
  (accounts || []).forEach(acc => {
    if (acc.currency && acc.currency !== quoteCurrency && !rateMap[acc.currency]) missing.add(acc.currency);
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
            const raw = ctx.parsed.y ?? ctx.parsed.x ?? 0;
            return `  ${ctx.dataset.label || ''}: ${sym}${Math.abs(raw).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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
    const date = (t.tx_date_time || '').slice(0, 10) || '—';
    const cp   = t.counterparty_name || '—';
    const cat  = t.minor_category || t.major_category || '—';
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
