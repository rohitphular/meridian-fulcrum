// CSV and ledger-extract share these columns. Upgrade old layouts explicitly.
const ACCOUNT_TYPE_STATUSES = ['active', 'inactive', 'deleted', 'locked'];
const ACCOUNT_TYPE_SCHEMA = {};
[
  ['id', 'ID', 'string', false, true],
  ['account_type_key', 'Account type', 'string', false, true],
  ['account_type_label', 'Account type label', 'string', true, true],
  ['account_subtype_key', 'Subtype key', 'string', false, true],
  ['account_subtype_label', 'Subtype label', 'string', true, true],
  ['description', 'Description', 'string', true, false],
  ['is_loan', 'Loan account', 'boolean', true, true],
  ['detail_sheet', 'Detail sheet', 'string', true, false],
  ['record_status', 'Status', 'enum', true, false],
  ['sync_status', 'Sync status', 'string', false, false],
  ['sync_date', 'Sync date', 'datetime', false, false],
  ['sync_notes', 'Sync notes', 'string', false, false],
  ['created_at', 'Created at', 'datetime', false, false],
  ['updated_at', 'Updated at', 'datetime', false, false],
].forEach(function(field, index) {
  ACCOUNT_TYPE_SCHEMA[field[0]] = {
    sheet_column_name: field[0], sheet_column_position: index + 1,
    ui_label: field[1], type: field[2], editable: field[3], required: field[4],
  };
});
function getAccountTypeSheetColumns() { return Object.keys(ACCOUNT_TYPE_SCHEMA); }
function accountTypeColIndex(key) { return getColIndex(ACCOUNT_TYPE_SCHEMA, key); }
function getAccountTypeDetailSheets() {
  return Object.keys(IMPORT_REGISTRY).filter(function(key) { return key !== 'account_master'; }).map(function(key) { return IMPORT_REGISTRY[key].sheet_name; });
}
function _accountTypeFamilies(rows) {
  const families = new Map();
  rows.forEach(function(row) {
    if (row.id !== '' && families.has(row.account_type_key) === false)
      families.set(row.account_type_key, { value: row.account_type_key, label: row.account_type_label });
  });
  return Array.from(families.values());
}
function getAccountTypeSchemaForClient() {
  const state = _readAccountTypeState();
  return {
    fields: Object.keys(ACCOUNT_TYPE_SCHEMA).map(function(key) {
      const field = ACCOUNT_TYPE_SCHEMA[key];
      return { key: key, label: field.ui_label, type: field.type, editable: field.editable, required: field.required };
    }),
    types: _accountTypeFamilies(state.rows), detail_sheets: getAccountTypeDetailSheets(),
    record_statuses: ACCOUNT_TYPE_STATUSES.slice(), columns: getAccountTypeSheetColumns(),
    requires_migration: state.requires_migration,
  };
}
