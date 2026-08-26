// =============================================================================
// FULCRUM FORGE — Category Schema: field registry
// Single source of truth for column positions, UI labels, types, and groups.
// No magic column numbers anywhere else in the codebase.
// Depends on: VALID_ACCOUNT_TYPES (account-schema.gs)
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Slug helper — used by createCategory / createCategoriesBulk to derive keys
// ─────────────────────────────────────────────────────────────────────────────
function slugify(str) {
  return String(str).toLowerCase()
    .replace(/[&\/]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema — 17 fields in column-position order
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_SCHEMA = {

  // ── Core identifiers (columns 1–6) ────────────────────────────────────────
  tx_type_key: {
    sheet_column_name:     'tx_type_key',
    sheet_column_position: 1,
    ui_label:              'Type',
    type:                  'enum',
    enum_values:           ['money-in', 'money-out'],
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         'money-out',
  },
  tx_type_label: {
    sheet_column_name:     'tx_type_label',
    sheet_column_position: 2,
    ui_label:              'Type label',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false, // derived; never written by user
    default_value:         '',
  },
  major_category_key: {
    sheet_column_name:     'major_category_key',
    sheet_column_position: 3,
    ui_label:              'Major category key',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false, // derived slug
    default_value:         '',
  },
  major_category_label: {
    sheet_column_name:     'major_category_label',
    sheet_column_position: 4,
    ui_label:              'Major category',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         '',
  },
  minor_category_key: {
    sheet_column_name:     'minor_category_key',
    sheet_column_position: 5,
    ui_label:              'Minor category key',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false, // derived slug
    default_value:         '',
  },
  minor_category_label: {
    sheet_column_name:     'minor_category_label',
    sheet_column_position: 6,
    ui_label:              'Minor category',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         '',
  },

  // ── Description & status (columns 7–8) ───────────────────────────────────
  description: {
    sheet_column_name:     'description',
    sheet_column_position: 7,
    ui_label:              'Description',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },
  record_status: {
    sheet_column_name:     'record_status',
    sheet_column_position: 8,
    ui_label:              'Record status',
    type:                  'enum',
    enum_values:           ['active', 'inactive', 'deleted'],
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         'active',
  },

  // ── Classification (columns 9–10) ─────────────────────────────────────────
  tag_keywords: {
    sheet_column_name:     'tag_keywords',
    sheet_column_position: 9,
    ui_label:              'Tag keywords',
    type:                  'string',
    enum_values:           null,
    group:                 'classification',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },
  counterparty_examples: {
    sheet_column_name:     'counterparty_examples',
    sheet_column_position: 10,
    ui_label:              'Counterparty examples',
    type:                  'string',
    enum_values:           null,
    group:                 'classification',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },

  // ── Account hints (columns 11–14) ─────────────────────────────────────────
  // source_account_types / target_account_types: comma-separated account
  // type values used to filter the respective account dropdowns.
  // source_account_mandatory / target_account_mandatory: when true the field
  // is enabled and required; when false the field is visible but disabled
  // (shows "External").
  source_account_types: {
    sheet_column_name:     'source_account_types',
    sheet_column_position: 11,
    ui_label:              'Source account types',
    type:                  'multi-select',
    enum_values:           null, // resolved at runtime: asset sub-types + investment + liability sub-types
    group:                 'account_hints',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },
  target_account_types: {
    sheet_column_name:     'target_account_types',
    sheet_column_position: 12,
    ui_label:              'Target account types',
    type:                  'multi-select',
    enum_values:           null, // resolved at runtime: asset sub-types + investment + liability sub-types
    group:                 'account_hints',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },
  source_account_mandatory: {
    sheet_column_name:     'source_account_mandatory',
    sheet_column_position: 13,
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
    sheet_column_position: 14,
    ui_label:              'Target account mandatory',
    type:                  'boolean',
    enum_values:           null,
    group:                 'account_hints',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },

  // ── Meta (columns 15–17) ─────────────────────────────────────────────────
  is_subscription_eligible: {
    sheet_column_name:     'is_subscription_eligible',
    sheet_column_position: 15,
    ui_label:              'Subscription eligible',
    type:                  'boolean',
    enum_values:           null,
    group:                 'meta',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },
  sync_status: {
    sheet_column_name:     'sync_status',
    sheet_column_position: 16,
    ui_label:              'Sync status',
    type:                  'enum',
    enum_values:           ['create-pending', 'update-pending', 'in-sync', 'create-failed', 'update-failed'],
    group:                 'meta',
    applies_to:            null,
    required_for:          null,
    editable:              false, // set by system on create/update; cleared to 'in-sync' by sync job
    default_value:         'create-pending',
  },
  sync_notes: {
    sheet_column_name:     'sync_notes',
    sheet_column_position: 17,
    ui_label:              'Sync notes',
    type:                  'string',
    enum_values:           null,
    group:                 'meta',
    applies_to:            null,
    required_for:          [],
    editable:              false, // written by sync job only
    default_value:         '',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_category_schema
// ─────────────────────────────────────────────────────────────────────────────
function getCategorySchemaForClient() {
  const CATEGORY_TX_TYPES = ['money-in', 'money-out'];
  return {
    types: CATEGORY_TX_TYPES.map(function(v) {
      const labels = { 'money-in': 'Money In', 'money-out': 'Money Out' };
      return { value: v, label: labels[v] || v };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────


function getCategorySheetColumns() {
  return Object.values(CATEGORY_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

function getCategorySchemaField(key) {
  return CATEGORY_SCHEMA[key] || null;
}

function catColIndex(name) { return getColIndex(CATEGORY_SCHEMA, name); }
