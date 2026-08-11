// =============================================================================
// FULCRUM FORGE — Subscription Schema: field registry
// Single source of truth for column positions, UI labels, types, and
// applicability rules. No magic column numbers anywhere else in the codebase.
// =============================================================================

const VALID_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annual'];

// ─────────────────────────────────────────────────────────────────────────────
// Schema — 16 fields in column-position order
// Column positions are append-only — never change an existing position.
// ─────────────────────────────────────────────────────────────────────────────
const SUBSCRIPTION_SCHEMA = {

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
  name: {
    sheet_column_name: 'name',
    sheet_column_position: 2,
    ui_label: 'Name',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  counterparty_name: {
    sheet_column_name: 'counterparty_name',
    sheet_column_position: 3,
    ui_label: 'Counterparty',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  amount: {
    sheet_column_name: 'amount',
    sheet_column_position: 4,
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
    sheet_column_position: 5,
    ui_label: 'Currency',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  frequency: {
    sheet_column_name: 'frequency',
    sheet_column_position: 6,
    ui_label: 'Frequency',
    type: 'enum',
    enum_values: VALID_FREQUENCIES,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  day_of_month: {
    sheet_column_name: 'day_of_month',
    sheet_column_position: 7,
    ui_label: 'Day of Month',
    type: 'number',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  day_of_week: {
    sheet_column_name: 'day_of_week',
    sheet_column_position: 8,
    ui_label: 'Day of Week',
    type: 'number',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  source_account: {
    sheet_column_name: 'source_account',
    sheet_column_position: 9,
    ui_label: 'Source Account',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: null,
  },
  tx_type: {
    sheet_column_name: 'tx_type',
    sheet_column_position: 10,
    ui_label: 'Type',
    type: 'enum',
    enum_values: ['money-in', 'money-out', 'money-transfer'],
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  major_category: {
    sheet_column_name: 'major_category',
    sheet_column_position: 11,
    ui_label: 'Major Category',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  minor_category: {
    sheet_column_name: 'minor_category',
    sheet_column_position: 12,
    ui_label: 'Minor Category',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  tags: {
    sheet_column_name: 'tags',
    sheet_column_position: 13,
    ui_label: 'Tags',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  is_active: {
    sheet_column_name: 'is_active',
    sheet_column_position: 14,
    ui_label: 'Status',
    type: 'boolean',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: true,
  },
  description: {
    sheet_column_name: 'description',
    sheet_column_position: 15,
    ui_label: 'Notes',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  created_at: {
    sheet_column_name: 'created_at',
    sheet_column_position: 16,
    ui_label: 'Created At',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: false,
    default_value: null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_subscription_schema
// ─────────────────────────────────────────────────────────────────────────────

function getSubscriptionSchemaForClient() {
  return {
    frequencies: VALID_FREQUENCIES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// Ordered column headers array — drives getOrCreateSheet() initialisation
function getSubscriptionSheetColumns() {
  return Object.values(SUBSCRIPTION_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

function getSubscriptionSchemaField(key) { return SUBSCRIPTION_SCHEMA[key] || null; }

function subColIndex(key) { return getColIndex(SUBSCRIPTION_SCHEMA, key); }

function getFieldsForSubscriptionType(type) {
  return Object.keys(SUBSCRIPTION_SCHEMA).map(function(key) {
    const f = SUBSCRIPTION_SCHEMA[key];
    return { key: key, editable: f.editable, required: f.required_for === null };
  }).filter(function(f) {
    const schema = SUBSCRIPTION_SCHEMA[f.key];
    return schema.applies_to === null || schema.applies_to === type;
  });
}
