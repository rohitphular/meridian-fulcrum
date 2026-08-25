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
    if (isNaN(d)) return String(v).slice(0, 16) || '—';
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
  'tx_date_time', 'tx_timezone', 'tx_type', 'source_account', 'target_account',
  'user_location_area', 'user_location_city', 'user_location_country',
  'user_location_latitude', 'user_location_longitude',
  'amount', 'currency', 'major_category', 'minor_category',
  'description', 'counterparty_name', 'tx_tags', 'beneficiaries',
];
const ACC_COLS = ['name', 'type', 'sub_type', 'currency', 'opening_value', 'current_value', 'is_active', 'description'];
const SUB_COLS = ['id', 'name', 'counterparty_name', 'amount', 'currency', 'frequency', 'day_of_month', 'day_of_week',
  'source_account', 'tx_type', 'major_category', 'minor_category', 'tags', 'is_active', 'description', 'created_at'];
const CAT_COLS = ['tx_type', 'major_category', 'minor_category', 'description', 'is_active', 'tag_keywords',
  'counterparty_examples', 'source_account_types', 'target_account_types', 'source_account_mandatory',
  'target_account_mandatory', 'workflow_type', 'is_subscription_eligible'];

export const exportData          = (format, rows) => {
  const normalised = rows.map(r => ({
    ...r,
    tx_date_time:   utcToLocalInput(r.tx_date_time),
    source_account: state.accountMap[r.source_account]?.name || r.source_account || '',
    target_account: state.accountMap[r.target_account]?.name || r.target_account || '',
  }));
  return _exportData(format, normalised, 'expenses', ET_COLS);
};
export const exportAccounts      = (format, rows) => _exportData(format, rows, 'accounts', ACC_COLS);
export const exportSubscriptions = (format, rows) => {
  const normalised = rows.map(r => ({ ...r, created_at: utcToLocalInput(r.created_at) }));
  return _exportData(format, normalised, 'subscriptions', SUB_COLS);
};
export const exportCategories    = (format, rows) => _exportData(format, rows, 'categories', CAT_COLS);

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
    if (!_ctxMenuEl?.contains(e.target)) closeContextMenu();
  };
  document.addEventListener('click', _ctxHandler, true);
}

export async function shareSnapshot(targetEl, filename = 'snapshot.png') {
  /* global html2canvas */
  if (typeof html2canvas === 'undefined') {
    console.warn('[shareSnapshot] html2canvas not loaded');
    return;
  }
  const btn = document.getElementById('homeShareBtn') || document.getElementById('insightShareBtn');
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
