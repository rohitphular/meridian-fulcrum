import { state } from './state.js';
import { parseLocalDate } from './utils.js';

export function getRangeBounds() {
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = now.getMonth();
  const today = new Date(y, m, now.getDate());

  switch (state.dateRange) {
    case 'last_30':     return { from: new Date(y, m, now.getDate() - 29), to: today };
    case 'this_month':  return { from: new Date(y, m, 1),    to: today };
    case 'last_month':  return { from: new Date(y, m-1, 1),  to: new Date(y, m, 0) };
    case 'last_3':      return { from: new Date(y, m-2, 1),  to: today };
    case 'last_6':      return { from: new Date(y, m-5, 1),  to: today };
    case 'last_12':     return { from: new Date(y, m-11, 1), to: today };
    case 'ytd':         return { from: new Date(y, 0, 1),    to: today };
    case 'all':         return { from: new Date(2000, 0, 1), to: today };
    case 'custom': {
      const from = (state.customFrom !== undefined && state.customFrom !== null && state.customFrom !== '') ? parseLocalDate(state.customFrom) : new Date(2000, 0, 1);
      const to   = (state.customTo   !== undefined && state.customTo   !== null && state.customTo   !== '') ? parseLocalDate(state.customTo)   : today;
      return { from: Number.isFinite(from.getTime()) ? from : new Date(2000, 0, 1), to: Number.isFinite(to.getTime()) ? to : today };
    }
    default: return { from: new Date(y, m, now.getDate() - 29), to: today };
  }
}

export function txInRange(tx) {
  const { from, to } = getRangeBounds();
  const raw = tx.tx_date_time;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return true;
  const localDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return localDate >= from && localDate <= to;
}

export function filteredTx() {
  const f = state.filters;
  return state.transactions.filter(tx => {
    if (!txInRange(tx)) return false;
    if (f.types.length    && !f.types.includes(tx.tx_type))                                                     return false;
    if (f.accounts.length && !f.accounts.includes(tx.account_id))                          return false;
    if (f.major.length    && !f.major.includes(tx.major_category))                        return false;
    if (f.minor.length    && !f.minor.includes(tx.minor_category))                        return false;
    if (f.user_location_country && !String(tx.user_location_country !== undefined && tx.user_location_country !== null ? tx.user_location_country : '').toLowerCase().includes(f.user_location_country.toLowerCase())) return false;
    if (f.user_location_city    && !String(tx.user_location_city    !== undefined && tx.user_location_city    !== null ? tx.user_location_city    : '').toLowerCase().includes(f.user_location_city.toLowerCase()))    return false;
    if (f.user_location_area    && !String(tx.user_location_area    !== undefined && tx.user_location_area    !== null ? tx.user_location_area    : '').toLowerCase().includes(f.user_location_area.toLowerCase()))    return false;
    if (f.tag !== undefined && f.tag !== null && f.tag !== '') {
      const tags = String((tx.tx_tags !== undefined && tx.tx_tags !== null) ? tx.tx_tags : '').split(';').map(t => t.trim().toLowerCase()).filter(v => v !== '');
      if (!tags.some(t => t.includes(f.tag.toLowerCase()))) return false;
    }
    if (f.search !== undefined && f.search !== null && f.search !== '') {
      const q           = f.search.toLowerCase();
      const acctEntry   = (state.accountMap[tx.account_id] !== undefined && state.accountMap[tx.account_id] !== null) ? state.accountMap[tx.account_id] : {};
      const _acctName   = (acctEntry.name !== undefined && acctEntry.name !== null) ? acctEntry.name : '';
      const hay         = [tx.counterparty_name, tx.description, _acctName].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
