// =============================================================================
// FULCRUM FORGE — Transaction Utils: ID generation and metadata
// Shared across all transaction .gs files via GAS global scope.
// =============================================================================

function generateTransactionId() {
  return Utilities.getUuid();
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
