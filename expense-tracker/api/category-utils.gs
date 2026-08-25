// =============================================================================
// FULCRUM FORGE — Category Utils
// =============================================================================

function normaliseKeywords(keywords) {
  return splitToList(keywords).map(function(k) { return k.toLowerCase(); }).join(', ');
}

function normaliseCandidates(str) {
  return splitToList(str).join(', ');
}

// Filters to only valid category account type hint values; normalises lowercase.
// Valid values are asset sub-types, 'investment' (top-level type shorthand for all
// investment accounts), and liability sub-types — NOT the top-level VALID_ACCOUNT_TYPES.
function normaliseAccountTypes(str) {
  const valid = new Set(
    ASSET_SUB_TYPES.concat(['investment']).concat(LIABILITY_SUB_TYPES)
  );
  return splitToList(str)
    .map(function(k) { return k.toLowerCase(); })
    .filter(function(k) { return valid.has(k); })
    .join(', ');
}
