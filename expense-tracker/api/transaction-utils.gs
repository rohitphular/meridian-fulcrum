// =============================================================================
// FULCRUM FORGE — Transaction Utils: ID generation and metadata
// Shared across all transaction .gs files via GAS global scope.
// =============================================================================

function generateTransactionId(sheet, date) {
  const dateStr    = String(date).slice(0, 10);
  const SEQ_PATTERN = new RegExp('^\\d{4}-\\d{2}-\\d{2}-\\d{3}$');
  const values     = sheet.getDataRange().getValues();
  let max = 0;

  for (let i = 1; i < values.length; i++) {
    const rowId = String(values[i][0]);
    // T-H5: only consider sequential-format IDs (YYYY-MM-DD-NNN).
    // Bulk IDs (YYYY-MM-DD-XXXXXXXX) are hex and must not feed the sequence counter.
    if (!SEQ_PATTERN.test(rowId)) continue;
    if (rowId.startsWith(dateStr + '-')) {
      const n = parseInt(rowId.slice(dateStr.length + 1), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }

  return dateStr + '-' + String(max + 1).padStart(3, '0');
}

function getTransactionMetadata() {
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const rows  = sheetToObjectsWithRow(sheet);

  const distinct = function(values) {
    return Array.from(new Set(values.filter(function(v) { return v !== undefined && v !== null && String(v).trim() !== ''; })))
      .map(function(v) { return String(v).trim(); })
      .sort();
  };

  const nonDeleted = rows.filter(function(tx) { return tx.record_status !== 'deleted'; });

  const countries      = distinct(nonDeleted.map(function(tx) { return tx.user_location_country; }));
  const cities         = distinct(nonDeleted.map(function(tx) { return tx.user_location_city; }));
  const areas          = distinct(nonDeleted.map(function(tx) { return tx.user_location_area; }));
  const counterparties = distinct(nonDeleted.map(function(tx) { return tx.counterparty_name; }));

  const allTags = [];
  nonDeleted.forEach(function(tx) {
    if (tx.tx_tags === undefined || tx.tx_tags === null) return;
    String(tx.tx_tags).split(';').forEach(function(t) {
      const trimmed = t.trim();
      if (trimmed !== '') allTags.push(trimmed);
    });
  });
  const tags = distinct(allTags);

  return { ok: true, countries: countries, cities: cities, areas: areas, counterparties: counterparties, tx_tags: tags };
}
