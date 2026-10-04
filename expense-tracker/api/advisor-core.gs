// =============================================================================
// FULCRUM FORGE — Advisor Core: OpenAI-powered financial advisor
// Requires Script Property: OPENAI_API_KEY
// =============================================================================

function advisorChat(body) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) return { ok: false, error: 'no_api_key' };

  if (!body.message) return { ok: false, error: 'empty_message' };
  const userMessage = String(body.message).trim();
  if (!userMessage) return { ok: false, error: 'empty_message' };

  const history    = _getRecentHistory(5);
  const snapshot   = _buildSnapshot();
  const systemPmt  = _buildSystemPrompt(snapshot);
  const messages   = history.concat([{ role: 'user', content: userMessage }]);

  const r1 = _callOpenAi(apiKey, systemPmt, messages);
  if (!r1.ok) return r1;

  let finalContent = r1.content;
  const dataReq = _parseDataRequest(r1.content);

  if (dataReq) {
    const fetched  = _fetchRequestedData(dataReq);
    const messages2 = messages.concat([
      { role: 'assistant', content: r1.content },
      { role: 'user', content: 'Requested data:\n' + JSON.stringify(fetched) + '\n\nNow answer my original question.' }
    ]);
    const r2 = _callOpenAi(apiKey, systemPmt, messages2);
    if (r2.ok) finalContent = r2.content;
  }

  _saveToHistory('user', userMessage);
  _saveToHistory('assistant', finalContent);
  _trimHistory();

  return { ok: true, content: finalContent };
}

function getAdvisorHistory() {
  const sheet = getOrCreateSheet(ADVISOR_SHEET, ADVISOR_COLUMNS);
  return sheetToObjects(sheet).map(function(row) {
    return { timestamp: row.timestamp, role: row.role, content: row.content };
  });
}

function clearAdvisorHistory() {
  const sheet   = getOrCreateSheet(ADVISOR_SHEET, ADVISOR_COLUMNS);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  return { ok: true };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _getRecentHistory(n) {
  const sheet = getOrCreateSheet(ADVISOR_SHEET, ADVISOR_COLUMNS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const startRow = Math.max(2, lastRow - n + 1);
  const numRows  = lastRow - startRow + 1;
  const data = sheet.getRange(startRow, 1, numRows, 3).getValues();
  return data.map(function(row) { return { role: String(row[1]), content: String(row[2]) }; });
}

function _saveToHistory(role, content) {
  const sheet = getOrCreateSheet(ADVISOR_SHEET, ADVISOR_COLUMNS);
  sheet.appendRow([new Date().toISOString(), role, content]);
}

function _trimHistory() {
  const sheet   = getOrCreateSheet(ADVISOR_SHEET, ADVISOR_COLUMNS);
  const lastRow = sheet.getLastRow();
  if (lastRow > 101) sheet.deleteRows(2, lastRow - 101);
}

// The snapshot the advisor answers from: what the analytics job last published
// (XAU grams, as of published_at). Nothing is calculated here.
function _buildSnapshot() {
  const meta = rsMeta();
  if (meta === null) return { note: 'No published figures yet: the analytics job has not run.', published_at: '' };
  const read = function(key, params) { return rsPublishedPayload(meta, key, params); };
  const grams = function(value) { return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null; };
  const card = function(payload, key) {
    const found = payload === null ? undefined : payload.stat_cards.find(function(item) { return item.key === key; });
    return found === undefined ? null : grams(found.value);
  };
  const summary = read('dataset-accounts-summary');
  const balances = read('dataset-account-balances');
  const months = read('06-last-12-months');
  const categories = read('10-top-categories', { period: 'last_3' });
  const payees = read('22-top-counterparties');
  const series = function(payload, key) {
    const chart = payload === null || payload.charts.length === 0 ? null : payload.charts[0];
    const found = chart === null ? undefined : chart.datasets.find(function(item) { return item.key === key; });
    return found === undefined ? [] : found.data.map(grams);
  };
  const accounts = balances === null || balances.tables.length === 0 ? [] : balances.tables[0].rows
    .filter(function(row) { return row.cells.record_status === 'active'; })
    .map(function(row) {
      return { name: row.cells.name, type: row.cells.type, sub_type: row.cells.subtype, currency: row.cells.currency, balance_local: row.cells.balance_local, balance_xau: grams(row.cells.balance) };
    });
  const payeeChart = payees === null || payees.charts.length === 0 ? null : payees.charts[0];
  return {
    currency: 'XAU',
    published_at: meta.published_at,
    as_of_date: meta.anchor_date,
    note: 'All amounts are XAU grams from the last published analytics run (as of published_at); account balances also show the native amount. Income and spending exclude transfers between own accounts.',
    net_worth_xau: card(summary, 'net_worth'),
    total_assets_xau: card(summary, 'total_assets'),
    total_liabilities_xau: card(summary, 'total_liabilities'),
    liquid_cash_xau: card(summary, 'liquid_cash'),
    accounts: accounts,
    last_12_months: {
      months: months === null || months.charts.length === 0 ? [] : months.charts[0].labels,
      income: series(months, 'income'),
      spending: series(months, 'expense'),
    },
    top_spending_categories_last_3_months: categories === null || categories.tables.length === 0 ? [] : categories.tables[0].rows.map(function(row) {
      return { category: row.cells.category, amount: grams(row.cells.current) };
    }),
    top_payees_last_3_months: payeeChart === null ? [] : payeeChart.labels.slice(0, 5).map(function(label, index) {
      return { name: label, amount: grams(payeeChart.datasets[0].data[index]) };
    }),
  };
}

function _buildSystemPrompt(snapshot) {
  return 'You are a personal financial advisor embedded in an expense tracking app called Fulcrum Forge. ' +
    'You have access to the user\'s current financial snapshot below. Be helpful, specific, and data-driven. ' +
    'You are read-only — you cannot modify any data. Refer to actual numbers from the snapshot when relevant.\n\n' +
    '## Financial Snapshot\n```json\n' + JSON.stringify(snapshot, null, 2) + '\n```\n\n' +
    '## Requesting Additional Data\n' +
    'If you need specific transactions to answer accurately, respond with ONLY this JSON (nothing else — the user will not see it):\n' +
    '{"data_request":{"tx_type":"money-out","major_category":"Food","months_back":3,"limit":50}}\n' +
    'Filters: tx_type (money-in/money-out), major_category, minor_category, account_id, ' +
    'months_back (max 12, default 3), limit (max 100, default 50).\n' +
    'Only request data when the snapshot is genuinely insufficient. For general questions the snapshot is enough.';
}

function _callOpenAi(apiKey, systemPrompt, messages) {
  const openAiMessages = [{ role: 'system', content: systemPrompt }].concat(messages);
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: 1024,
      messages:   openAiMessages
    }),
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', options);
    const code = resp.getResponseCode();
    if (code !== 200) {
      // Provider errors can echo request content or credential fragments. The
      // HTTP status is sufficient for diagnostics; never surface their bodies.
      const status = Number.isInteger(code) && code >= 100 && code <= 599 ? code : 'unknown';
      console.warn('_callOpenAi: status=' + status + ' error=provider_error');
      return { ok: false, error: 'openai_' + status };
    }
    let data;
    try {
      data = JSON.parse(resp.getContentText());
    } catch (_) {
      console.error('_callOpenAi: error=invalid_provider_response');
      return { ok: false, error: 'invalid_openai_response' };
    }
    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string' || content.trim() === '') {
      console.error('_callOpenAi: error=invalid_provider_response');
      return { ok: false, error: 'invalid_openai_response' };
    }
    const tokens = data.usage && data.usage.total_tokens;
    console.log('_callOpenAi: status=200 tokens=' + (Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : 'unknown'));
    return { ok: true, content: content };
  } catch (e) {
    console.error('_callOpenAi: error=fetch_error');
    return { ok: false, error: 'fetch_error' };
  }
}

function _parseDataRequest(content) {
  const trimmed = content.trim();
  if (trimmed.charAt(0) === '{' && trimmed.indexOf('"data_request"') !== -1) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.data_request) return parsed.data_request;
    } catch (_) {}
  }
  const m = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?"data_request"[\s\S]*?\})\s*```/);
  if (m) {
    try {
      const parsed2 = JSON.parse(m[1]);
      if (parsed2.data_request) return parsed2.data_request;
    } catch (_) {}
  }
  return null;
}

function _fetchRequestedData(request) {
  const txSheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());

  const monthsBackRaw = Number(request.months_back);
  const monthsBack    = Math.min(Number.isFinite(monthsBackRaw) && monthsBackRaw > 0 ? monthsBackRaw : 3, 12);
  const limitRaw      = Number(request.limit);
  const limit         = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50, 100);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  const allTx      = sheetToObjects(txSheet);
  const accountMap = _loadAccountMap({ include_closed: true });

  const filtered = allTx.filter(function(tx) {
    if (String(tx.record_status) === 'deleted' || !Number.isFinite(Number(tx.tx_amount_local))) return false;
    const d = new Date(tx.tx_date_local);
    if (isNaN(d.getTime()) || d < cutoff) return false;
    if (request.tx_type        && tx.tx_type        !== request.tx_type)        return false;
    if (request.major_category && tx.major_category !== request.major_category) return false;
    if (request.minor_category && tx.minor_category !== request.minor_category) return false;
    if (request.account_id && tx.account_id !== request.account_id) return false;
    return true;
  });

  filtered.sort(function(a, b) { return new Date(b.tx_date_local) - new Date(a.tx_date_local); });

  return filtered.slice(0, limit).map(function(tx) {
    const accId = String(tx.account_id).trim();
    const acc   = accountMap[accId];
    return {
      date:             tx.tx_date_local,
      type:             tx.tx_type,
      amount:           Number(tx.tx_amount_local),
      currency:         (acc !== undefined && acc !== null) ? acc.account_currency_local : null,
      major:            tx.major_category,
      minor:            tx.minor_category,
      counterparty:     tx.counterparty_name,
      notes:            tx.description,
    };
  });
}
