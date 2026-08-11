# Forge Authentication — Reference

Single-user PIN-based authentication with optional TOTP second factor and IP-based rate limiting. There is no user concept — the secret is shared.

---

## Overview

Every request to a Forge backend carries a PIN. The server validates it on every call. A TOTP code is only required at login (the `verify` action). Session state lives client-side; the server is stateless.

---

## Script Properties (server-side secrets)

Stored in GAS **Project Settings → Script Properties** (not environment variables, not `.env` files). Never committed to git.

| Key | Required | Value |
|---|---|---|
| `PIN_SECRET` | Yes | The chosen PIN (numeric or alphanumeric) |
| `TOTP_SECRET` | When TOTP enabled | Base32 TOTP secret — same value entered into an authenticator app |
| `TOTP_ENABLED` | No (defaults to `false`) | `"true"` to enforce TOTP; `"false"` or absent to skip |
| `OPENAI_API_KEY` | If using advisor | OpenAI API key for the LLM advisor endpoint |

Access in code:

```js
const pin = PropertiesService.getScriptProperties().getProperty('PIN_SECRET');
```

---

## Request flow

```
Request arrives
  │
  ├─ extractMeta(params/body)          ← pull { ip, city, country, ua }
  │
  ├─ checkLocked(ip)                   ← ALWAYS first; blocked before PIN check
  │     → { ok: false, error: 'locked' }
  │
  ├─ checkPin(pin)                     ← constant-time comparison
  │     → { ok: false, error: 'auth' }
  │
  ├─ recordAccess(meta, true/false)    ← every request recorded, win or lose
  │
  └─ dispatch to action handler
```

For the `verify` action (login), TOTP is also checked after PIN passes:

```
verify only:  checkLocked → checkPin → verifyTotp → recordAccess(success) → { ok: true }
```

---

## Inputs

| Input | Source |
|---|---|
| PIN | User enters at login. Matched against `PIN_SECRET`. |
| TOTP code | User enters at login. Validated against `TOTP_SECRET` when `TOTP_ENABLED = true`. |
| Client IP | Client-supplied in request body/params. Used for rate limiting and audit. |
| geo fields | Client fetches `{ ip, city, country, ua }` via ipapi.co at login; included in every request. Server-side audit only — not verified for authenticity. |

---

## PIN check

`checkPin(pin)` in `app-utils.gs`:

- Reads `PIN_SECRET` from Script Properties.
- Runs **constant-time comparison** (`_constantTimeEqual`) using bitwise XOR over the longer string length. Prevents timing-based PIN inference.
- Returns `true` (valid) or `false` (invalid).
- Returns `false` if `PIN_SECRET` is not set.

---

## TOTP (RFC 6238)

`verifyTotp(token)` in `app-auth.gs`:

| `TOTP_ENABLED` | Behaviour |
|---|---|
| `"true"` | Validates the 6-digit code via RFC 6238 HMAC-SHA1 with a ±1 window for clock skew. Wrong code → `totp_invalid`. |
| `"false"` or absent | Returns `true` immediately. Any 6-digit input is accepted (dev convenience). |

The login form always shows both fields regardless of the flag. The user always enters a code. The server silently enforces or skips the check based on the flag.

Implementation uses `Utilities.computeHmacSignature(HMAC_SHA_1, ...)` — GAS built-in, no external library needed.

---

## IP audit log

Every request (pass or fail) is recorded in the `audit_access` sheet. One row per IP — the row is updated on each access.

### Sheet: `audit_access`

12 columns in this exact order. Column positions matter — `checkLocked` reads `is_locked` by index 10 (0-based):

| Col | Field | Type | Notes |
|---|---|---|---|
| 1 | `ip` | string | Client IP |
| 2 | `city` | string | Client-supplied geo |
| 3 | `country` | string | Client-supplied geo |
| 4 | `user_agent` | string | Browser UA |
| 5 | `first_seen` | ISO datetime | Set on first insert, never updated |
| 6 | `last_seen` | ISO datetime | Updated on every access |
| 7 | `total_attempts` | number | Running total |
| 8 | `success_count` | number | Successful PIN verifications |
| 9 | `failure_count` | number | Failed PIN verifications |
| 10 | `last_failed_at` | ISO datetime | Timestamp of last failure |
| 11 | `is_locked` | boolean | `true` after `MAX_FAILURES` failures |
| 12 | `locked_at` | ISO datetime | When the lock was set |

`MAX_FAILURES = 3` (defined in `app-config.gs`). The lock triggers when `failure_count >= MAX_FAILURES` on a failure.

**The lock is not cleared automatically.** Unlock manually: set `is_locked = false` in the sheet, or delete the IP's row. A locked IP is blocked for every endpoint — not just login.

---

## Session model

On successful login the client stores a session blob in per-tab `sessionStorage`:

```json
{ "pin": "...", "expires_at": 1720000000000 }
```

| Property | Value |
|---|---|
| Storage scope | Per-tab (cleared on tab close) |
| TTL | 6 hours after issue |
| Bearer credential | The PIN itself — sent on every subsequent request. No server-issued token. |
| Re-login required | Tab closed; TTL expired; server returns `auth` or `locked` |

Forced logout = clear `sessionStorage`.

### PIN-as-bearer-credential — design note

The PIN is re-validated on every request via `checkPin`. There is no opaque server-issued session token — this is a deliberate simplification for the single-user threat model. The only realistic exfiltration path for the PIN is XSS:

- **Mitigated by**: `textContent` (not `innerHTML`) for user-supplied strings in `showMsg`; SRI hash on Chart.js CDN; server-side input validation.
- **Transport**: HTTPS-only via the GAS `/exec` URL.

Future hardening: issue a `Utilities.getUuid()` token at login, stored in `PropertiesService`, and send that instead of the PIN. Out of scope until needed.

---

## Errors

| Error | Meaning | Client action |
|---|---|---|
| `auth` | PIN incorrect | Clear session, show login |
| `totp_invalid` | TOTP code wrong (when `TOTP_ENABLED = true`) | Stay on login, show error |
| `locked` | IP exceeded `MAX_FAILURES` | Persistent — show "contact admin"; manual unlock needed |
| `not_setup` | `PIN_SECRET` not configured | Setup gap; login impossible |

---

## Development setup

1. Set `TOTP_ENABLED = false` in Script Properties.
2. Enter any 6-digit code (e.g. `000000`) at login — server skips TOTP.
3. No client-side code change needed. The toggle is server-only.

## Production setup

1. Set `TOTP_ENABLED = true`.
2. Generate a Base32 secret:
   ```bash
   python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"
   ```
3. Set `TOTP_SECRET` in Script Properties.
4. Add the same Base32 value to Google Authenticator, Authy, or any RFC 6238 client.

---

## Implementing auth in a new module

1. Copy `app-auth.gs` verbatim — do not modify auth logic.
2. Ensure `app-utils.gs` is present (provides `checkPin`, `extractMeta`, `json`).
3. Set `AUDIT_SHEET = 'audit_access'` and `MAX_FAILURES = 3` in `app-config.gs`.
4. In `doGet`/`doPost`: call `checkLocked(meta.ip)` before `checkPin`. Never swap the order.
5. Wire the `verify` action: check PIN + TOTP + `recordAccess(meta, true)` + return `{ ok: true }`.
6. On the frontend: use `createAuthModule` from `_shared/auth.js` with the module's `sessionKey` and `reloadEvent`.
7. Set `PIN_SECRET` (and optionally `TOTP_SECRET`, `TOTP_ENABLED`) in Script Properties for each deployed environment.
