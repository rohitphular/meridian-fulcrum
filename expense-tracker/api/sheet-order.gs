// =============================================================================
// FULCRUM FORGE — Sheet tab ordering (bound Sheet UI/editor only)
// Existing tabs only: no content, schemas, identities or sync metadata changes.
// =============================================================================

function ensureExpenseTrackerSheetOrder() {
  let lock = null;
  let hasLock = false;
  let spreadsheet = null;
  let originalActive = null;
  const temporarilyShown = [];
  let moved = 0;
  let orderResult = { ok: false, error: 'sheet_order_failed', moved: 0 };
  const restorationErrors = [];
  try {
    lock = LockService.getScriptLock();
    // onOpen is a simple trigger with a short runtime budget. A busy workbook
    // can be arranged later with the menu action rather than waiting ten seconds.
    hasLock = lock.tryLock(1000);
    if (hasLock === false) {
      orderResult = { ok: false, error: 'busy_retry', moved: 0 };
    } else if (new Set(EXPENSE_TRACKER_SHEET_ORDER).size !== EXPENSE_TRACKER_SHEET_ORDER.length) {
      orderResult = { ok: false, error: 'invalid_sheet_order', moved: 0 };
    } else {
      spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      if (spreadsheet === null) {
        orderResult = { ok: false, error: 'no_active_spreadsheet', moved: 0 };
      } else {
        const sheets = spreadsheet.getSheets();
        const byName = new Map(sheets.map(function(sheet) { return [sheet.getName(), sheet]; }));
        const knownNames = new Set(EXPENSE_TRACKER_SHEET_ORDER);
        const desired = EXPENSE_TRACKER_SHEET_ORDER.filter(function(name) { return byName.has(name); })
          .map(function(name) { return byName.get(name); })
          .concat(sheets.filter(function(sheet) { return knownNames.has(sheet.getName()) === false; }));
        const currentIds = sheets.map(function(sheet) { return sheet.getSheetId(); });
        const desiredIds = desired.map(function(sheet) { return sheet.getSheetId(); });
        const alreadyOrdered = currentIds.every(function(id, index) { return id === desiredIds[index]; });
        if (alreadyOrdered) {
          orderResult = { ok: true, changed: false, moved: 0 };
        } else {
          originalActive = spreadsheet.getActiveSheet();
          for (let index = 0; index < desired.length; index++) {
            if (currentIds[index] === desiredIds[index]) continue;
            const sheet = desired[index];
            if (sheet.isSheetHidden()) {
              // Register before showing: a service exception may follow a
              // successful side effect. Finally must still restore visibility.
              temporarilyShown.push(sheet);
              sheet.showSheet();
            }
            spreadsheet.setActiveSheet(sheet, true);
            spreadsheet.moveActiveSheet(index + 1);
            moved++;
            const previousIndex = currentIds.indexOf(desiredIds[index]);
            currentIds.splice(previousIndex, 1);
            currentIds.splice(index, 0, desiredIds[index]);
          }
          orderResult = { ok: true, changed: true, moved: moved };
          console.log('ensureExpenseTrackerSheetOrder: moved=' + moved);
        }
      }
    }
  } catch (_) {
    console.error('ensureExpenseTrackerSheetOrder: error=sheet_order_failed moved=' + moved);
    orderResult = { ok: false, error: 'sheet_order_failed', moved: moved };
  } finally {
    // Restore the user's prior selection before re-hiding temporary tabs. Each
    // cleanup is independent so one failed service call cannot skip the rest.
    if (originalActive !== null) {
      try { spreadsheet.setActiveSheet(originalActive, true); }
      catch (_) { restorationErrors.push('active_sheet_restore_failed'); }
    }
    temporarilyShown.forEach(function(sheet) {
      try { sheet.hideSheet(); }
      catch (_) { restorationErrors.push('sheet_visibility_restore_failed'); }
    });
    if (hasLock) {
      try { lock.releaseLock(); }
      catch (_) { restorationErrors.push('sheet_order_lock_release_failed'); }
    }
    if (restorationErrors.length > 0) {
      console.error('ensureExpenseTrackerSheetOrder: error=sheet_order_cleanup_failed count=' + restorationErrors.length);
      orderResult = { ok: false, error: 'sheet_order_cleanup_failed', moved: moved, restoration_errors: restorationErrors };
    }
  }
  return orderResult;
}

function arrangeExpenseTrackerSheetTabs() {
  const orderResult = ensureExpenseTrackerSheetOrder();
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (spreadsheet !== null) spreadsheet.toast(orderResult.ok
      ? (orderResult.changed ? 'Sheet tabs arranged.' : 'Sheet tabs are already in order.')
      : 'Could not finish arranging tabs (' + orderResult.error + '). Please retry.', 'Expense Tracker', 5);
  } catch (_) {
    console.error('arrangeExpenseTrackerSheetTabs: error=sheet_order_notification_failed');
  }
  return orderResult;
}

function onOpen() {
  const orderResult = ensureExpenseTrackerSheetOrder();
  try {
    SpreadsheetApp.getUi().createMenu('Expense Tracker')
      .addItem('Arrange sheet tabs', 'arrangeExpenseTrackerSheetTabs')
      .addToUi();
  } catch (_) {
    console.error('onOpen: error=sheet_order_menu_failed');
    return { ok: false, error: 'sheet_order_menu_failed' };
  }
  return orderResult;
}
