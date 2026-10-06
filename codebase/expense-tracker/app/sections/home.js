// Home: a placeholder. The dashboard content is being redesigned; nothing is
// requested from the server here.
import { el } from '../core/utils.js';

export function renderHome() {
  const container = el('homeContent');
  if (!container) return;
  container.innerHTML = `
    <div class="home-placeholder">
      <h2>Home</h2>
      <p class="muted">The dashboard is being redesigned. Accounts, Transactions and the other tabs work as usual.</p>
    </div>`;
}
