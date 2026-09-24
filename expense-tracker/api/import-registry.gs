// =============================================================================
// FULCRUM FORGE — Import Registry: file_type → sheet + column/validation spec
//
// Generic, multi-file-type account data importer. Each entry declares:
//   sheet_name         — target sheet (must match a constant in app-config.gs)
//   columns            — ordered column headers for getOrCreateSheet + row build
//   required           — fields that must be present and non-empty on every row
//   enums              — { field: [allowed...] }; validated only when cell non-empty
//   key_field          — the row's natural key, echoed back in each result entry
//
// 'account_master' is handled specially in import-core.gs (delegates to
// createAccountsBulk); it still appears here so the file_type is recognised, but
// its columns/required/enums are unused by the writer.
// =============================================================================

const IMPORT_REGISTRY = {
  account_master: {
    sheet_name:        ACCOUNTS_SHEET,
    columns:           [],   // unused — account_master delegates to createAccountsBulk
    required:          [],
    enums:             {},
    key_field:         'account_name',
  },

  account_deposit: {
    numeric_fields: ['interest_rate'],
    sheet_name: ACCOUNT_DEPOSIT_SHEET,
    columns: [
      'id', 'account_id', 'account_name', 'is_interest_paid', 'rate_type',
      'interest_payment_frequency', 'interest_rate',
      'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at',
    ],
    required:  ['id', 'account_id'],
    enums: {
      rate_type:                  ['fixed', 'variable'],
      interest_payment_frequency: ['monthly', 'quarterly', 'annually', 'at_maturity'],
      record_status:              ['active', 'inactive', 'deleted', 'locked'],
    },
    key_field:         'id',
  },

  account_liability_credit_card: {
    numeric_fields: ['credit_limit_local', 'interest_rate', 'payment_month_day', 'statement_month_day'],
    sheet_name: ACCOUNT_LIABILITY_CREDIT_CARD_SHEET,
    columns: [
      'id', 'account_id', 'account_name', 'credit_limit_local', 'interest_rate',
      'payment_month_day', 'statement_month_day',
      'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at',
    ],
    required:          ['id', 'account_id', 'credit_limit_local'],
    enums:             { record_status: ['active', 'inactive', 'deleted', 'locked'] },
    key_field:         'id',
  },

  account_liability_mortgage: {
    numeric_fields: ['original_principal_local', 'monthly_payment_local', 'interest_rate', 'term_months'],
    sheet_name: ACCOUNT_LIABILITY_MORTGAGE_SHEET,
    columns: [
      'id', 'account_id', 'account_name', 'linked_property_account_id',
      'original_principal_local', 'monthly_payment_local', 'interest_rate',
      'rate_type', 'term_months', 'maturity_date_local',
      'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at',
    ],
    required: ['id', 'account_id', 'original_principal_local', 'term_months'],
    enums: {
      rate_type: ['fixed', 'variable'],
      record_status: ['active', 'inactive', 'deleted', 'locked'],
    },
    key_field:         'id',
  },

  account_liability_personal_loan: {
    numeric_fields: ['original_principal_local', 'monthly_payment_local', 'interest_rate', 'term_months'],
    sheet_name: ACCOUNT_LIABILITY_PERSONAL_LOAN_SHEET,
    columns: [
      'id', 'account_id', 'account_name', 'original_principal_local',
      'monthly_payment_local', 'interest_rate', 'term_months', 'maturity_date_local',
      'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at',
    ],
    required:          ['id', 'account_id', 'original_principal_local', 'term_months'],
    enums:             { record_status: ['active', 'inactive', 'deleted', 'locked'] },
    key_field:         'id',
  },

  account_investment_property: {
    numeric_fields: ['rent_day', 'rent_month', 'current_value_local', 'property_ownership_percentage', 'rent_amount_local', 'rent_ownership_percentage', 'property_service_charge_amount_local'],
    sheet_name: ACCOUNT_INVESTMENT_PROPERTY_SHEET,
    columns: [
      'id', 'account_id', 'account_name', 'acquisition_type', 'acquisition_date_local',
      'is_rented', 'rent_frequency', 'rent_day', 'rent_month', 'current_value_local',
      'property_ownership_percentage', 'rent_amount_local', 'rent_ownership_percentage',
      'property_service_charge_frequency', 'property_service_charge_amount_local',
      'current_value_evaluation_date', 'property_address',
      'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at',
    ],
    required: ['id', 'account_id', 'acquisition_type'],
    enums: {
      acquisition_type:                  ['PURCHASED', 'INHERITED', 'GIFTED'],
      rent_frequency:                    ['MONTHLY', 'YEARLY'],
      property_service_charge_frequency: ['MONTHLY', 'QUARTERLY', 'YEARLY'],
      record_status:                     ['active', 'inactive', 'deleted', 'locked'],
    },
    key_field:         'id',
  },

  account_investment_stocks: {
    numeric_fields: ['quantity', 'avg_cost_price_local', 'cost_basis_local', 'current_price_local', 'current_value_local', 'strike_price_local', 'contract_multiplier'],
    sheet_name: ACCOUNT_INVESTMENT_STOCKS_SHEET,
    columns: [
      'id', 'account_id', 'instrument_symbol', 'instrument_name', 'instrument_type',
      'instrument_currency_local', 'holding_intent', 'position_side', 'quantity',
      'avg_cost_price_local', 'cost_basis_local', 'current_price_local',
      'current_value_local', 'price_asof_date', 'evaluation_currency_rate_id',
      'underlying_symbol', 'option_type', 'strike_price_local', 'expiry_date',
      'contract_multiplier', 'opening_date', 'record_status',
      'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at',
    ],
    required: ['id', 'account_id', 'instrument_type'],
    enums: {
      instrument_type: ['EQUITY', 'ETF', 'MUTUAL_FUND', 'OPTION', 'FUTURE', 'CASH'],
      holding_intent:  ['LONG_TERM', 'SHORT_TERM', 'TRADING'],
      position_side:   ['LONG', 'SHORT'],
      option_type:     ['CALL', 'PUT'],
      record_status:   ['active', 'inactive', 'deleted', 'locked'],
    },
    key_field:         'id',
  },

};

// Returns the import spec for a file_type, or null if the file_type is unknown.
function getImportSpec(file_type) {
  return Object.prototype.hasOwnProperty.call(IMPORT_REGISTRY, file_type) ? IMPORT_REGISTRY[file_type] : null;
}
