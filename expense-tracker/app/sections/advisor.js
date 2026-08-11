import { ExpenseAPI } from '../core/api.js';
import { state } from '../core/state.js';
import { el, esc } from '../core/utils.js';
import { showMsg, showLoading, hideLoading } from '../core/ui.js';

let _clearConfirm = false;

export function renderAdvisor() {
  const content = el('advisorContent');
  if (!content) return;

  const clearArea = _clearConfirm
    ? `<div class="confirm-strip" id="advisorClearConfirm">
        <span class="confirm-text">Clear all conversation history?</span>
        <button class="btn-link danger" id="advisorConfirmClear">Yes, clear</button>
        <button class="btn-link muted" id="advisorCancelClear">Cancel</button>
      </div>`
    : `<button class="advisor-clear-btn" id="advisorClearBtn">Clear history</button>`;

  content.innerHTML = `
    <div class="advisor-wrap">
      <div class="advisor-header">
        <div class="advisor-header-left">
          <div class="advisor-avatar">AI</div>
          <div class="advisor-header-text">
            <div class="advisor-title">Financial Advisor</div>
            <div class="advisor-subtitle">Powered by GPT-4o mini</div>
          </div>
        </div>
        ${clearArea}
      </div>
      <div class="advisor-messages" id="advisorMessages"></div>
      <div class="advisor-input-bar">
        <textarea class="advisor-input" id="advisorInput" placeholder="Ask about your finances…" rows="1"></textarea>
        <button class="advisor-send-btn" id="advisorSendBtn" title="Send">↑</button>
      </div>
    </div>
  `;

  _renderMessages();
  _loadHistory();

  const input = el('advisorInput');
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
  });
  el('advisorSendBtn')?.addEventListener('click', _sendMessage);

  if (_clearConfirm) {
    el('advisorConfirmClear')?.addEventListener('click', async () => {
      _clearConfirm = false;
      await _clearHistory();
    });
    el('advisorCancelClear')?.addEventListener('click', () => {
      _clearConfirm = false;
      renderAdvisor();
    });
  } else {
    el('advisorClearBtn')?.addEventListener('click', () => {
      _clearConfirm = true;
      renderAdvisor();
    });
  }
}

async function _loadHistory() {
  showLoading();
  try {
    const res = await ExpenseAPI.getAdvisorHistory();
    if (res.ok) {
      state.advisorMessages = res.data || [];
      _renderMessages();
    } else {
      console.warn('[advisor] _loadHistory failed:', res.error);
    }
  } catch (err) {
    console.error('[advisor] _loadHistory failed:', err);
  } finally {
    hideLoading();
  }
}

function _renderMessages() {
  const container = el('advisorMessages');
  if (!container) return;

  const msgs = state.advisorMessages;
  if (!msgs.length) {
    container.innerHTML = `
      <div class="advisor-empty">
        <div class="advisor-empty-icon">◈</div>
        <p>Ask me anything about your finances.</p>
        <p class="advisor-empty-sub">Spending patterns · Budget tips · Savings goals · Account health</p>
      </div>`;
    return;
  }

  container.innerHTML = msgs.map((msg, i) => {
    const isFirst = i === 0 || msgs[i - 1].role !== msg.role;
    const isLast  = i === msgs.length - 1 || msgs[i + 1].role !== msg.role;
    const label   = msg.role === 'user' ? 'You' : 'Advisor';
    return `
      <div class="advisor-msg advisor-msg-${esc(msg.role)}${isFirst ? ' is-first' : ''}${isLast ? ' is-last' : ''}">
        ${isFirst ? `<div class="advisor-msg-label">${label}</div>` : ''}
        <div class="advisor-msg-bubble">${_formatContent(msg.content)}</div>
      </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function _formatContent(text) {
  if (!text) return '';
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

async function _sendMessage() {
  const input = el('advisorInput');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = '';

  state.advisorMessages = [...state.advisorMessages, { role: 'user', content: message }];
  _renderMessages();

  const container = el('advisorMessages');
  const typingEl = document.createElement('div');
  typingEl.className = 'advisor-msg advisor-msg-assistant is-first is-last';
  typingEl.id = 'advisorTyping';
  typingEl.innerHTML = '<div class="advisor-msg-label">Advisor</div><div class="advisor-msg-bubble advisor-typing"><span></span><span></span><span></span></div>';
  container?.appendChild(typingEl);
  if (container) container.scrollTop = container.scrollHeight;

  const sendBtn = el('advisorSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  showLoading();
  try {
    const res = await ExpenseAPI.advisorChat({ message });
    el('advisorTyping')?.remove();

    if (res.ok) {
      state.advisorMessages = [...state.advisorMessages, { role: 'assistant', content: res.content }];
      _renderMessages();
    } else {
      console.warn('[advisor] _sendMessage failed:', res.error);
      showMsg('Advisor error: ' + (res.error || 'unknown'), 'warn');
      state.advisorMessages = state.advisorMessages.slice(0, -1);
      _renderMessages();
    }
  } catch (err) {
    el('advisorTyping')?.remove();
    console.error('[advisor] _sendMessage error:', err);
    showMsg('Connection error — could not reach the advisor.', 'warn');
    state.advisorMessages = state.advisorMessages.slice(0, -1);
    _renderMessages();
  } finally {
    hideLoading();
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

async function _clearHistory() {
  showLoading();
  try {
    const res = await ExpenseAPI.clearAdvisorHistory();
    if (res.ok) {
      state.advisorMessages = [];
      _renderMessages();
    } else {
      console.warn('[advisor] _clearHistory failed:', res.error);
      showMsg('Failed to clear history', 'warn');
    }
  } catch (err) {
    console.error('[advisor] _clearHistory error:', err);
    showMsg('Connection error', 'warn');
  } finally {
    hideLoading();
  }
}
