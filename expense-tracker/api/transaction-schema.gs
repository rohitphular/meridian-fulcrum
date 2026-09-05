// =============================================================================
// FULCRUM FORGE — Transaction Schema: field registry
// Single source of truth for column positions, UI labels, types, groups,
// and applicability rules. No magic column numbers anywhere else in the codebase.
//
// Storage model: one row per account movement.
//   account_id      — the single account involved in this row
//   tx_amount_local — the amount moved (always positive; direction from tx_type)
//   parent_tx_id — blank for standalone/root; set on derived rows pointing to parent.id
//                  Enables chains: money-out parent → money-in child (transfer),
//                  or any future multi-leg derivation regardless of tx_type.
//
// Currency is NOT stored — derived at runtime from the account's currency field.
// Column block order: identity → core → financial → categorisation → location → audit
// Audit block sequence: record_status → sync_status → sync_date →
//                       sync_notes → created_at → updated_at
// =============================================================================

const VALID_TRANSACTION_TYPES = ['money-in', 'money-out'];

// Schema — 24 fields in column-position order
const TRANSACTION_SCHEMA = {

  // ── Identity (column 1) ──────────────────────────────────────────────────
  id: {
    sheet_column_name: 'id',
    sheet_column_position: 1,
    ui_label: 'ID',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: null,
  },

  // ── Core (columns 2–6) ───────────────────────────────────────────────────
  tx_date_local: {
    sheet_column_name: 'tx_date_local',
    sheet_column_position: 2,
    ui_label: 'Date/Time',
    type: 'date',
    group: 'core',
    editable: true,
    default_value: null,
  },
  tx_timezone_local: {
    sheet_column_name: 'tx_timezone_local',
    sheet_column_position: 3,
    ui_label: 'Timezone',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: '',
  },
  parent_tx_id: {
    sheet_column_name: 'parent_tx_id',
    sheet_column_position: 4,
    ui_label: 'Parent Tx',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: '',
  },
  tx_type: {
    sheet_column_name: 'tx_type',
    sheet_column_position: 5,
    ui_label: 'Type',
    type: 'enum',
    enum_values: VALID_TRANSACTION_TYPES,
    group: 'core',
    editable: true,
    default_value: null,
  },
  account_id: {
    sheet_column_name: 'account_id',
    sheet_column_position: 6,
    ui_label: 'Account',
    type: 'string',
    group: 'core',
    editable: true,
    default_value: null,
  },

  // ── Financial (column 7) ─────────────────────────────────────────────────
  tx_amount_local: {
    sheet_column_name: 'tx_amount_local',
    sheet_column_position: 7,
    ui_label: 'Amount',
    type: 'number',
    group: 'core',
    editable: true,
    default_value: null,
  },

  // ── Categorisation (columns 8–13) ───────────────────────────────────────
  major_category: {
    sheet_column_name: 'major_category',
    sheet_column_position: 8,
    ui_label: 'Category',
    type: 'string',
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    editable: true,
    default_value: '',
  },
  minor_category: {
    sheet_column_name: 'minor_category',
    sheet_column_position: 9,
    ui_label: 'Sub-category',
    type: 'string',
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    editable: true,
    default_value: '',
  },
  description: {
    sheet_column_name: 'description',
    sheet_column_position: 10,
    ui_label: 'Description',
    type: 'string',
    group: 'categorisation',
    editable: true,
    default_value: '',
  },
  counterparty_name: {
    sheet_column_name: 'counterparty_name',
    sheet_column_position: 11,
    ui_label: 'Counterparty',
    type: 'string',
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    editable: true,
    default_value: '',
  },
  tx_tags: {
    sheet_column_name: 'tx_tags',
    sheet_column_position: 12,
    ui_label: 'Tags',
    type: 'string',
    group: 'categorisation',
    editable: true,
    default_value: '',
  },
  beneficiaries: {
    sheet_column_name: 'beneficiaries',
    sheet_column_position: 13,
    ui_label: 'Beneficiaries',
    type: 'string',
    group: 'categorisation',
    editable: true,
    default_value: '',
  },

  // ── Location (columns 14–18) ─────────────────────────────────────────────
  user_location_area: {
    sheet_column_name: 'user_location_area',
    sheet_column_position: 14,
    ui_label: 'Area',
    type: 'string',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_city: {
    sheet_column_name: 'user_location_city',
    sheet_column_position: 15,
    ui_label: 'City',
    type: 'string',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_country: {
    sheet_column_name: 'user_location_country',
    sheet_column_position: 16,
    ui_label: 'Country',
    type: 'string',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_latitude: {
    sheet_column_name: 'user_location_latitude',
    sheet_column_position: 17,
    ui_label: 'Latitude',
    type: 'number',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_longitude: {
    sheet_column_name: 'user_location_longitude',
    sheet_column_position: 18,
    ui_label: 'Longitude',
    type: 'number',
    group: 'location',
    editable: true,
    default_value: '',
  },

  // ── Audit block (columns 19–24) ──────────────────────────────────────────
  record_status: {
    sheet_column_name: 'record_status',
    sheet_column_position: 19,
    ui_label: 'Record Status',
    type: 'enum',
    enum_values: ['active', 'inactive', 'deleted', 'locked'],
    group: 'system',
    editable: false,
    default_value: 'active',
  },
  sync_status: {
    sheet_column_name: 'sync_status',
    sheet_column_position: 20,
    ui_label: 'Sync Status',
    type: 'enum',
    enum_values: ['create-pending', 'update-pending', 'in-sync', 'create-failed', 'update-failed'],
    group: 'system',
    editable: false,
    default_value: 'create-pending',
  },
  sync_date: {
    sheet_column_name: 'sync_date',
    sheet_column_position: 21,
    ui_label: 'Sync date',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: '',
  },
  sync_notes: {
    sheet_column_name: 'sync_notes',
    sheet_column_position: 22,
    ui_label: 'Sync Notes',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: '',
  },
  created_at: {
    sheet_column_name: 'created_at',
    sheet_column_position: 23,
    ui_label: 'Created At',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: null,
  },
  updated_at: {
    sheet_column_name: 'updated_at',
    sheet_column_position: 24,
    ui_label: 'Updated At',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_transaction_schema
// ─────────────────────────────────────────────────────────────────────────────
function getTransactionSchemaForClient() {
  const TYPE_LABELS = {
    'money-in':  'Money In',
    'money-out': 'Money Out',
  };
  return {
    types: VALID_TRANSACTION_TYPES.map(function(v) {
      return { value: v, label: TYPE_LABELS[v] !== undefined ? TYPE_LABELS[v] : v };
    }),
    categorisation_fields: Object.keys(TRANSACTION_SCHEMA).filter(function(key) {
      return TRANSACTION_SCHEMA[key].group === 'categorisation';
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

function getTransactionSheetColumns() {
  return Object.values(TRANSACTION_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

function getFieldsForTransactionType(type) {
  return Object.keys(TRANSACTION_SCHEMA)
    .filter(function(key) {
      const f = TRANSACTION_SCHEMA[key];
      return !f.applies_to || f.applies_to.indexOf(type) !== -1;
    })
    .map(function(key) { return Object.assign({ key: key }, TRANSACTION_SCHEMA[key]); });
}

function getTransactionSchemaField(key) {
  return TRANSACTION_SCHEMA[key] !== undefined ? TRANSACTION_SCHEMA[key] : null;
}

function txColIndex(name) { return getColIndex(TRANSACTION_SCHEMA, name); }
