// =============================================================================
// FULCRUM FORGE — Factory reset: delete the CSV-backed tabs
// Driven by data-synchronization/ledger-sheet-load (sheet-rebuild), which then recreates the
// tabs through the list endpoints and re-imports each CSV through its entity's
// own CSV import endpoint (the same one the app uses).
// =============================================================================

// Tabs rebuilt from local CSVs. Every other tab (dummy, rates, audit_access,
// advisor_chat, computed_insights, custom tabs) is never touched.
const FACTORY_RESET_SHEETS = [
  ACCOUNT_TYPES_SHEET, CATEGORIES_SHEET, ACCOUNTS_SHEET,
  ACCOUNT_DEPOSIT_SHEET, ACCOUNT_INVESTMENT_PROPERTY_SHEET, ACCOUNT_INVESTMENT_STOCKS_SHEET,
  ACCOUNT_LIABILITY_CREDIT_CARD_SHEET, ACCOUNT_LIABILITY_MORTGAGE_SHEET, ACCOUNT_LIABILITY_PERSONAL_LOAN_SHEET,
  SUBSCRIPTIONS_SHEET, TRANSACTIONS_SHEET,
];
const FACTORY_RESET_CONFIRM = 'factory-reset';
function _factoryResetText(value) { return value === undefined || value === null ? '' : String(value); }

// body: { confirm: 'factory-reset', spreadsheet_id } — the id must match the
// bound spreadsheet so a script pointed at the wrong environment deletes nothing.
function factoryResetDeleteSheets(body) {
  if (body.confirm !== FACTORY_RESET_CONFIRM) return { ok: false, error: 'confirmation_required' };
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (_factoryResetText(body.spreadsheet_id).trim() !== spreadsheet.getId()) return { ok: false, error: 'spreadsheet_mismatch' };
  const sheets = spreadsheet.getSheets();
  const targets = sheets.filter(function(sheet) { return FACTORY_RESET_SHEETS.indexOf(sheet.getName()) !== -1; });
  // A spreadsheet must keep at least one tab; the retained 'dummy' tab exists for this.
  if (targets.length === sheets.length) return { ok: false, error: 'no_retained_sheet' };
  const deleted = [];
  try {
    // Listed only once deleted: a failed delete must not be reported as done.
    targets.forEach(function(sheet) { const name = sheet.getName(); spreadsheet.deleteSheet(sheet); deleted.push(name); });
  } catch (_) {
    console.error('factoryResetDeleteSheets: error=delete_failed deleted=' + deleted.length);
    return { ok: false, error: 'delete_failed', deleted: deleted };
  }
  console.log('factoryResetDeleteSheets: deleted=' + deleted.length);
  return { ok: true, deleted: deleted };
}
