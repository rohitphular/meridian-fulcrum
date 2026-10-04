import {
  el, esc, fmtDateTime, todayISO, nowLocalISO,
  exportData as _exportData,
} from '../../_shared/utils.js';

export { el, esc, fmtDateTime, todayISO, nowLocalISO };

export function fmtDateTimeCompact(v) {
  if (!v) return '—';
  try {
    const d = new Date(String(v).replace(' ', 'T'));
    if (isNaN(d)) return String(v).slice(0, 16) || '—'; // computed string, not model field
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
  } catch (_) { return '—'; }
}

// published_at (a UTC ISO timestamp from the analytics job) in the browser's
// local timezone: '30 Sep, 07:00'. '' when missing or unreadable.
export function fmtAsOf(iso) {
  if (typeof iso !== 'string' || iso === '') return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

// Subscription / category exports download the rows of their list view
// (page_size=all); these column lists are the import contracts.
// Preserve the complete Sheet contract and original audit timestamps on export.
// Import accepts metadata columns but the server owns their values.
const SUB_COLS = ['id', 'subscription_name', 'counterparty_name', 'subscription_amount_local', 'frequency', 'day_of_month', 'day_of_week',
  'source_account', 'tx_type', 'major_category', 'minor_category', 'description', 'record_status', 'created_at',
  'sync_status', 'sync_date', 'sync_notes', 'updated_at',
  'subscription_start_date_local', 'subscription_end_date_local', 'subscription_timezone_local'];
const CAT_COLS = [
  'id',
  'tx_type_key', 'tx_type_label',
  'major_category_key', 'major_category_label',
  'minor_category_key', 'minor_category_label',
  'description', 'tag_keywords', 'counterparty_examples',
  'source_account_types', 'target_account_types',
  'source_account_mandatory', 'target_account_mandatory',
  'is_subscription_eligible', 'record_status',
];

// Server export actions (export_transactions, export_accounts,
// export_account_types) return { filename, columns, rows }: the browser only
// downloads them (transfer reconstruction and the lossy-transfer guard live in
// api/view-transactions.gs; account / account type columns in the view files).
export const downloadExport      = (format, data) => _exportData(format, data.rows, data.filename, data.columns);
export const exportSubscriptions = (format, rows) => _exportData(format, rows, 'subscription_master', SUB_COLS);
export const exportCategories    = (format, rows) => _exportData(format, rows, 'category_master', CAT_COLS);

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

// ── Form errors (shared by every add/edit form) ─────────────────────────────
// The server validates; forms show its message and mark the field it names.
export function clearFormError(errEl) {
  if (errEl === null || errEl === undefined) return;
  errEl.textContent = '';
  (errEl.closest?.('.card') ?? errEl.parentElement)?.querySelectorAll('.field.error').forEach(field => field.classList.remove('error'));
}

export function showFormError(errEl, res, fieldIds = {}) {
  if (errEl === null || errEl === undefined) return;
  errEl.textContent = typeof res?.message === 'string' && res.message !== '' ? res.message : importErrorText(res?.error);
  const input = typeof res?.field === 'string' && fieldIds[res.field] !== undefined ? el(fieldIds[res.field]) : null;
  input?.closest?.('.field')?.classList.add('error');
}

// ── Import results (shared by every CSV import panel) ───────────────────────
// The server parses and validates uploads; panels only render its response.
export function importErrorText(code) {
  const text = String(code ?? 'unknown_error').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

export function renderImportResult(response, { message = importErrorText, filename = '', notice = '' } = {}) {
  const prefix = filename === '' ? '' : `${esc(filename)} · `;
  const results = Array.isArray(response?.results) ? response.results : [];
  if (response?.ok !== true && results.length === 0) {
    const errors = Array.isArray(response?.errors) ? response.errors : [];
    const list = errors.length === 0 ? '' : `<ul class="pin-error import-result-errors">${errors.map(error => `<li>${esc(error)}</li>`).join('')}</ul>`;
    const detail = [response?.field, response?.referenced_count === undefined ? '' : `${response.referenced_count} references`].filter(value => value !== undefined && value !== null && value !== '').join(' · ');
    const text = message(response?.error, response);
    const outcome = /nothing was (imported|saved|written)/i.test(text) ? '' : ' Nothing was imported.';
    return `<div class="import-result"><p class="pin-error" role="alert">${prefix}${esc(text)}${detail === '' ? '' : ` (${esc(detail)})`}${outcome}</p>${list}</div>`;
  }
  const count = action => results.filter(result => result?.ok === true && result.action === action).length;
  const failures = results.filter(result => result?.ok !== true);
  const created = response.created ?? count('created');
  const updated = response.updated ?? count('updated');
  const skipped = response.skipped ?? 0;
  const summary = `${prefix}${created} created · ${updated} updated${skipped > 0 ? ` · ${skipped} unchanged` : ''} · ${failures.length} failed`;
  const details = result => [result.label, result.field, Array.isArray(result.invalid_values) ? result.invalid_values.join(', ') : result.invalid_values, result.key]
    .filter(value => value !== undefined && value !== null && value !== '').join(' · ');
  const table = failures.length === 0 ? '' : `<div class="table-wrap"><table><thead><tr><th>CSV line</th><th>Error</th><th>Details</th></tr></thead><tbody>${failures.map(result =>
    `<tr><td class="td-mono">${esc(result.line ?? '—')}</td><td class="import-result-reason">${esc(message(result.error, result))}<div class="td-mono td-muted">${esc(result.error ?? '')}</div></td><td>${esc(details(result))}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="import-result"><p class="cat-count">${summary}</p>${notice}${table}</div>`;
}

export async function shareSnapshot(targetEl, filename = 'snapshot.png') {
  /* global html2canvas */
  if (typeof html2canvas === 'undefined') {
    console.warn('[shareSnapshot] html2canvas not loaded');
    return;
  }
  const btn = el('homeShareBtn') ?? el('reportShareBtn');
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
