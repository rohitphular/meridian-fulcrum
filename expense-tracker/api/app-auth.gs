// =============================================================================
// FULCRUM FORGE — Auth: TOTP (RFC 6238) + IP audit log
// =============================================================================

// -----------------------------------------------------------------------------
// TOTP — HMAC-SHA1, 30-second window, 6 digits
// -----------------------------------------------------------------------------

function base32Decode(input) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s     = input.toUpperCase().replace(new RegExp('[^A-Z2-7]', 'g'), '');
  const bytes = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    buf = (buf << 5) | chars.indexOf(s[i]);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
  }
  return bytes;
}

function generateTotp(keyBytes, counter) {
  const msg = new Array(8).fill(0);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const hmac   = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, msg, keyBytes);
  const offset = hmac[19] & 0xf;
  const code   = ((hmac[offset]   & 0x7f) << 24)
               | ((hmac[offset+1] & 0xff) << 16)
               | ((hmac[offset+2] & 0xff) << 8)
               |  (hmac[offset+3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(token) {
  if (PropertiesService.getScriptProperties().getProperty("TOTP_ENABLED") !== "true") return true;
  const secret = PropertiesService.getScriptProperties().getProperty('TOTP_SECRET');
  if (!secret || !token || String(token).length !== 6) return false;
  const key = base32Decode(secret);
  const T   = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    if (generateTotp(key, T + d) === String(token)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Audit — one row per IP, running totals
// -----------------------------------------------------------------------------

function checkLocked(ip) {
  if (!ip || ip === 'unknown') return false;
  const sheet  = getOrCreateSheet(AUDIT_SHEET, AUDIT_COLUMNS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === ip && values[i][10] === true) return true;
  }
  return false;
}

function recordAccess(meta, success) {
  const ip = meta.ip;
  if (!ip || ip === 'unknown') return;

  const sheet  = getOrCreateSheet(AUDIT_SHEET, AUDIT_COLUMNS);
  const values = sheet.getDataRange().getValues();
  const now    = new Date().toISOString();

  for (let i = 1; i < values.length; i++) {
    if (values[i][0] !== ip) continue;
    const rowNum        = i + 1;
    const totalAttempts = (Number(values[i][6]) || 0) + 1;
    const successCount  = (Number(values[i][7]) || 0) + (success ? 1 : 0);
    const failureCount  = (Number(values[i][8]) || 0) + (success ? 0 : 1);
    const lastFailedAt  = success ? values[i][9] : now;
    const shouldLock    = !success && failureCount >= MAX_FAILURES;
    const isLocked      = values[i][10] === true || shouldLock;
    const lockedAt      = shouldLock ? now : (values[i][11] || '');

    if (shouldLock) console.log('recordAccess: locked ip=' + ip + ' failures=' + failureCount);
    if (success && (Number(values[i][8]) || 0) > 0) console.log('recordAccess: success ip=' + ip);

    sheet.getRange(rowNum, 4).setValue(meta.ua);
    sheet.getRange(rowNum, 6).setValue(now);
    sheet.getRange(rowNum, 7).setValue(totalAttempts);
    sheet.getRange(rowNum, 8).setValue(successCount);
    sheet.getRange(rowNum, 9).setValue(failureCount);
    sheet.getRange(rowNum, 10).setValue(lastFailedAt);
    sheet.getRange(rowNum, 11).setValue(isLocked);
    sheet.getRange(rowNum, 12).setValue(lockedAt);
    return;
  }

  sheet.appendRow([
    ip, meta.city, meta.country, meta.ua,
    now, now, 1,
    success ? 1 : 0,
    success ? 0 : 1,
    success ? '' : now,
    !success && 1 >= MAX_FAILURES,
    !success && 1 >= MAX_FAILURES ? now : ''
  ]);
}
