// =============================================================================
// FULCRUM FORGE — Computed insights: read pre-computed insight payloads
// =============================================================================

const COMPUTED_INSIGHTS_COLUMNS = [
  'computed_at', 'insight_id', 'period_key', 'derived_from',
  'chart_variant', 'insight_payload', 'expert_commentary',
];

function getComputedInsights(params) {
  const insightId    = params.insight_id    || '';
  const periodKey    = params.period_key    || '';
  const derivedFrom  = params.derived_from  || 'default';
  const chartVariant = params.chart_variant || '';

  if (!insightId) return { ok: false, error: 'missing_insight_id' };
  if (!periodKey) return { ok: false, error: 'missing_period_key' };

  const sheet = getOrCreateSheet(COMPUTED_INSIGHTS_SHEET, COMPUTED_INSIGHTS_COLUMNS);
  const rows  = sheetToObjects(sheet);

  const matching = rows.filter(r =>
    r.insight_id    === insightId    &&
    r.period_key    === periodKey    &&
    r.derived_from  === derivedFrom  &&
    r.chart_variant === chartVariant
  );

  if (!matching.length) return { ok: false, error: 'not_computed' };

  // Most recent row wins
  matching.sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)));
  const row = matching[0];

  let data;
  try {
    data = JSON.parse(row.insight_payload);
  } catch (_) {
    return { ok: false, error: 'payload_parse_error' };
  }

  return {
    ok:         true,
    computed_at: row.computed_at,
    commentary:  row.expert_commentary || '',
    data,
  };
}
