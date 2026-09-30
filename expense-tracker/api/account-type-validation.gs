function _accountTypeText(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function _accountTypeKey(value) { return _accountTypeText(value).replace(/_/g, '-'); }
function _accountTypeRowIsBlank(row) {
  return getAccountTypeSheetColumns().every(function(key) { return _accountTypeText(row[key]) === ''; });
}
function validateAccountTypeCreate(body, requireId, legacy) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_row' };
  for (const field of ['account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'detail_sheet', 'record_status']) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') return { ok: false, error: 'invalid_' + field };
  }
  const id = _accountTypeText(body.id);
  if (requireId && id === '') return { ok: false, error: 'missing_id' };
  if (id !== '' && (typeof body.id !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) === false))
    return { ok: false, error: 'invalid_id' };
  for (const field of ['account_type_key', 'account_subtype_key']) {
    const key = legacy ? _accountTypeKey(body[field]) : _accountTypeText(body[field]);
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) === false) return { ok: false, error: 'invalid_' + field };
  }
  for (const field of ['account_type_label', 'account_subtype_label']) {
    if (_accountTypeText(body[field]) === '') return { ok: false, error: 'missing_' + field };
  }
  if (!legacy && _accountTypeText(body.detail_sheet) !== '' && getAccountTypeDetailSheets().indexOf(body.detail_sheet) === -1)
    return { ok: false, error: 'invalid_detail_sheet' };
  const status = _accountTypeText(body.record_status);
  if (status !== '' && ACCOUNT_TYPE_STATUSES.indexOf(status) === -1) return { ok: false, error: 'invalid_record_status' };
  return { ok: true };
}
function _validateAccountTypeIdentities(rows, legacy) {
  const ids = new Set();
  const pairs = new Set();
  const subtypes = new Set();
  const labels = new Map();
  for (const row of rows) {
    if (_accountTypeRowIsBlank(row)) continue;
    const validation = validateAccountTypeCreate(row, true, legacy);
    if (validation.ok === false) return validation;
    const type = _accountTypeKey(row.account_type_key);
    const subtype = _accountTypeKey(row.account_subtype_key);
    const pair = type + '|' + subtype;
    if (ids.has(row.id.toLowerCase())) return { ok: false, error: 'duplicate_account_type_id' };
    if (pairs.has(pair)) return { ok: false, error: 'duplicate_account_type' };
    if (subtypes.has(subtype)) return { ok: false, error: 'duplicate_account_subtype_key' };
    if (labels.has(type) && labels.get(type) !== row.account_type_label) return { ok: false, error: 'inconsistent_account_type_label' };
    ids.add(row.id.toLowerCase()); pairs.add(pair); subtypes.add(subtype); labels.set(type, row.account_type_label);
  }
  if (Array.from(subtypes).some(function(key) { return labels.has(key); })) return { ok: false, error: 'reserved_account_subtype_key' };
  return { ok: true };
}
function _validateAccountTypeReplacement(previous, replacement, migrating) {
  for (const field of ['id', 'account_type_key', 'account_subtype_key']) {
    const expected = migrating && field !== 'id' ? _accountTypeKey(previous[field]) : previous[field];
    if (expected !== replacement[field]) return { ok: false, error: 'field_not_editable', field: field };
  }
  if (previous.record_status === 'locked') {
    if (replacement.record_status === 'deleted') return { ok: false, error: 'record_locked' };
    for (const field of ['account_type_label', 'account_subtype_label', 'description', 'detail_sheet']) {
      if (migrating && previous[field] === undefined) continue;
      if (previous[field] !== replacement[field]) return { ok: false, error: 'record_locked' };
    }
  }
  if (previous.detail_sheet !== undefined && previous.detail_sheet !== replacement.detail_sheet) {
    const count = _countAccountTypeReferences(previous, true);
    if (count > 0) return { ok: false, error: 'account_type_in_use', referenced_count: count };
  }
  if (replacement.record_status === 'inactive' || replacement.record_status === 'deleted') {
    const count = _countAccountTypeReferences(previous);
    if (count > 0) return { ok: false, error: 'account_type_in_use', referenced_count: count };
  }
  return { ok: true };
}
