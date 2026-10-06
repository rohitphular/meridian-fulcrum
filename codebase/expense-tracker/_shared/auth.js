/* global SheetsClient */
import { el } from './utils.js';

const SESSION_TTL = 6 * 60 * 60 * 1000; // 6 hours
const GEO_TIMEOUT_MS = 3000;

export function createAuthModule({ sessionKey, legacyKeys = [], verifyFn, reloadEvent }) {
  let submitting = false;

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
    el('pinOverlay').classList.remove('hidden');
    el('appShell').classList.add('hidden');
    el('pinSubmit').disabled = submitting;
    el('pinInput').focus();
  }

  function hidePinGate() {
    el('pinOverlay').classList.add('hidden');
    el('appShell').classList.remove('hidden');
  }

  function pinError(msg) {
    el('pinError').textContent = msg;
    const inp = el('pinInput');
    inp.classList.add('shake');
    inp.addEventListener('animationend', () => inp.classList.remove('shake'), { once: true });
  }

  async function fetchGeo() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
    try {
      const response = await fetch('https://ipapi.co/json/', { signal: controller.signal });
      if (!response.ok) throw new Error('Geolocation unavailable');
      const d = await response.json();
      return { ip: d.ip ?? 'unknown', city: d.city ?? '', country: d.country_name ?? '', ua: navigator.userAgent };
    } catch (_) {
      return { ip: 'unknown', city: '', country: '', ua: navigator.userAgent };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function submitPin() {
    if (submitting) return;
    const pin  = el('pinInput').value.trim();
    const totp = el('totpInput').value.trim();

    if (!pin)                   { pinError('Enter your PIN.');                el('pinInput').focus();  return; }
    if (!totp)                  { pinError('Enter your authenticator code.'); el('totpInput').focus(); return; }
    if (!/^\d{6}$/.test(totp)) { pinError('Code must be 6 digits.');         el('totpInput').focus(); return; }

    submitting = true;
    el('pinSubmit').disabled = true;
    el('pinError').textContent = 'Connecting…';
    try {
      const meta = await fetchGeo();
      SheetsClient.init({ scriptUrl: window.CONFIG.SCRIPT_URL, pin, meta });
      const res = await verifyFn(totp);
      if (res.ok) {
        writeSession(pin);
        el('pinInput').value = '';
        el('totpInput').value = '';
        el('pinError').textContent = '';
        hidePinGate();
        document.dispatchEvent(new CustomEvent(reloadEvent));
      } else if (res.error === 'locked') {
        pinError('Access locked. Contact admin to unlock.');
      } else if (res.error === 'totp_invalid') {
        pinError('Wrong authenticator code. Try again.');
        el('totpInput').value = '';
        el('totpInput').focus();
      } else {
        pinError('Wrong PIN. Try again.');
        el('pinInput').value = '';
        el('pinInput').focus();
      }
    } catch (_) {
      pinError('Connection failed. Check the Script URL in config.js.');
    } finally {
      submitting = false;
      el('pinSubmit').disabled = false;
    }
  }

  return { writeSession, readSession, clearSession, showPinGate, hidePinGate, submitPin, fetchGeo };
}
