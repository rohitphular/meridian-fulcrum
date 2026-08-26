// =============================================================================
// FULCRUM FORGE — Transaction Utils: ID generation and balance adjustment
// Shared across all transaction .gs files via GAS global scope.
// =============================================================================

function generateTransactionId(sheet, date) {
  const dateStr = String(date).slice(0, 10);
  const values  = sheet.getDataRange().getValues();
  let max = 0;

  for (let i = 1; i < values.length; i++) {
    const rowId = String(values[i][0]);
    if (rowId.startsWith(dateStr + '-')) {
      const n = parseInt(rowId.slice(dateStr.length + 1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }

  return dateStr + '-' + String(max + 1).padStart(3, '0');
}

// T-03 fail-closed: return { ok, error } so misses are observable.
//
// Contract: NEW account refs (the ones being saved in this request) are
// preflight-checked by the validator. They MUST exist. If they don't,
// the validator refuses before this function is reached.
//
// OLD account refs (read from the stored row during update Phase 1 or delete)
// are NOT preflight-checked — they may have been manually removed from the
// sheet. This function returns ok:false in that case; callers tolerate it
// (log + continue) so the stored transaction remains editable/deletable.
//
// Either way, this function never throws — the result object plus the
// console.log below are the visibility mechanism.
function adjustAccountBalance(accountId, delta) {
  const sheet           = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const values          = sheet.getDataRange().getValues();
  const accountIdColIdx = getAccountSchemaField('id').sheet_column_position - 1;
  const balanceColIdx   = getAccountSchemaField('current_value').sheet_column_position - 1;
  const balanceColNum   = getAccountSchemaField('current_value').sheet_column_position;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][accountIdColIdx]) !== String(accountId)) continue;
    const current = Number(values[i][balanceColIdx]) || 0;
    sheet.getRange(i + 1, balanceColNum).setValue(current + delta);
    return { ok: true };
  }
  console.warn('adjustAccountBalance: account_not_found id=' + accountId + ' delta=' + delta);
  return { ok: false, error: 'account_not_found:' + accountId };
}

function getTransactionMetadata() {
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const rows  = sheetToObjectsWithRow(sheet);

  const distinct = function(values) {
    return Array.from(new Set(values.filter(function(v) { return v && String(v).trim() !== ''; })))
      .map(function(v) { return String(v).trim(); })
      .sort();
  };

  const countries      = distinct(rows.map(function(tx) { return tx.user_location_country; }));
  const cities         = distinct(rows.map(function(tx) { return tx.user_location_city; }));
  const areas          = distinct(rows.map(function(tx) { return tx.user_location_area; }));
  const counterparties = distinct(rows.map(function(tx) { return tx.counterparty_name; }));

  const allTags = [];
  rows.forEach(function(tx) {
    if (!tx.tx_tags) return;
    String(tx.tx_tags).split(';').forEach(function(t) {
      const trimmed = t.trim();
      if (trimmed) allTags.push(trimmed);
    });
  });
  const tags = distinct(allTags);

  return { ok: true, countries: countries, cities: cities, areas: areas, counterparties: counterparties, tags: tags };
}
