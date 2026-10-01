// =============================================================================
// FULCRUM FORGE — Transaction Utils: ID generation and decimal / timezone helpers
// (filter-bar suggestion lists: view-transactions.gs get_transaction_facets)
// Shared across all transaction .gs files via GAS global scope.
// =============================================================================

function generateTransactionId() {
  return Utilities.getUuid();
}

// Keep caller decimal text intact until ledger-extract rounds to currency minor units.
function transactionDecimal(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function transactionDecimalKey(value) { return decimalValueKey(value); }

function canonicalTransactionTimezone(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return ianaDateFormatter(String(value).trim()).resolvedOptions().timeZone;
}
