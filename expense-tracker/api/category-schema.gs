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
// Schema — 20 fields in column-position order
// Column positions are append-only — never change an existing position.
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

  // ── Description (column 7) ────────────────────────────────────────────────
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

  // ── Classification (columns 8–9) ──────────────────────────────────────────
  tag_keywords: {
    sheet_column_name:     'tag_keywords',
    sheet_column_position: 8,
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
    sheet_column_position: 9,
    ui_label:              'Counterparty examples',
    type:                  'string',
    enum_values:           null,
    group:                 'classification',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         '',
  },

  // ── Account hints (columns 10–13) ─────────────────────────────────────────
  // source_account_types / target_account_types: comma-separated account
  // type values used to filter the respective account dropdowns.
  // source_account_mandatory / target_account_mandatory: when true the field
  // is enabled and required; when false the field is visible but disabled
  // (shows "External").
  source_account_types: {
    sheet_column_name:     'source_account_types',
    sheet_column_position: 10,
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
    sheet_column_position: 11,
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
    sheet_column_position: 12,
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
    sheet_column_position: 13,
    ui_label:              'Target account mandatory',
    type:                  'boolean',
    enum_values:           null,
    group:                 'account_hints',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },

  // ── Subscription flag (column 14) ─────────────────────────────────────────
  is_subscription_eligible: {
    sheet_column_name:     'is_subscription_eligible',
    sheet_column_position: 14,
    ui_label:              'Subscription eligible',
    type:                  'boolean',
    enum_values:           null,
    group:                 'meta',
    applies_to:            null,
    required_for:          [],
    editable:              true,
    default_value:         false,
  },

  // ── Audit / sync (columns 15–20) ──────────────────────────────────────────
  record_status: {
    sheet_column_name:     'record_status',
    sheet_column_position: 15,
    ui_label:              'Record status',
    type:                  'enum',
    enum_values:           ['active', 'inactive', 'deleted', 'locked'],
    group:                 'audit',
    applies_to:            null,
    required_for:          null,
    editable:              true,
    default_value:         'active',
  },
  sync_status: {
    sheet_column_name:     'sync_status',
    sheet_column_position: 16,
    ui_label:              'Sync status',
    type:                  'enum',
    enum_values:           ['create-pending', 'update-pending', 'in-sync', 'create-failed', 'update-failed'],
    group:                 'audit',
    applies_to:            null,
    required_for:          null,
    editable:              false, // set by system on create/update; cleared to 'in-sync' by sync job
    default_value:         'create-pending',
  },
  sync_date_time: {
    sheet_column_name:     'sync_date_time',
    sheet_column_position: 17,
    ui_label:              'Sync date/time',
    type:                  'string',
    enum_values:           null,
    group:                 'audit',
    applies_to:            null,
    required_for:          [],
    editable:              false, // written by sync job on successful sync
    default_value:         '',
  },
  sync_notes: {
    sheet_column_name:     'sync_notes',
    sheet_column_position: 18,
    ui_label:              'Sync notes',
    type:                  'string',
    enum_values:           null,
    group:                 'audit',
    applies_to:            null,
    required_for:          [],
    editable:              false, // written by sync job only
    default_value:         '',
  },
  created_at: {
    sheet_column_name:     'created_at',
    sheet_column_position: 19,
    ui_label:              'Created at',
    type:                  'string',
    enum_values:           null,
    group:                 'audit',
    applies_to:            null,
    required_for:          [],
    editable:              false, // set once on createCategory
    default_value:         '',
  },
  updated_at: {
    sheet_column_name:     'updated_at',
    sheet_column_position: 20,
    ui_label:              'Updated at',
    type:                  'string',
    enum_values:           null,
    group:                 'audit',
    applies_to:            null,
    required_for:          [],
    editable:              false, // set on every mutation
    default_value:         '',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Client payload — serialised subset returned by get_category_schema
// ─────────────────────────────────────────────────────────────────────────────
function getCategorySchemaForClient() {
  return {
    types: CATEGORY_SCHEMA.tx_type_key.enum_values.map(function(v) {
      return {
        value: v,
        label: v.split('-').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' '),
      };
    }),
    record_statuses: CATEGORY_SCHEMA.record_status.enum_values,
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
  return CATEGORY_SCHEMA[key] !== undefined ? CATEGORY_SCHEMA[key] : null;
}

function catColIndex(name) { return getColIndex(CATEGORY_SCHEMA, name); }
