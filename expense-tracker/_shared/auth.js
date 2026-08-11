/* global SheetsClient */

const SESSION_TTL = 6 * 60 * 60 * 1000; // 6 hours

export function createAuthModule({ sessionKey, legacyKeys = [], verifyFn, reloadEvent }) {

  function writeSession(pin) {
    sessionStorage.setItem(sessionKey, JSON.stringify({
      pin,
      expires_at: Date.now() + SESSION_TTL,
    }));
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(sessionKey);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s?.pin || !s?.expires_at || Date.now() > s.expires_at) {
        clearSession();
        return null;
      }
      return s;
    } catch (_) {
      clearSession();
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(sessionKey);
    legacyKeys.forEach(k => sessionStorage.removeItem(k));
  }

  function showPinGate() {
    document.getElementById('pinOverlay').classList.remove('hidden');
    document.getElementById('appShell').classList.add('hidden');
    document.getElementById('pinInput').focus();
  }

  function hidePinGate() {
    document.getElementById('pinOverlay').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
  }

  function pinError(msg) {
    document.getElementById('pinError').textContent = msg;
    const inp = document.getElementById('pinInput');
    inp.classList.add('shake');
    inp.addEventListener('animationend', () => inp.classList.remove('shake'), { once: true });
  }

  async function fetchGeo() {
    try {
      const d = await fetch('https://ipapi.co/json/').then(r => r.json());
      return { ip: d.ip || 'unknown', city: d.city || '', country: d.country_name || '', ua: navigator.userAgent };
    } catch (_) {
      return { ip: 'unknown', city: '', country: '', ua: navigator.userAgent };
    }
  }

  async function submitPin() {
    const pin  = document.getElementById('pinInput').value.trim();
    const totp = document.getElementById('totpInput').value.trim();

    if (!pin)                   { pinError('Enter your PIN.');                document.getElementById('pinInput').focus();  return; }
    if (!totp)                  { pinError('Enter your authenticator code.'); document.getElementById('totpInput').focus(); return; }
    if (!/^\d{6}$/.test(totp)) { pinError('Code must be 6 digits.');         document.getElementById('totpInput').focus(); return; }

    document.getElementById('pinSubmit').disabled = true;
    document.getElementById('pinError').textContent = 'Connecting…';

    const meta = await fetchGeo();
    SheetsClient.init({ scriptUrl: window.CONFIG.SCRIPT_URL, pin, meta });

    try {
      const res = await verifyFn(totp);
      if (res.ok) {
        writeSession(pin);
        hidePinGate();
        document.dispatchEvent(new CustomEvent(reloadEvent));
      } else if (res.error === 'locked') {
        pinError('Access locked. Contact admin to unlock.');
        document.getElementById('pinSubmit').disabled = false;
      } else if (res.error === 'totp_invalid') {
        pinError('Wrong authenticator code. Try again.');
        document.getElementById('totpInput').value = '';
        document.getElementById('totpInput').focus();
        document.getElementById('pinSubmit').disabled = false;
      } else {
        pinError('Wrong PIN. Try again.');
        document.getElementById('pinInput').value = '';
        document.getElementById('pinInput').focus();
        document.getElementById('pinSubmit').disabled = false;
      }
    } catch (_) {
      pinError('Connection failed. Check the Script URL in config.js.');
      document.getElementById('pinSubmit').disabled = false;
    }
  }

  return { writeSession, readSession, clearSession, showPinGate, hidePinGate, submitPin, fetchGeo };
}
