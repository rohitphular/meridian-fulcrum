// Run once in the Apps Script editor after deploying the canonical master names.
// Renames existing tabs in place; values, UUIDs, formulas and Sheet IDs are retained.
// All four contracts are checked before the first rename. Missing tabs stay absent.
function migrateMasterSheetNames() {
  let lock;
  let hasLock = false;
  const renamed = [];
  try {
    lock = LockService.getScriptLock();
    hasLock = lock.tryLock(10000);
    if (hasLock === false) return { ok: false, error: 'busy_retry' };

    const sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    const byName = Object.create(null);
    sheets.forEach(function(sheet) { byName[sheet.getName()] = sheet; });
    const columnsByName = Object.create(null);
    columnsByName[ACCOUNTS_SHEET] = getAccountSheetColumns();
    columnsByName[CATEGORIES_SHEET] = getCategorySheetColumns();
    columnsByName[SUBSCRIPTIONS_SHEET] = getSubscriptionSheetColumns();
    columnsByName[TRANSACTIONS_SHEET] = getTransactionSheetColumns();
    const pending = [];
    const alreadyCurrent = [];
    const absent = [];

    for (let i = 0; i < MASTER_SHEET_RENAMES.length; i++) {
      const rename = MASTER_SHEET_RENAMES[i];
      const legacy = byName[rename.legacy_name];
      const current = byName[rename.sheet_name];
      if (legacy !== undefined && current !== undefined) {
        console.warn('migrateMasterSheetNames: error=master_sheet_name_collision sheet=' + rename.sheet_name);
        return { ok: false, error: 'master_sheet_name_collision', sheet_name: rename.sheet_name };
      }
      const sheet = current === undefined ? legacy : current;
      if (sheet === undefined) {
        absent.push(rename.sheet_name);
        continue;
      }
      const lastColumn = sheet.getLastColumn();
      const headers = lastColumn === 0 ? [] : sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
      const columns = columnsByName[rename.sheet_name];
      if (headers.length > columns.length || headers.some(function(header, index) { return header !== columns[index]; })) {
        console.warn('migrateMasterSheetNames: error=sheet_header_mismatch sheet=' + rename.sheet_name);
        return { ok: false, error: 'sheet_header_mismatch', sheet_name: rename.sheet_name };
      }
      if (legacy !== undefined) pending.push({ sheet: legacy, name: rename.sheet_name });
      else alreadyCurrent.push(rename.sheet_name);
    }

    pending.forEach(function(rename) {
      rename.sheet.setName(rename.name);
      renamed.push(rename.name);
    });
    console.log('migrateMasterSheetNames: renamed=' + renamed.length + ' already_current=' + alreadyCurrent.length + ' absent=' + absent.length);
    return { ok: true, renamed: renamed, already_current: alreadyCurrent, absent: absent };
  } catch (_) {
    // A service failure may follow a successful rename. Re-running safely finishes
    // the remaining tabs; never copy rows, invent IDs or undo a completed rename.
    console.error('migrateMasterSheetNames: error=master_sheet_migration_failed renamed=' + renamed.length);
    return { ok: false, error: 'master_sheet_migration_failed', renamed: renamed };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}
