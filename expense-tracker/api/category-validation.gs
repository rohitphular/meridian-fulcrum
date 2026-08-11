// =============================================================================
// FULCRUM FORGE — Category Validation
// All validation is driven by CATEGORY_SCHEMA (category-schema.gs).
// =============================================================================

function validateCategoryCreate(body) {
  const type = String(body.tx_type || '').trim();
  if (VALID_TRANSACTION_TYPES.indexOf(type) === -1)
    return { ok: false, error: 'invalid_transaction_type' };
  if (!String(body.major_category || '').trim()) return { ok: false, error: 'missing_major_category' };
  if (!String(body.minor_category || '').trim()) return { ok: false, error: 'missing_minor_category' };
  const wfType = String(body.workflow_type || '').trim();
  if (!wfType) return { ok: false, error: 'missing_workflow_type' };
  if (VALID_WORKFLOW_TYPES.indexOf(wfType) === -1) return { ok: false, error: 'invalid_workflow_type' };
  return { ok: true };
}

function validateCategoryUpdate(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const type = String(body.tx_type || '').trim();
  if (VALID_TRANSACTION_TYPES.indexOf(type) === -1)
    return { ok: false, error: 'invalid_transaction_type' };
  if (!String(body.major_category || '').trim()) return { ok: false, error: 'missing_major_category' };
  if (!String(body.minor_category || '').trim()) return { ok: false, error: 'missing_minor_category' };
  const wfType = String(body.workflow_type || '').trim();
  if (!wfType) return { ok: false, error: 'missing_workflow_type' };
  if (VALID_WORKFLOW_TYPES.indexOf(wfType) === -1) return { ok: false, error: 'invalid_workflow_type' };
  return { ok: true };
}
