// =============================================================================
// FULCRUM FORGE — Category Utils
// =============================================================================

function normaliseKeywords(keywords) {
  return splitToList(keywords).map(function(k) { return k.toLowerCase(); }).join(', ');
}

function normaliseCandidates(str) {
  return splitToList(str).join(', ');
}

// Filters to only valid account type values; normalises lowercase.
function normaliseAccountTypes(str) {
  const valid = new Set(VALID_ACCOUNT_TYPES);
  return splitToList(str)
    .map(function(k) { return k.toLowerCase(); })
    .filter(function(k) { return valid.has(k); })
    .join(', ');
}
