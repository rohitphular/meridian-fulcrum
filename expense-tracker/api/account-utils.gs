// =============================================================================
// FULCRUM FORGE — Account Utils: stateless helpers
// No sheet I/O. All functions are pure computations.
// =============================================================================

function generateAccountId(sheet, existingData) {
  const now     = new Date();
  const year    = now.getUTCFullYear();
  const month   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day     = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = year + '' + month + '' + day;
  const prefix  = 'ACC-' + dateStr + '-';
  const values  = (existingData !== undefined && existingData !== null) ? existingData : sheet.getDataRange().getValues();
  let max     = 0;
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][0]);
    if (id.indexOf(prefix) === 0) {
      const n = parseInt(id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}
