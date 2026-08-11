// =============================================================================
// FULCRUM FORGE — Transaction Schema: field registry
// Single source of truth for column positions, UI labels, types, groups,
// and applicability rules. No magic column numbers anywhere else in the codebase.
// =============================================================================

const VALID_TRANSACTION_TYPES = ['money-in', 'money-out', 'money-transfer'];

// ─────────────────────────────────────────────────────────────────────────────
// Schema — 16 fields in column-position order
// ─────────────────────────────────────────────────────────────────────────────
const TRANSACTION_SCHEMA = {

  // ── Core (columns 1–5) ────────────────────────────────────────────────────
  id: {
    sheet_column_name: 'id',
    sheet_column_position: 1,
    ui_label: 'ID',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: false,
    default_value: null,
  },
  tx_date_time: {
    sheet_column_name: 'tx_date_time',
    sheet_column_position: 2,
    ui_label: 'Date/Time',
    type: 'date',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  tx_type: {
    sheet_column_name: 'tx_type',
    sheet_column_position: 3,
    ui_label: 'Type',
    type: 'enum',
    enum_values: VALID_TRANSACTION_TYPES,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  source_account: {
    sheet_column_name: 'source_account',
    sheet_column_position: 4,
    ui_label: 'Source Account',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  target_account: {
    sheet_column_name: 'target_account',
    sheet_column_position: 5,
    ui_label: 'Target Account',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: '',
  },

  // ── Location (columns 6–8) ────────────────────────────────────────────────
  tx_location_area: {
    sheet_column_name: 'tx_location_area',
    sheet_column_position: 6,
    ui_label: 'Area',
    type: 'string',
    enum_values: null,
    group: 'location',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  tx_location_city: {
    sheet_column_name: 'tx_location_city',
    sheet_column_position: 7,
    ui_label: 'City',
    type: 'string',
    enum_values: null,
    group: 'location',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  tx_location_country: {
    sheet_column_name: 'tx_location_country',
    sheet_column_position: 8,
    ui_label: 'Country',
    type: 'string',
    enum_values: null,
    group: 'location',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },

  // ── Core continued (columns 9–11) ─────────────────────────────────────────
  amount: {
    sheet_column_name: 'amount',
    sheet_column_position: 9,
    ui_label: 'Amount',
    type: 'number',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  currency: {
    sheet_column_name: 'currency',
    sheet_column_position: 10,
    ui_label: 'Currency',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  fx_rate: {
    sheet_column_name: 'fx_rate',
    sheet_column_position: 11,
    ui_label: 'FX Rate',
    type: 'number',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },

  // ── Categorisation (columns 12–15) ────────────────────────────────────────
  major_category: {
    sheet_column_name: 'major_category',
    sheet_column_position: 12,
    ui_label: 'Category',
    type: 'string',
    enum_values: null,
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    required_for: [],
    editable: true,
    default_value: '',
  },
  minor_category: {
    sheet_column_name: 'minor_category',
    sheet_column_position: 13,
    ui_label: 'Sub-category',
    type: 'string',
    enum_values: null,
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    required_for: [],
    editable: true,
    default_value: '',
  },
  tags: {
    sheet_column_name: 'tags',
    sheet_column_position: 14,
    ui_label: 'Tags',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  counterparty_name: {
    sheet_column_name: 'counterparty_name',
    sheet_column_position: 15,
    ui_label: 'Counterparty',
    type: 'string',
    enum_values: null,
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    required_for: [],
    editable: true,
    default_value: '',
  },

  // ── Core continued (column 16) ────────────────────────────────────────────
  description: {
    sheet_column_name: 'description',
    sheet_column_position: 16,
    ui_label: 'Description',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_transaction_schema
// ─────────────────────────────────────────────────────────────────────────────
function getTransactionSchemaForClient() {
  const TYPE_LABELS = {
    'money-in':       'Money In',
    'money-out':      'Money Out',
    'money-transfer': 'Transfer',
  };
  return {
    types: VALID_TRANSACTION_TYPES.map(function(v) {
      return { value: v, label: TYPE_LABELS[v] || v };
    }),
    categorisation_fields: Object.keys(TRANSACTION_SCHEMA).filter(function(key) {
      return TRANSACTION_SCHEMA[key].group === 'categorisation';
    }),
    transfer_fields: Object.keys(TRANSACTION_SCHEMA).filter(function(key) {
      const f = TRANSACTION_SCHEMA[key];
      return f.group === 'transfer' && f.editable;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// Ordered column headers array — drives getOrCreateSheet() initialisation
function getTransactionSheetColumns() {
  return Object.values(TRANSACTION_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

// All schema fields applicable to a given transaction type
function getFieldsForTransactionType(type) {
  return Object.keys(TRANSACTION_SCHEMA)
    .filter(function(key) {
      const f = TRANSACTION_SCHEMA[key];
      return f.applies_to === null || f.applies_to.indexOf(type) !== -1;
    })
    .map(function(key) { return Object.assign({ key: key }, TRANSACTION_SCHEMA[key]); });
}

// Single field entry by key
function getTransactionSchemaField(key) {
  return TRANSACTION_SCHEMA[key] || null;
}

function txColIndex(name) { return getColIndex(TRANSACTION_SCHEMA, name); }
