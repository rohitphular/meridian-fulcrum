// =============================================================================
// FULCRUM FORGE — Config: constants and column definitions
// Shared across all other .gs files via GAS global scope.
// =============================================================================

const TRANSACTIONS_SHEET       = 'transactions';
const CATEGORIES_SHEET         = 'categories';
const ACCOUNTS_SHEET           = 'accounts';
const RATES_SHEET              = 'rates';
const SUBSCRIPTIONS_SHEET      = 'subscriptions';
const AUDIT_SHEET              = 'audit_access';
const ADVISOR_SHEET            = 'advisor_chat';
const COMPUTED_INSIGHTS_SHEET  = 'computed_insights';
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

// VALID_ACCOUNT_TYPES, ACCOUNT_LIABILITY_TYPES, ACCOUNT_LOAN_TYPES removed
// — all defined in account-schema.gs
