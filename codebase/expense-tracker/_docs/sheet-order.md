# Spreadsheet tab order

Daily-use masters come first, followed by configuration, account details and system tabs. This order controls the tabs in the Google spreadsheet; it does not change the web app navigation or ledger extraction order.

| Position | Tab | Purpose |
|---|---|---|
| 1 | `transaction_master` | Daily account movements |
| 2 | `account_master` | Accounts and opening snapshots |
| 3 | `subscription_master` | Recurring obligations |
| 4 | `category_master` | Transaction classification |
| 5 | `account_types` | Account classification and processing policies |
| 6 | `rates` | Current app display rates |
| 7 | `account_deposit` | Deposit account details |
| 8 | `account_investment_property` | Property details |
| 9 | `account_investment_stocks` | Investment positions |
| 10 | `account_liability_credit_card` | Credit-card details |
| 11 | `account_liability_mortgage` | Mortgage details |
| 12 | `account_liability_personal_loan` | Personal-loan details |
| 13 | `computed_insights` | Legacy tab; no longer written or read |
| 14 | `advisor_chat` | Advisor conversation history |
| 15 | `audit_access` | Access audit records |

The single configuration list is `EXPENSE_TRACKER_SHEET_ORDER` in [app-config.gs](../api/app-config.gs). It references the existing Sheet-name constants. Change that list to change the preferred sequence.

## Applying the order

After deploying the updated GAS backend, reopen its bound spreadsheet as an editor. The `onOpen()` handler in [sheet-order.gs](../api/sheet-order.gs) arranges the existing tabs and adds **Expense Tracker → Arrange sheet tabs**. Use that menu after importing/creating tabs or manually dragging them while the spreadsheet remains open. The menu displays the outcome in a toast.

You can also run `ensureExpenseTrackerSheetOrder()` directly from the Apps Script editor. It returns `{ ok: true, ... }` on success or a structured error. Opening the Expense Tracker web app does not invoke the spreadsheet's `onOpen()` handler. No additional installable trigger or Advanced Sheets service is required.

## Preservation and retries

- Only existing tabs move. Missing configured tabs are skipped, so positions compress when optional tabs are absent. This helper does not create optional or retired tabs.
- Custom/unrecognized tabs follow the configured tabs, retaining their relative order. Legacy master names remain unrecognized until the separate [master-name migration](master-sheet-names.md) is run.
- Sheet IDs, names, rows, columns, formulas, UUIDs and sync/audit values are unchanged. The extractor continues to address tabs by name.
- The helper restores the active tab and its previous selection, and re-hides any hidden tab temporarily shown to move it. An already ordered workbook needs no tab moves or selection changes.
- A script lock serializes arrangement with app writes. Busy execution returns `busy_retry`; try the menu again. Service failures may leave a partially arranged workbook; rerunning completes the order without rebuilding any tab. Restoration failures are reported rather than claimed successful.

The implementation uses the native [Spreadsheet tab-movement and selection methods](https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet#moveActiveSheet(Integer)). This code change does not deploy the backend or rearrange a live spreadsheet by itself.

## HTTP action

The PIN-protected POST action `arrange_sheet_tabs` runs the same `ensureExpenseTrackerSheetOrder()` and returns its result (`{ ok, changed, moved }` or an error such as `busy_retry`). The [ledger-sheet-load](../../data-synchronization/ledger-sheet-load/README.md) job calls it as its final step in both modes.
