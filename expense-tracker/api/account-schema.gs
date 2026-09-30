// =============================================================================
// FULCRUM FORGE — Account Schema: field registry
// Single source of truth for column positions, UI labels, types, and
// applicability rules. No magic column numbers anywhere else in the codebase.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Schema — 19 columns in column-position order
// Column positions are append-only — never change an existing position.
// Audit block sequence: record_status → sync_status → sync_date →
//                       sync_notes → created_at → updated_at
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNT_SCHEMA = {

  // ── Identity (column 1) ───────────────────────────────────────────────────
  id: {
    sheet_column_name:     'id',
    sheet_column_position: 1,
    ui_label:              'ID',
    type:                  'string',
    enum_values:           null,
    group:                 'system',
    applies_to:            null,
    required_for:          null,
    editable:              false, // set once on createAccount; never changed; unique per account
    default_value:         null,
  },

  // ── Core identifiers (columns 2–9) ───────────────────────────────────────
  account_name: {
    sheet_column_name:     'account_name',
    sheet_column_position: 2,
    ui_label:              'Account name',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         null,
  },
  legal_entity_name: {
    sheet_column_name:     'legal_entity_name',
    sheet_column_position: 3,
    ui_label:              'Legal entity name',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false, // set on create; immutable — represents the institution
    default_value:         '',
  },
  type: {
    sheet_column_name:     'type',
    sheet_column_position: 4,
    ui_label:              'Type',
    type:                  'enum',
    enum_values:           null, // available families come from account_types
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false,
    default_value:         null,
  },
  sub_type: {
    sheet_column_name:     'sub_type',
    sheet_column_position: 5,
    ui_label:              'Sub-type',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         '',
  },
  account_currency_local: {
    sheet_column_name:     'account_currency_local',
    sheet_column_position: 6,
    ui_label:              'Currency',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false,
    default_value:         null,
  },
  local_timezone: {
    sheet_column_name:     'local_timezone',
    sheet_column_position: 7,
    ui_label:              'Timezone',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false, // set on create from browser Intl; never user-editable
    default_value:         '',
  },
  account_opening_date_local: {
    sheet_column_name:     'account_opening_date_local',
    sheet_column_position: 8,
    ui_label:              'Opening date',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false, // set on create; immutable
    default_value:         '',
  },
  account_closing_date_local: {
    sheet_column_name:     'account_closing_date_local',
    sheet_column_position: 9,
    ui_label:              'Closing date',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              true, // set when account is closed
    default_value:         '',
  },

  // ── Values (columns 10–11) ────────────────────────────────────────────────
  opening_value_local: {
    sheet_column_name:     'opening_value_local',
    sheet_column_position: 10,
    ui_label:              'Opening value',
    type:                  'number',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         0,
  },
  // Virtual computed column — header created by schema for column ordering only;
  // never written via createAccount or updateAccount;
  // listAccounts injects the computed value at read time.
  current_value_local: {
    sheet_column_name:     'current_value_local',
    sheet_column_position: 11,
    ui_label:              'Current value',
    type:                  'number',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         0,
  },

  // ── Description (column 12) ───────────────────────────────────────────────
  description: {
    sheet_column_name:     'description',
    sheet_column_position: 12,
    ui_label:              'Notes',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },

  // ── Audit / sync (columns 13–18) ─────────────────────────────────────────
  record_status: {
    sheet_column_name:     'record_status',
    sheet_column_position: 13,
    ui_label:              'Record status',
    type:                  'enum',
    enum_values:           ['active', 'inactive', 'deleted', 'locked'],
    group:                 'system',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         'active',
  },
  sync_status: {
    sheet_column_name:     'sync_status',
    sheet_column_position: 14,
    ui_label:              'Sync status',
    type:                  'enum',
    enum_values:           ['create-pending', 'update-pending', 'in-sync', 'create-failed', 'update-failed'],
    group:                 'system',
    applies_to:            null,
    required_for:          null,
    editable:              false,
    default_value:         'create-pending',
  },
  sync_date: {
    sheet_column_name:     'sync_date',
    sheet_column_position: 15,
    ui_label:              'Sync date',
    type:                  'string',
    enum_values:           null,
    group:                 'system',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         '',
  },
  sync_notes: {
    sheet_column_name:     'sync_notes',
    sheet_column_position: 16,
    ui_label:              'Sync notes',
    type:                  'string',
    enum_values:           null,
    group:                 'system',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         '',
  },
  created_at: {
    sheet_column_name:     'created_at',
    sheet_column_position: 17,
    ui_label:              'Created at',
    type:                  'string',
    enum_values:           null,
    group:                 'system',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         null,
  },
  updated_at: {
    sheet_column_name:     'updated_at',
    sheet_column_position: 18,
    ui_label:              'Updated at',
    type:                  'string',
    enum_values:           null,
    group:                 'system',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         null,
  },

  // ── Tracking (column 19) ──────────────────────────────────────────────────
  // Date from which this account's balance is tracked in the app. opening_value_local
  // is the balance as of this date (not account_opening_date_local, which is the true
  // real-world open date). Appended here to preserve existing column positions.
  tracking_start_date_local: {
    sheet_column_name:     'tracking_start_date_local',
    sheet_column_position: 19,
    ui_label:              'Tracking start date',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false, // set on create; immutable
    default_value:         '',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_account_schema
// ─────────────────────────────────────────────────────────────────────────────

function getAccountSchemaForClient() {
  const rows = getAvailableAccountTypes();
  const byType = Object.create(null);
  const labels = Object.create(null);
  const familyLabels = Object.create(null);
  listAccountTypes().forEach(function(row) {
    labels[row.account_subtype_key] = row.account_subtype_label;
    familyLabels[row.account_type_key] = row.account_type_label;
  });
  rows.forEach(function(row) {
    if (byType[row.account_type_key] === undefined) byType[row.account_type_key] = [];
    byType[row.account_type_key].push(row.account_subtype_key);
  });
  return {
    types: Object.keys(byType).map(function(key) { return { value: key, label: familyLabels[key], group: key }; }),
    subtypes_by_type: byType,
    asset_sub_types: byType.asset === undefined ? [] : byType.asset,
    investment_sub_types: byType.investment === undefined ? [] : byType.investment,
    liability_sub_types: byType.liability === undefined ? [] : byType.liability,
    subtype_labels: labels, type_labels: familyLabels,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// Ordered column headers array — drives getOrCreateSheet() initialisation
function getAccountSheetColumns() {
  return Object.values(ACCOUNT_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

// All schema fields applicable to a given account type
function getFieldsForAccountType(type) {
  return Object.keys(ACCOUNT_SCHEMA)
    .filter(function(key) {
      const f = ACCOUNT_SCHEMA[key];
      return f.applies_to === null || f.applies_to.indexOf(type) !== -1;
    })
    .map(function(key) { return Object.assign({ key: key }, ACCOUNT_SCHEMA[key]); });
}

function getAccountSchemaField(key) { return ACCOUNT_SCHEMA[key] !== undefined ? ACCOUNT_SCHEMA[key] : null; }

function acctColIndex(name) { return getColIndex(ACCOUNT_SCHEMA, name); }

// True if type is a liability (stored with negative value)
function isLiabilityType(type) {
  return type === 'liability';
}
