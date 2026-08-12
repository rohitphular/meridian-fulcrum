# Authentication Patterns — Reference

> **Scope**: Web applications with single-user or small-team access — PIN/password auth, TOTP second factor, session management, IP rate limiting.

Single shared-secret authentication with an optional TOTP second factor and IP-based rate limiting. There is no user table — a single credential grants access.

---

## Overview

Every request carries the credential (PIN or password). The server validates it on every call. A TOTP code is only required at login. Session state lives client-side; the server is stateless.

---

## Server-side secrets

Store all secrets in a server-side secret store (environment variables, a secrets manager, or a platform-specific property store). Never commit secrets to git.

| Secret | Required | Notes |
|---|---|---|
| `CREDENTIAL_SECRET` | Yes | The PIN or password — minimum 8 characters; alphanumeric recommended |
| `TOTP_SECRET` | When TOTP enabled | Base32-encoded RFC 6238 secret — same value entered into an authenticator app |
| `TOTP_ENABLED` | No (defaults to `false`) | `"true"` to enforce TOTP at login; any other value skips it |

---

## Request flow

```
Request arrives
  │
  ├─ extract_meta(request)          ← pull { ip, user_agent, ... }
  │
  ├─ check_rate_limit(ip)           ← ALWAYS first; blocked before credential check
  │     → { ok: false, error: 'locked' }
  │
  ├─ verify_credential(secret)      ← constant-time comparison
  │     → { ok: false, error: 'auth' }
  │
  ├─ record_attempt(meta, success)  ← every request recorded, pass or fail
  │
  └─ dispatch to handler
```

For the login endpoint, TOTP is also checked after the credential passes:

```
login only:  check_rate_limit → verify_credential → verify_totp → record_attempt(success) → { ok: true }
```

**The order is non-negotiable.** Rate-limit check must come before credential check — this prevents locked IPs from consuming a credential attempt and potentially leaking timing information.

---

## Inputs

| Input | Source |
|---|---|
| Credential (PIN/password) | User enters at login. Matched against `CREDENTIAL_SECRET`. |
| TOTP code | User enters at login. Validated against `TOTP_SECRET` when `TOTP_ENABLED = true`. |
| Client IP | Extracted from request headers or body. Used for rate limiting and audit. |
| User agent | Browser or client identifier. Audit only — not verified for authenticity. |

---

## Credential check

- Read `CREDENTIAL_SECRET` from the secret store.
- Run a **constant-time comparison**. This matters: a naive string equality short-circuits on the first mismatched character, leaking information about how close a guess was through response timing. Constant-time comparison always iterates the full length of the longer string regardless of where the mismatch occurs.
- Return `true` (valid) or `false` (invalid).
- If `CREDENTIAL_SECRET` is not configured, return `false` — fail closed, not fail open.

---

## TOTP (RFC 6238)

| `TOTP_ENABLED` | Behaviour |
|---|---|
| `true` | Validates the 6-digit code via RFC 6238 HMAC-SHA1 with a ±1 window for clock skew. Wrong code → `totp_invalid`. If `TOTP_SECRET` is not set → return `totp_invalid` immediately (fail closed). |
| `false` or absent | Skip validation. Any 6-digit input is accepted (dev convenience). |

The login form always shows both fields regardless of the flag. The user always enters a code. The server silently enforces or skips the check based on the flag — no client-side change needed to toggle TOTP.

---

## IP-based rate limiting

Every request (pass or fail) is recorded in an access log table. One row per IP — updated on each access.

### Access log schema

| Field | Type | Notes |
|---|---|---|
| `ip` | string | Client IP |
| `user_agent` | string | Browser or client UA |
| `first_seen` | ISO datetime | Set on first insert, never updated |
| `last_seen` | ISO datetime | Updated on every access |
| `total_attempts` | integer | Running total |
| `success_count` | integer | Successful credential verifications |
| `failure_count` | integer | Failed credential verifications |
| `last_failed_at` | ISO datetime | Timestamp of last failure |
| `is_locked` | boolean | `true` after failure threshold is exceeded |
| `locked_at` | ISO datetime | When the lock was set |

Configure `MAX_FAILURES` (e.g. 3) in your application config. The lock triggers when `failure_count >= MAX_FAILURES` on a new failure.

**The lock is not cleared automatically.** Unlock manually: set `is_locked = false` in the access log, or delete the IP's row. A locked IP is blocked for every endpoint — not just login.

---

## Session model

On successful login the client stores a session in client-side storage (e.g. `sessionStorage` for per-tab scope, or a short-lived cookie):

| Property | Value |
|---|---|
| Storage scope | Per-tab or per-session (cleared on tab/browser close) — prefer over persistent storage |
| TTL | 6 hours after issue |
| Bearer credential | The session token sent on every subsequent request |
| Re-login required | Session expired; tab/browser closed; server returns `auth` or `locked` |

Forced logout = clear the session storage entry.

### Credential-as-bearer vs. opaque token

**Simpler option**: send the raw credential (PIN/password) on every request. The server re-validates it each time. No server-side session state.
- Risk: credential lives in client storage. XSS can exfiltrate it.
- Mitigated by: using `textContent` (not `innerHTML`) for all server-sourced strings, HTTPS-only transport, server-side input validation.

**Hardened option**: issue an opaque random token at login, store it server-side (cache or DB), send that token on subsequent requests. The server looks up the token rather than re-checking the credential.
- Benefit: credential never leaves the login request. Token can be revoked server-side.
- Cost: requires server-side session storage.

Choose based on threat model. Hardened is preferred when the session store is available.

---

## Errors

| Error code | Meaning | Client action |
|---|---|---|
| `auth` | Credential incorrect | Clear session, show login |
| `totp_invalid` | TOTP code wrong (when `TOTP_ENABLED = true`) | Stay on login, show error |
| `locked` | IP exceeded failure threshold | Persistent — show "contact admin"; manual unlock needed |
| `not_setup` | Credential secret not configured | Setup gap; login impossible |

---

## Development setup

1. Set `TOTP_ENABLED = false` in the secret store.
2. Enter any 6-digit code (e.g. `000000`) at login — server skips TOTP.
3. No client-side code change needed. The toggle is server-only.

## Production setup

1. Set `TOTP_ENABLED = true`.
2. Generate a Base32 secret:
   ```bash
   python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"
   ```
3. Store the Base32 value in the secret store as `TOTP_SECRET`.
4. Add the same Base32 value to Google Authenticator, Authy, or any RFC 6238-compatible authenticator app.

---

## Implementing auth in a new application

1. Read the credential from the secret store on each request — never cache it in memory across requests.
2. Implement constant-time comparison for the credential check.
3. Implement the access log table in your datastore.
4. Wire request handling in this exact order: `check_rate_limit` → `verify_credential` → `record_attempt` → `dispatch`. Never swap the first two steps.
5. For the login endpoint, add `verify_totp` between `verify_credential` and `record_attempt`.
6. On the client: store only the session token (or credential) in per-tab storage with an expiry timestamp. Check expiry before every request.
7. Configure `CREDENTIAL_SECRET`, `TOTP_SECRET`, and `TOTP_ENABLED` separately per environment — never share secrets between dev and prod.
