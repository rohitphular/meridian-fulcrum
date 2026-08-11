# Expense Tracker — Re-Wire Brain

Personal finance ledger. Tracks income, expenses, and transfers across multiple accounts in multiple currencies. Balances stay exact automatically.

---

## Live URLs

| | URL |
|---|---|
| **App (prod)** | https://rohitphular.github.io/fulcrum/forge/expense-tracker/app/ |
| **App (local)** | `make app-start` → http://localhost:8000/expense-tracker/app/ |
| **Backend (prod)** | GAS `/exec` — in `app/config.js` as `PROD_SCRIPT_URL` |
| **Backend (dev)** | GAS `/exec` — in `app/config.js` as `DEV_SCRIPT_URL` |

Login: PIN + 6-digit TOTP code from your authenticator app. TOTP can be disabled for dev (`TOTP_ENABLED = false` in Script Properties).

---

## Stack in one line per layer

| Layer | What |
|---|---|
| Frontend | Vanilla JS ES modules — no framework, no build step. Lives in `app/`. |
| Backend | Google Apps Script V8 (`.gs` files). Lives in `api/`. One HTTPS endpoint. |
| Database | Google Sheet — one tab per entity. Auto-created on first request. |
| Hosting | GitHub Pages (frontend) · GAS Web App deployment (backend) |
| Auth | PIN (every request) + RFC 6238 TOTP (login only) |

---

## Folder map

```
expense-tracker/
├── app/          Frontend SPA — sections, state, API wrappers, styles
├── api/          GAS backend — .gs modules by domain
├── cicd/         deploy.sh, logs.sh, envs.json
├── _docs/        Language-agnostic requirements (what, not how)
├── _tasks/       In-flight task notes
├── Makefile      app-start, app-stop, api-deploy, api-logs
└── REWIRE-BRAIN.md  ← you are here
```

Shared code for all Forge modules: `forge/_shared/` (sheets-client.js, auth.js, ui.js, utils.js, style-tokens.css).

---

## What is built

| Feature | Status |
|---|---|
| Transactions — create / edit / delete (money-in, money-out, transfer) | ✓ Done |
| Accounts — 13 types (current, savings, loan, credit card, crypto, …) | ✓ Done |
| Automatic balance tracking — two-phase reversal on edit/delete | ✓ Done |
| Multi-currency — per-account currency, FX rates, base-currency conversion | ✓ Done |
| Categories — two-level taxonomy (major → minor), account-type hints | ✓ Done |
| FX Rates — manage rates, auto-seeded with GBP/INR/USD/EUR/AED defaults | ✓ Done |
| Insight — summary cards, monthly trend chart, category breakdown | ✓ Done |
| Advisor — LLM chat panel (OpenAI gpt-4o-mini, script property key) | ✓ Done |
| Auth — PIN + TOTP gate, IP-based lockout after 3 failures | ✓ Done |
| CI/CD — one-command deploy via `make api-deploy` | ✓ Done |
| Dark mode | ✓ Done |

## What is pending

Nothing tracked in `_tasks/` right now. Check `_docs/overview.md` for the full feature scope and any out-of-scope items.

---

## Start working locally

```bash
# Run the frontend (file:// is blocked — HTTP server required)
make app-start
# → http://localhost:8000/expense-tracker/app/

# Edit backend
cd api
# Edit .gs files, then deploy:
make api-deploy   # pick env → enter description
```

Backend changes take effect immediately after deploy. Frontend changes are live on save — just refresh.

---

## Deploy

```bash
bash forge/expense-tracker/cicd/deploy.sh
# 1. Pick: dev | prod
# 2. Enter a description (or leave blank)
```

This does: `clasp push --force` → `clasp deploy` → restores `.clasp.json` placeholder. Git is NOT touched — commit and push separately.

Frontend deploys automatically via GitHub Pages on every `git push` to `main`. No separate deploy step.

---

## Key files to know

| File | Why you'd open it |
|---|---|
| `app/config.js` | Backend URLs for dev + prod |
| `app/core/state.js` | All app state — data, UI flags, filters |
| `app/core/api.js` | Every backend action in one place |
| `app/sections/transactions.js` | Largest section — ~1200 lines, the reference implementation |
| `api/app-router.gs` | All backend actions wired here |
| `api/app-config.gs` | Sheet name constants |
| `cicd/envs.json` | Script IDs + Deployment IDs for dev + prod |

---

## Where to read more

| Topic | Doc |
|---|---|
| Adding a new backend domain | `../building-standards/APP-BE.md` |
| Adding a new frontend section | `../building-standards/APP-FE.md` |
| Auth implementation details | `../building-standards/APP-AUTH.md` |
| Deploy pipeline internals | `../building-standards/APP-CICD.md` |
| Design system + UX patterns | `../building-standards/UX-DESIGN.md` |
| Naming conventions | `../building-standards/APP-CONVENTIONS.md` |
| Logging standards | `../building-standards/APP-LOGGING.md` |
| Shared utilities catalog | `../building-standards/APP-SHARED-UTILS.md` |
| Domain requirements (what the app does) | `_docs/README.md` |
