let _overlay = null;
let _depth   = 0;

function _getOverlay() {
  if (!_overlay) {
    _overlay = document.createElement('div');
    _overlay.id = 'loadingOverlay';
    _overlay.className = 'hidden';
    _overlay.innerHTML = '<div class="forge-spinner"></div>';
    document.body.appendChild(_overlay);
  }
  return _overlay;
}

export function showLoading() {
  _depth++;
  _getOverlay().classList.remove('hidden');
}
export function hideLoading() {
  if (--_depth <= 0) {
    _depth = 0;
    _getOverlay().classList.add('hidden');
  }
}

export function showMsg(text, type = 'success') {
  const b = document.getElementById('msgBanner');
  // textContent (not innerHTML) — error strings and user-supplied identifiers
  // (account names, currency codes, etc.) can flow through here, so HTML must
  // never be interpreted. All call sites pass plain text already.
  document.getElementById('msgText').textContent = text;
  document.getElementById('msgIco').textContent = type === 'warn' ? '!' : '›';
  b.className = `banner ${type === 'warn' ? 'warn' : 'success'}`;
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => b.classList.add('hidden'), 5000);
  const close = document.getElementById('msgClose');
  if (close && !close._bound) {
    close._bound = true;
    close.addEventListener('click', () => {
      clearTimeout(showMsg._t);
      b.classList.add('hidden');
    });
  }
}
