# Forge — Logging Standards

> **Scope**: All Forge modules — backend (GAS) and frontend (vanilla JS).

---

## Why logging matters here

GAS has no persistent server process and no attached debugger. The only visibility into what happened during a request is the execution log. Consistent, structured log lines make the difference between "something went wrong" and "the auth check failed for IP 1.2.3.4 at 14:32 after 2 previous failures".

Frontend logging is secondary — the browser console is transient and developer-only. Log there to help during development; strip noise before merging.

---

## Backend logging (GAS / Stackdriver)

### Functions to use

| Function | When to use |
|---|---|
| `console.log(msg)` | Normal operation events worth recording — auth, migrations, external calls |
| `console.warn(msg)` | Unexpected but recoverable conditions — account not found during reversal, schema miss |
| `console.error(msg)` | Caught exceptions and hard failures — `catch` blocks, unrecoverable state |

GAS routes all three to Stackdriver (Google Cloud Logging). The severity label (`INFO`, `WARNING`, `ERROR`) is set by the function.

### Log format

```
<functionName>: <key>=<value> <key>=<value>
```

- Start with the function name — makes grepping by function trivial.
- `key=value` pairs separated by spaces. No JSON, no surrounding braces.
- Quote values that contain spaces: `msg="account not found"`.
- Do not add a timestamp — Stackdriver records it automatically.

```js
// Good
console.log('adjustAccountBalance: id=' + accountId + ' delta=' + delta);
console.warn('adjustAccountBalance: account_not_found id=' + accountId);
console.error('createTransaction: ' + e.message);

// Bad — no function name, unclear what the values mean
console.log(accountId, delta);
console.log('error: ' + JSON.stringify(e));
```

### What to always log

| Event | Level | Example |
|---|---|---|
| Auth failure (PIN wrong) | `log` | `checkPin: fail ip=1.2.3.4` |
| IP locked | `log` | `recordAccess: locked ip=1.2.3.4 failures=3` |
| IP unlocked (first success after failures) | `log` | `recordAccess: success ip=1.2.3.4` |
| External API call | `log` | `_callClaude: status=200 tokens=312` |
| External API error | `warn` | `_callClaude: status=429 error="rate_limit_exceeded"` |
| Schema migration ran | `log` | `migrateTransactionColumnHeaders: renamed=3` |
| Missing referenced entity (non-fatal) | `warn` | `adjustAccountBalance: account_not_found id=ACC-20240101-001` |
| Caught exception in handler | `error` | `createTransaction: TypeError: Cannot read property of null` |

### What to never log

- PIN values: `checkPin: pin=1234` — **never**
- TOTP tokens: any `totp=` value
- Full request bodies: these can contain PINs and sensitive financial data
- API keys or script properties

### Error handling pattern

In catch blocks: log the error message, then return a structured `{ ok: false }` response. Never let an exception propagate to the GAS runtime (it returns HTML, not JSON).

```js
try {
  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code !== 200) {
    console.warn('_callClaude: status=' + code);
    return { ok: false, error: 'api_error_' + code };
  }
  return { ok: true, content: JSON.parse(resp.getContentText()).choices[0].message.content };
} catch (e) {
  console.error('_callClaude: ' + e.message);
  return { ok: false, error: 'fetch_error' };
}
```

For domain functions that encounter missing data (not a code error, but worth noting):

```js
console.warn('adjustAccountBalance: account_not_found id=' + accountId + ' delta=' + delta);
return { ok: false, error: 'account_not_found:' + accountId };
```

### Viewing logs

**GAS editor:**
Apps Script editor → **Executions** tab. Shows recent executions with their log output and status.

**CLI:**
```bash
# Tail recent logs (requires .clasp.json to have a real scriptId)
cd api && clasp logs
```

Logs are retained for ~7 days in Stackdriver free tier.

---

## Frontend logging (browser console)

### Functions to use

Same three: `console.log`, `console.warn`, `console.error`.

Frontend logs are ephemeral (cleared on refresh), visible only to the person with DevTools open. Use them for development aid, not auditing.

### Log format

```
[ModuleName] message
```

Prefix with a bracketed module/file name. Pass structured data as a second argument so DevTools renders it expandably.

```js
// Good
console.warn('[api] unexpected error response', res);
console.error('[schema] failed to load account schema', err);

// Bad — no prefix, no context
console.log('error');
console.log(res);
```

### What to log

| Situation | Level | Example |
|---|---|---|
| Backend returns `ok: false` on a call that should not fail | `warn` | `[api] create_transaction failed` + response object |
| Schema load failure | `warn` | `[schema] account schema fetch failed, using fallback` |
| State inconsistency detected | `warn` | `[transactions] txEditRow set but row not found in state` |
| Caught exception in an async section handler | `error` | `[transactions] renderTransactions: ` + err |

### What to never log

- `session.pin` — ever, anywhere
- Full session objects (they contain the PIN)
- TOTP codes
- Any value from `sessionStorage` by key `<slug>_session`

```js
// Wrong — logs the PIN
console.log('session', session);

// Right — log only what's safe
console.log('[auth] session loaded, expires_at=' + session.expires_at);
```

### Development vs. production

There is no build step to strip logs, so be selective about what you commit. Rules:

- `console.error` — always acceptable; these indicate real problems.
- `console.warn` — acceptable for unexpected-but-non-fatal paths.
- `console.log` — only commit if the message is useful to a future developer (e.g. a schema fallback notice). Remove debug/trace logs before merging.

A future pattern to formalise:

```js
// In main.js or config.js
const DEBUG = location.hostname === 'localhost';

// In modules
if (DEBUG) console.log('[state] loadAll complete', state);
```

---

## Log level cheat-sheet

| Scenario | BE | FE |
|---|---|---|
| Normal auth event | `console.log` | — |
| External API called | `console.log` | — |
| Expected miss (account not found during reversal) | `console.warn` | — |
| Unexpected API error response | `console.warn` | `console.warn` |
| Schema load failure | — | `console.warn` |
| Caught exception | `console.error` | `console.error` |
| Debug/trace during development | — | `console.log` (remove before merge) |
