// =============================================================================
// FULCRUM FORGE — Config: constants and column definitions
// Shared across all other .gs files via GAS global scope.
// =============================================================================

const TRANSACTIONS_SHEET       = 'transaction_master';
const CATEGORIES_SHEET         = 'category_master';
const ACCOUNTS_SHEET           = 'account_master';
const ACCOUNT_TYPES_SHEET      = 'account_types';
const RATES_SHEET              = 'rates';
const SUBSCRIPTIONS_SHEET      = 'subscription_master';
const AUDIT_SHEET              = 'audit_access';
const ADVISOR_SHEET            = 'advisor_chat';
const COMPUTED_INSIGHTS_SHEET  = 'computed_insights';

// Explicit in-place migration; legacy data must never be hidden by a new empty tab.
const MASTER_SHEET_RENAMES = [
  { legacy_name: 'accounts', sheet_name: ACCOUNTS_SHEET },
  { legacy_name: 'categories', sheet_name: CATEGORIES_SHEET },
  { legacy_name: 'subscriptions', sheet_name: SUBSCRIPTIONS_SHEET },
  { legacy_name: 'transactions', sheet_name: TRANSACTIONS_SHEET },
];

// Account data importer — detail sheets, one per non-master file_type.
const ACCOUNT_DEPOSIT_SHEET                 = 'account_deposit';
const ACCOUNT_LIABILITY_CREDIT_CARD_SHEET   = 'account_liability_credit_card';
const ACCOUNT_LIABILITY_MORTGAGE_SHEET      = 'account_liability_mortgage';
const ACCOUNT_LIABILITY_PERSONAL_LOAN_SHEET = 'account_liability_personal_loan';
const ACCOUNT_INVESTMENT_PROPERTY_SHEET     = 'account_investment_property';
const ACCOUNT_INVESTMENT_STOCKS_SHEET       = 'account_investment_stocks';

// User-facing tab order. Missing tabs are skipped; custom tabs follow these.
const EXPENSE_TRACKER_SHEET_ORDER = [
  TRANSACTIONS_SHEET,
  ACCOUNTS_SHEET,
  SUBSCRIPTIONS_SHEET,
  CATEGORIES_SHEET,
  ACCOUNT_TYPES_SHEET,
  RATES_SHEET,
  ACCOUNT_DEPOSIT_SHEET,
  ACCOUNT_INVESTMENT_PROPERTY_SHEET,
  ACCOUNT_INVESTMENT_STOCKS_SHEET,
  ACCOUNT_LIABILITY_CREDIT_CARD_SHEET,
  ACCOUNT_LIABILITY_MORTGAGE_SHEET,
  ACCOUNT_LIABILITY_PERSONAL_LOAN_SHEET,
  COMPUTED_INSIGHTS_SHEET,
  ADVISOR_SHEET,
  AUDIT_SHEET,
];

const MAX_FAILURES        = 3;

const ADVISOR_COLUMNS = ['timestamp', 'role', 'content'];

// TRANSACTION_COLUMNS, VALID_TRANSACTION_TYPES, txColIndex() removed — all in transaction-schema.gs

// CATEGORY_COLUMNS removed — use getCategorySheetColumns() from category-schema.gs
// RATES_COLUMNS removed — use getRateSheetColumns() from rate-schema.gs
// ACCOUNT_COLUMNS removed — use getAccountSheetColumns() from account-schema.gs

const AUDIT_COLUMNS = [
  'ip', 'city', 'country', 'user_agent',
  'first_seen', 'last_seen',
  'total_attempts', 'success_count', 'failure_count', 'last_failed_at',
  'is_locked', 'locked_at'
];

// VALID_TYPES removed — use VALID_TRANSACTION_TYPES from transaction-schema.gs
// DEFAULT_RATES removed — defined in rate-core.gs

// Account classifications, labels, loan flags and detail eligibility live in account_types.
