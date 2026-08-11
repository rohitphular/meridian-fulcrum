// =============================================================================
// FULCRUM FORGE — Category Schema: field registry
// Single source of truth for column positions, UI labels, types, and groups.
// No magic column numbers anywhere else in the codebase.
// Depends on: VALID_TRANSACTION_TYPES (transaction-schema.gs),
//             VALID_ACCOUNT_TYPES (account-schema.gs)
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Schema — 13 fields in column-position order
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_SCHEMA = {

  // ── Core (columns 1–5, all types) ─────────────────────────────────────────
  tx_type: {
    sheet_column_name: 'tx_type',
    sheet_column_position: 1,
    ui_label: 'Type',
    type: 'enum',
    enum_values: null, // resolved at runtime: VALID_TRANSACTION_TYPES
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: 'money-out',
  },
  major_category: {
    sheet_column_name: 'major_category',
    sheet_column_position: 2,
    ui_label: 'Major category',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: '',
  },
  minor_category: {
    sheet_column_name: 'minor_category',
    sheet_column_position: 3,
    ui_label: 'Minor category',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: '',
  },
  description: {
    sheet_column_name: 'description',
    sheet_column_position: 4,
    ui_label: 'Description',
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
    sheet_column_position: 5,
    ui_label: 'Active',
    type: 'boolean',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: true,
    default_value: true,
  },

  // ── Classification (columns 6–7) ──────────────────────────────────────────
  tag_keywords: {
    sheet_column_name: 'tag_keywords',
    sheet_column_position: 6,
    ui_label: 'Tag keywords',
    type: 'string',
    enum_values: null,
    group: 'classification',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  counterparty_examples: {
    sheet_column_name: 'counterparty_examples',
    sheet_column_position: 7,
    ui_label: 'Counterparty examples',
    type: 'string',
    enum_values: null,
    group: 'classification',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },

  // ── Account hints (columns 8–11) ─────────────────────────────────────────
  // source_account_types / target_account_types: comma-separated account
  // type values used to filter the respective account dropdowns.
  // source_account_mandatory / target_account_mandatory: when true the field
  // is enabled and required; when false the field is visible but disabled
  // (shows "External").
  source_account_types: {
    sheet_column_name: 'source_account_types',
    sheet_column_position: 8,
    ui_label: 'Source account types',
    type: 'multi-select',
    enum_values: null, // resolved at runtime: VALID_ACCOUNT_TYPES
    group: 'account_hints',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },
  target_account_types: {
    sheet_column_name: 'target_account_types',
    sheet_column_position: 9,
    ui_label: 'Target account types',
    type: 'multi-select',
    enum_values: null, // resolved at runtime: VALID_ACCOUNT_TYPES
    group: 'account_hints',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: '',
  },

  source_account_mandatory: {
    sheet_column_name:     'source_account_mandatory',
    sheet_column_position: 10,
    ui_label:              'Source account mandatory',
    type:                  'boolean',
    enum_values:           null,
    group:                 'account_hints',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },
  target_account_mandatory: {
    sheet_column_name:     'target_account_mandatory',
    sheet_column_position: 11,
    ui_label:              'Target account mandatory',
    type:                  'boolean',
    enum_values:           null,
    group:                 'account_hints',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },

  // ── Meta (columns 12–13) ─────────────────────────────────────────────────
  workflow_type: {
    sheet_column_name: 'workflow_type',
    sheet_column_position: 12,
    ui_label: 'Workflow type',
    type: 'enum',
    enum_values: ['account-credit', 'account-debit', 'funds-transfer', 'forex-transfer', 'debt-repayment'],
    group: 'meta',
    applies_to: null,
    required_for: [],
    editable: true,
    default_value: null,
  },
  is_subscription_eligible: {
    sheet_column_name:     'is_subscription_eligible',
    sheet_column_position: 13,
    ui_label:              'Subscription eligible',
    type:                  'boolean',
    enum_values:           null,
    group:                 'meta',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_category_schema
// ─────────────────────────────────────────────────────────────────────────────
function getCategorySchemaForClient() {
  return {
    types: VALID_TRANSACTION_TYPES.map(function(v) {
      const labels = { 'money-in': 'Money In', 'money-out': 'Money Out', 'money-transfer': 'Transfer' };
      return { value: v, label: labels[v] || v };
    }),
    account_types: VALID_ACCOUNT_TYPES.map(function(v) {
      const labels = { asset: 'Asset', investment: 'Investment', liability: 'Liability' };
      const groups = { asset: 'asset', investment: 'investment', liability: 'liability' };
      return { value: v, label: labels[v] || v, group: groups[v] || v };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

function getFieldsForCategoryType(type) {
  return Object.keys(CATEGORY_SCHEMA).map(function(key) {
    const f = CATEGORY_SCHEMA[key];
    return { key: key, editable: f.editable, required: f.required_for === null };
  }).filter(function(f) {
    const schema = CATEGORY_SCHEMA[f.key];
    return schema.applies_to === null || schema.applies_to === type;
  });
}

function getCategorySheetColumns() {
  return Object.values(CATEGORY_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

function getCategorySchemaField(key) {
  return CATEGORY_SCHEMA[key] || null;
}

function catColIndex(name) { return getColIndex(CATEGORY_SCHEMA, name); }
