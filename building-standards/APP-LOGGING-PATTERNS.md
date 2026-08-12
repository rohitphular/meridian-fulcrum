# Logging Standards

> **Scope**: All modules — backend services, Python jobs, and frontend code.

---

## Log format

All log messages follow the same structured format regardless of language or runtime:

```
<functionName>: <key>=<value> <key>=<value>
```

- Start with the function or method name — makes filtering by call site trivial.
- `key=value` pairs separated by spaces. No JSON, no surrounding braces.
- Quote values that contain spaces: `msg="account not found"`.
- Do not add timestamps — let the logging framework handle them.

---

## Backend logging

### Log levels

| Function | When to use |
|---|---|
| `info` | Normal operation events worth recording — start/end of operations, row counts, external API results |
| `warning` | Unexpected but recoverable conditions — entity not found, skipped row, non-fatal miss |
| `error` | Caught exceptions and hard failures — `catch` blocks, unrecoverable state |

### What to always log

| Event | Level | Example |
|---|---|---|
| Start of main operation with input count | `info` | `run: input_rows=412 date=2026-08-01` |
| End of main operation with output count | `info` | `run: output_rows=410 skipped=2` |
| External API call result | `info` | `fetch: source=api.example.com status=200 records=14` |
| External API error | `warning` | `fetch: source=api.example.com status=429 reason=rate_limit` |
| Schema or migration event | `info` | `migrate: applied=0002_add_column` |
| Non-fatal miss (entity not found, skipped) | `warning` | `upsert: skipped_reason=missing_rate currency=XYZ` |
| Caught exception | `error` | `run: error=ConnectionRefusedError host=db.internal` |

### What to never log

- Credentials, API keys, passwords, or tokens — any value loaded from `.env` or a secrets store
- Personally identifiable information — names, emails, account numbers unless required and approved
- Full exception tracebacks that include sensitive values in their frames
- Raw request/response bodies from external APIs when they may contain secrets
- Session objects or authentication tokens

### Error handling pattern

In `catch` / `except` blocks: log the error, then return a structured failure response. Never silently swallow exceptions.

```
try:
    result = do_work(input)
    log.info("do_work: rows=" + len(result))
    return result
except SomeError as e:
    log.error("do_work: error=" + str(e))
    raise   # or return a structured error — never suppress silently
```

---

## Python job logging (`py-logging`)

Python jobs use `py-logging` from `meridian-common-libs`. Never use `print()`, `logging.basicConfig()`, or bare `logging.getLogger()`.

```python
from py_logging import get_logger
logger = get_logger(__name__)
```

### Log format

```
[YYYY-MM-DD HH:MM:SS UTC] [LEVEL] [module.submodule] message
```

Messages follow the same `fnname: key=value` pattern:

```python
logger.info(f"run: input_rows={len(rows)} date={today}")
logger.warning(f"fetch: source=goldapi status=429 reason=rate_limit")
logger.error(f"run: error={e}")
```

### Log levels

| Level | When |
|---|---|
| `logger.info` | Start/end of `run()`, row counts, external API success |
| `logger.warning` | Skipped rows, API rate limits, non-fatal misses |
| `logger.error` | Caught exceptions, unrecoverable states |

### Log files

`$MERIDIAN_LOG_ROOT/{top_module}/{top_module}.log` — daily rotation, previous day deleted. The env var `MERIDIAN_LOG_ROOT` must be set before the job runs; `py-logging` raises `EnvironmentError` at import time if it is missing.

---

## Frontend logging (browser console)

### Functions to use

`console.log`, `console.warn`, `console.error` — same three levels as backend.

Frontend logs are ephemeral (cleared on refresh) and visible only in DevTools. Use them for development aid, not auditing.

### Log format

```
[module] message
```

Prefix with a bracketed module or file name. Pass structured data as a second argument so DevTools renders it expandably.

```js
// Good
console.warn('[api] unexpected error response', res);
console.error('[schema] failed to load schema', err);

// Bad — no prefix, no context
console.log('error');
console.log(res);
```

### What to log

| Situation | Level | Example |
|---|---|---|
| Backend returns an unexpected error on a normally-succeeding call | `warn` | `[api] create failed` + response object |
| Schema or config load failure | `warn` | `[schema] fetch failed, using fallback` |
| State inconsistency detected | `warn` | `[list] editRow set but row not found in state` |
| Caught exception in an async handler | `error` | `[list] render: ` + err |

### What to never log

- Session objects, tokens, or credentials — these may contain secrets
- Authentication state beyond "session present / absent"
- Any value retrieved from a storage key that holds sensitive data

### Development vs. production

There is no build step to strip logs — be selective about what is committed:

- `console.error` — always acceptable; indicates real problems.
- `console.warn` — acceptable for unexpected-but-non-fatal paths.
- `console.log` — only commit if the message is useful to a future developer. Remove debug/trace logs before merging.

Gate verbose development logs behind an environment check:

```js
const DEBUG = /* your environment flag */;
if (DEBUG) console.log('[state] load complete', state);
```

---

## Log level cheat-sheet

| Scenario | Level |
|---|---|
| Start/end of main operation with counts | `info` |
| External API call succeeded | `info` |
| Non-fatal miss (entity not found, skipped row) | `warning` |
| Unexpected API error response | `warning` |
| Schema or migration event | `info` |
| Caught exception | `error` |
| Debug/trace during development | `debug` — remove before merging |
