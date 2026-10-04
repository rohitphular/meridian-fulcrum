// =============================================================================
// FULCRUM FORGE — Rate schema: column definitions and helpers
// GAS global scope — referenced by rate-core.gs and rate-validation.gs
//
// The rates tab is owned by forex-database-load (mode publish-sheet), which
// rewrites it from PostgreSQL: latest rate per currency (units per gram of XAU),
// symbol, publish time (updated_at) and the rate's own date (rate_date). The app
// only reads it; nothing in GAS edits rates. Hence no record_status, sync_status
// or created_at columns.
// =============================================================================

const RATE_SCHEMA = {

  currency: {
    sheet_column_name:     'currency',
    sheet_column_position: 1,
    ui_label:              'Currency',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false,
    default_value:         null,
  },
  rate: {
    sheet_column_name:     'rate',
    sheet_column_position: 2,
    ui_label:              'Rate (per 1g XAU)',
    type:                  'number',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          null,
    editable:              false,
    default_value:         null,
  },
  symbol: {
    sheet_column_name:     'symbol',
    sheet_column_position: 3,
    ui_label:              'Symbol',
    type:                  'string',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         '',
  },
  updated_at: {
    sheet_column_name:     'updated_at',
    sheet_column_position: 4,
    ui_label:              'Updated At',
    type:                  'datetime',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         null,
  },
  rate_date: {
    sheet_column_name:     'rate_date',
    sheet_column_position: 5,
    ui_label:              'Rate date',
    type:                  'date',
    enum_values:           null,
    group:                 'core',
    applies_to:            null,
    required_for:          [],
    editable:              false,
    default_value:         null,
  },
};

// Ordered column headers array — drives getOrCreateSheet() initialisation
function getRateSheetColumns() {
  return Object.values(RATE_SCHEMA)
    .sort(function(a, b) { return a.sheet_column_position - b.sheet_column_position; })
    .map(function(f) { return f.sheet_column_name; });
}

function getRateSchemaField(key) { return RATE_SCHEMA[key] || null; }

function rateColIndex(name) { return getColIndex(RATE_SCHEMA, name); }

// Client payload — serialised subset returned by get_rate_schema
function getRateSchemaForClient() {
  return Object.keys(RATE_SCHEMA).map(function(key) {
    const f = RATE_SCHEMA[key];
    return {
      key:      key,
      ui_label: f.ui_label,
      type:     f.type,
      editable: f.editable,
    };
  });
}
