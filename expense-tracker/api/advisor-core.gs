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

function _buildSnapshot() {
  const accounts  = listAccounts();
  const ratesData = listRates();

  const rateMap = {};
  ratesData.forEach(function(r) {
    if (r.currency) rateMap[String(r.currency).toUpperCase()] = Number(r.rate);
  });

  let assets = 0, liabilities = 0;
  const acctList = [];

  accounts.filter(function(a) { return String(a.record_status) === 'active'; }).forEach(function(a) {
    const bal    = Number(a.current_value);
    const rate   = rateMap[String(a.currency).toUpperCase()];
    const balXau = bal / rate;

    if (isLiabilityType(a.type)) liabilities += Math.abs(balXau);
    else                          assets      += balXau;

    acctList.push({ name: a.name, type: a.type, sub_type: a.sub_type, currency: a.currency, balance: Math.round(bal * 100) / 100 });
  });

  const txSheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
  const allTx   = sheetToObjects(txSheet);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);

  const recentTx = allTx.filter(function(tx) {
    const d = new Date(tx.tx_date_local);
    return !isNaN(d.getTime()) && d >= cutoff && tx.tx_type;
  });

  const catSpend = {}, cpSpend = {};
  let totalIn = 0, totalOut = 0;
  recentTx.forEach(function(tx) {
    const amt = Number(tx.tx_amount_local);
    if (tx.tx_type === 'money-out') {
      totalOut += amt;
      const key = tx.major_category + ' / ' + tx.minor_category;
      if (!catSpend[key]) catSpend[key] = 0;
      catSpend[key] += amt;
      const cp = String(tx.counterparty_name).trim();
      if (cp) {
        if (!cpSpend[cp]) cpSpend[cp] = 0;
        cpSpend[cp] += amt;
      }
    } else if (tx.tx_type === 'money-in') {
      totalIn += amt;
    }
  });

  const topCategories = Object.keys(catSpend)
    .sort(function(a, b) { return catSpend[b] - catSpend[a]; })
    .slice(0, 10)
    .map(function(k) { return { category: k, amount: Math.round(catSpend[k] * 100) / 100 }; });

  const topCounterparties = Object.keys(cpSpend)
    .sort(function(a, b) { return cpSpend[b] - cpSpend[a]; })
    .slice(0, 5)
    .map(function(k) { return { name: k, amount: Math.round(cpSpend[k] * 100) / 100 }; });

  return {
    net_worth_xau:        Math.round((assets - liabilities) * 100) / 100,
    total_assets_xau:     Math.round(assets * 100) / 100,
    total_liabilities_xau: Math.round(liabilities * 100) / 100,
    note: 'Net worth is converted to XAU (grams of gold) using stored exchange rates. Account balances shown in native currency.',
    accounts: acctList,
    last_3_months: {
      total_income:           Math.round(totalIn  * 100) / 100,
      total_expense:          Math.round(totalOut * 100) / 100,
      top_spending_categories: topCategories,
      top_counterparties:      topCounterparties
    }
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
    const data = JSON.parse(resp.getContentText());
    if (code !== 200) {
      console.warn('_callOpenAi: status=' + code + ' error=' + (data.error ? data.error.message : 'unknown'));
      return { ok: false, error: 'openai_' + code, detail: data.error ? data.error.message : 'api_error' };
    }
    const content = (data.choices && data.choices[0]) ? data.choices[0].message.content : '';
    console.log('_callOpenAi: status=200 tokens=' + (data.usage ? data.usage.total_tokens : 'unknown'));
    return { ok: true, content: content };
  } catch (e) {
    console.error('_callOpenAi: ' + e.message);
    return { ok: false, error: 'fetch_error', detail: e.message };
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
  const accountMap = _loadAccountMap();

  const filtered = allTx.filter(function(tx) {
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
      currency:         (acc !== undefined && acc !== null) ? acc.currency : null,
      major:            tx.major_category,
      minor:            tx.minor_category,
      counterparty:     tx.counterparty_name,
      notes:            tx.description,
    };
  });
}
