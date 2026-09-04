import {
  el, esc, fmtDate, fmtDateTime, parseLocalDate, toDateInputVal, todayISO, nowLocalISO,
  localToUtcISO, utcToLocalInput,
  getSymbol as _getSymbol,
  toBase    as _toBase,
  fmtBase   as _fmtBase,
  fmtNative as _fmtNative,
  exportData as _exportData,
} from '../../_shared/utils.js';
import { state } from './state.js';

export { el, esc, fmtDate, fmtDateTime, parseLocalDate, toDateInputVal, todayISO, nowLocalISO, localToUtcISO, utcToLocalInput };

export function fmtDateTimeCompact(v) {
  if (!v) return '—';
  try {
    const d = new Date(String(v));
    if (isNaN(d)) return String(v).slice(0, 16) || '—'; // computed string, not model field
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
  } catch (_) { return '—'; }
}

export const getSymbol  = currency                  => _getSymbol(currency, state.rates);
export const toBase     = (amount, from, rowFxRate) => _toBase(amount, from, rowFxRate, state.rateMap, state.quoteCurrency);
export const fmtBase    = (amount, from, rowFxRate) => _fmtBase(amount, from, rowFxRate, state.rateMap, state.quoteCurrency, state.rates);
export const fmtNative  = (amount, currency)        => _fmtNative(amount, currency, state.rates);

const ET_COLS  = [
  'tx_date_local', 'tx_timezone_local', 'tx_type', 'source_account', 'target_account',
  'user_location_area', 'user_location_city', 'user_location_country',
  'user_location_latitude', 'user_location_longitude',
  'source_amount_local', 'target_amount_local', 'major_category', 'minor_category',
  'description', 'counterparty_name', 'tx_tags', 'beneficiaries',
];
const ACC_COLS = ['account_name', 'type', 'sub_type', 'local_currency', 'opening_value_local', 'current_value_local', 'description', 'record_status'];
// SUB_COLS intentionally excludes sync fields (sync_status, sync_date, sync_notes).
// Those fields are system-internal pipeline state that would be meaningless or misleading
// on re-import — a re-imported row would always start as create-pending regardless of the
// exported sync state, so exporting them serves no purpose and could confuse callers.
// subscription_name is used instead of name so the exported CSV matches the import format.
const SUB_COLS = ['id', 'subscription_name', 'counterparty_name', 'subscription_amount_local', 'frequency', 'day_of_month', 'day_of_week',
  'source_account', 'tx_type', 'major_category', 'minor_category', 'tags', 'record_status', 'description',
  'created_at', 'subscription_start_date', 'subscription_end_date', 'updated_at'];
const CAT_COLS = [
  'tx_type_key', 'tx_type_label',
  'major_category_key', 'major_category_label',
  'minor_category_key', 'minor_category_label',
  'description', 'tag_keywords', 'counterparty_examples',
  'source_account_types', 'target_account_types',
  'source_account_mandatory', 'target_account_mandatory',
  'is_subscription_eligible', 'record_status',
];

export const exportData = (format, rows) => {
  // Build sibling map from all loaded transactions (not just the filtered rows)
  // so transfers export correctly even when only one leg is in the date range.
  const allTx = state.transactions;
  const byId  = {};
  allTx.forEach(tx => { if (tx.id) byId[tx.id] = tx; });
  const siblingMap = {};
  allTx.forEach(tx => {
    if (!tx.parent_tx_id) return;
    const parent = byId[tx.parent_tx_id];
    if (!parent) return;
    siblingMap[tx.id]     = parent;
    siblingMap[parent.id] = tx;
  });

  // Reconstruct source/target from account_id + sibling relationship.
  // Skip child rows (parent_tx_id set) — they are exported via the parent row.
  const exported = [];
  const seen = {};
  rows.forEach(tx => {
    if (tx.parent_tx_id) return; // child leg: will be handled when parent is encountered
    const acct   = (state.accountMap[tx.account_id] !== undefined && state.accountMap[tx.account_id] !== null) ? state.accountMap[tx.account_id] : null;
    const sib    = (siblingMap[tx.id] !== undefined && siblingMap[tx.id] !== null) ? siblingMap[tx.id] : null;
    const sibAcc = (sib !== null && state.accountMap[sib.account_id] !== undefined && state.accountMap[sib.account_id] !== null) ? state.accountMap[sib.account_id] : null;

    const acctName    = (acct !== null && acct.account_name !== undefined && acct.account_name !== null) ? acct.account_name : (tx.account_id !== undefined && tx.account_id !== null ? tx.account_id : '');
    const sibAccName  = (sibAcc !== null && sibAcc.account_name !== undefined && sibAcc.account_name !== null) ? sibAcc.account_name : (sib !== null && sib.account_id !== undefined && sib.account_id !== null ? sib.account_id : '');

    let source_account, target_account, source_amount, target_amount;
    if (sibAcc !== null) {
      // Transfer: parent leg determines direction
      if (tx.tx_type === 'money-out') {
        source_account = acctName;
        target_account = sibAccName;
        source_amount  = Number(tx.tx_amount);
        target_amount  = Number(sib.tx_amount);
      } else {
        source_account = sibAccName;
        target_account = acctName;
        source_amount  = Number(sib.tx_amount);
        target_amount  = Number(tx.tx_amount);
      }
    } else {
      // Non-transfer
      if (tx.tx_type === 'money-out') {
        source_account = acctName;
        target_account = '';
        source_amount  = Number(tx.tx_amount);
        target_amount  = '';
      } else {
        source_account = '';
        target_account = acctName;
        source_amount  = Number(tx.tx_amount);
        target_amount  = '';
      }
    }

    exported.push(Object.assign({}, tx, {
      tx_date_local:        utcToLocalInput(tx.tx_date_local),
      source_account,
      target_account,
      source_amount_local:  source_amount,
      target_amount_local:  target_amount,
    }));
    if (sib) seen[sib.id] = true;
  });

  return _exportData(format, exported, 'expenses', ET_COLS);
};
export const exportAccounts      = (format, rows) => _exportData(format, rows, 'accounts', ACC_COLS);
export const exportSubscriptions = (format, rows) => {
  const normalised = rows.map(r => ({ ...r, subscription_name: r.name, created_at: utcToLocalInput(r.created_at) }));
  return _exportData(format, normalised, 'subscriptions', SUB_COLS);
};
export const exportCategories    = (format, rows) => _exportData(format, rows, 'categories', CAT_COLS);

// ── Status icons (shared across all entity tables) ───────────────────────────

export function recordStatusIcon(status) {
  const wrap = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px';
  if (status === 'inactive') return `<span title="Inactive" style="${wrap};font-size:11px;color:#6b7280">●</span>`;
  if (status === 'deleted')  return `<span title="Deleted"  style="${wrap};font-size:13px">🗑️</span>`;
  if (status === 'locked')   return `<span title="Locked"   style="${wrap};font-size:13px">🔒</span>`;
  return `<span title="Active" style="${wrap};font-size:11px;color:#22c55e">●</span>`;
}

export function syncStatusIcon(status) {
  const wrap = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;font-size:13px';
  if (status === 'create-pending') return `<span title="Create pending" style="${wrap};color:#f59e0b">○</span>`;
  if (status === 'update-pending') return `<span title="Update pending" style="${wrap};color:#3b82f6">↻</span>`;
  if (status === 'in-sync')        return `<span title="In sync"        style="${wrap};color:#22c55e">✓</span>`;
  if (status === 'create-failed')  return `<span title="Create failed"  style="${wrap};color:#ef4444">✕</span>`;
  if (status === 'update-failed')  return `<span title="Update failed"  style="${wrap};color:#ef4444">⚠</span>`;
  return `<span title="Unknown" style="${wrap};color:#6b7280">?</span>`;
}

// ── Shared context menu ───────────────────────────────────────────────────────
let _ctxMenuEl  = null;
let _ctxHandler = null;

export function closeContextMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
  if (_ctxHandler) { document.removeEventListener('click', _ctxHandler, true); _ctxHandler = null; }
}

export function openContextMenu(triggerBtn, items, onSelect) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'tx-action-menu';
  menu.innerHTML = items
    .map(i => `<button class="tx-menu-item${i.cls ? ' ' + i.cls : ''}" data-key="${i.key}">${i.label}</button>`)
    .join('');
  document.body.appendChild(menu);
  _ctxMenuEl = menu;

  const r = triggerBtn.getBoundingClientRect();
  menu.style.cssText = 'position:fixed;top:0;left:0';
  const m = menu.getBoundingClientRect();
  let top  = r.bottom + 4;
  let left = r.right  - m.width;
  if (top + m.height > window.innerHeight) top = r.top - m.height - 4;
  if (left < 4) left = 4;
  menu.style.top  = `${top}px`;
  menu.style.left = `${left}px`;

  menu.addEventListener('click', e => {
    const btn = e.target.closest('[data-key]');
    if (!btn) return;
    closeContextMenu();
    onSelect(btn.dataset.key);
  });

  _ctxHandler = e => {
    if (triggerBtn.contains(e.target)) return;
    if (!(_ctxMenuEl && _ctxMenuEl.contains(e.target))) closeContextMenu();
  };
  document.addEventListener('click', _ctxHandler, true);
}

// ── CSV row parser (shared across import panels) ─────────────────────────────
// Parses a single CSV line, respecting double-quoted fields.
export function parseCsvRow(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

export async function shareSnapshot(targetEl, filename = 'snapshot.png') {
  /* global html2canvas */
  if (typeof html2canvas === 'undefined') {
    console.warn('[shareSnapshot] html2canvas not loaded');
    return;
  }
  const btn = el('homeShareBtn') ?? el('insightShareBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#111';
    const canvas  = await html2canvas(targetEl, {
      backgroundColor: bgColor,
      scale:     2,
      useCORS:   true,
      logging:   false,
      scrollX:   0,
      scrollY:   -window.scrollY,
    });
    canvas.toBlob(async blob => {
      if (!blob) return;
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (err) { if (err.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob);
      const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (err) {
    console.error('[shareSnapshot]', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📤 Share'; }
  }
}
