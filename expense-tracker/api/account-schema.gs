// =============================================================================
// FULCRUM FORGE — Account Schema: field registry
// Single source of truth for column positions, UI labels, types, and
// applicability rules. No magic column numbers anywhere else in the codebase.
// =============================================================================

const VALID_ACCOUNT_TYPES = ['asset', 'investment', 'liability'];

const ASSET_SUB_TYPES = ['current', 'savings', 'cash'];

const INVESTMENT_SUB_TYPES = [
  'stocks_shares', 'isa', 'pension_sipp', 'crypto',
  'fixed_deposit', 'bonds', 'property', 'commodities', 'p2p_lending', 'other',
];

const LIABILITY_SUB_TYPES = [
  'personal_loan', 'credit_card', 'mortgage', 'auto_loan', 'heloc',
  'student_loan', 'medical_loan', 'debt_consolidation', 'overdraft',
];

// Liability sub_types that represent loans (excludes credit_card and overdraft)
const LOAN_SUB_TYPES = [
  'personal_loan', 'mortgage', 'auto_loan', 'heloc',
  'student_loan', 'medical_loan', 'debt_consolidation',
];

// ─────────────────────────────────────────────────────────────────────────────
// Schema — 10 core fields in column-position order
// Column positions are append-only — never change an existing position.
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNT_SCHEMA = {

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
  type: {
    sheet_column_name: 'type',
    sheet_column_position: 3,
    ui_label: 'Type',
    type: 'enum',
    enum_values: VALID_ACCOUNT_TYPES,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: false,
    default_value: null,
  },
  sub_type: {
    sheet_column_name: 'sub_type',
    sheet_column_position: 4,
    ui_label: 'Sub-type',
    type: 'string',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: null,
    editable: false,
    default_value: '',
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
    editable: false,
    default_value: null,
  },
  opening_value: {
    sheet_column_name: 'opening_value',
    sheet_column_position: 6,
    ui_label: 'Opening Value',
    type: 'number',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: false,
    default_value: 0,
  },
  current_value: {
    sheet_column_name: 'current_value',
    sheet_column_position: 7,
    ui_label: 'Current Value',
    type: 'number',
    enum_values: null,
    group: 'core',
    applies_to: null,
    required_for: [],
    editable: false,
    default_value: 0,
  },
  is_active: {
    sheet_column_name: 'is_active',
    sheet_column_position: 8,
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
    sheet_column_position: 9,
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
    sheet_column_position: 10,
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
// Client payload — serialised subset returned by get_account_schema
// ─────────────────────────────────────────────────────────────────────────────

function getAccountSchemaForClient() {
  const TYPE_LABELS = {
    asset:       'Asset',
    investment:  'Investment',
    liability:   'Liability',
  };
  const TYPE_GROUPS = {
    asset:       'asset',
    investment:  'investment',
    liability:   'liability',
  };
  return {
    types: VALID_ACCOUNT_TYPES.map(function(v) {
      return { value: v, label: TYPE_LABELS[v] || v, group: TYPE_GROUPS[v] || 'other' };
    }),
    asset_sub_types:       ASSET_SUB_TYPES,
    investment_sub_types:  INVESTMENT_SUB_TYPES,
    liability_sub_types:   LIABILITY_SUB_TYPES,
    loan_sub_types:        LOAN_SUB_TYPES,
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

function getAccountSchemaField(key) { return ACCOUNT_SCHEMA[key] || null; }

function acctColIndex(name) { return getColIndex(ACCOUNT_SCHEMA, name); }

// True if type is a liability (stored with negative value)
function isLiabilityType(type) {
  return type === 'liability';
}

// True if sub_type is a loan sub-type
function isLoanSubType(sub_type) {
  return LOAN_SUB_TYPES.indexOf(sub_type) !== -1;
}
