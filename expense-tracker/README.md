# Expense Tracker

A personal-finance ledger. Tracks money in, money out, and movement between owned accounts — multi-currency, category-driven, with account balances kept accurate automatically.

Part of the **[Fulcrum Forge](../)** family of static web apps backed by Google Apps Script + Google Sheets.

## What it does

- **Capture** — log income, expenses, and transfers via the app, or by typing rows directly into the Google Sheet
- **Maintain balances** — every transaction adjusts the affected accounts; edits use a two-phase reversal so balances stay exact
- **Multi-currency** — per-account currency with FX rates against a configurable base currency (default GBP); per-transaction `fx_rate` override for cross-currency transfers
- **Classify** — two-level category taxonomy (`major → minor`) scoped per transaction type
- **Analyse** — insight section with income/expense/net/savings-rate cards, monthly trend, drillable category breakdown, per-account spend
- **Manage accounts** — 13 account types across Asset and Liability groups with type-specific fields (loan terms, credit limit, overdraft, investment platform, …)

Full capability list and out-of-scope items: **[_docs/overview.md](_docs/overview.md)**.

## Architecture

```
Browser  ──HTTPS──>  Google Apps Script Web App  ──Sheets API──>  Google Sheet
   ▲                       (backend logic)                       (source of truth)
   │
   └─ Static SPA: vanilla JS ES modules, no build step, no framework
```

- **Frontend**: vanilla JS ES modules; loads `index.html` and runs as-is — no bundler.
- **Backend**: Google Apps Script V8 runtime; ~22 `.gs` modules organised by domain (accounts, transactions, categories, rates, advisor).
- **Store**: a single Google Sheet with one tab per entity (`transactions`, `accounts`, `categories`, `rates`, `_audit`).
- **Auth**: PIN + optional TOTP gate with IP-based rate limiting.

## Repository structure

| Folder | Purpose | Read |
|---|---|---|
| `app/` | Frontend SPA — sections, state, design system | [app/README.md](app/README.md) |
| `api/` | Apps Script source — `.gs` modules grouped by domain | [api/README.md](api/README.md) |
| `cicd/` | Deploy pipeline (`script-deployment.sh`) and first-time setup | [cicd/README.md](cicd/README.md) |
| `_docs/` | Language-agnostic requirements — anyone can rebuild in any stack | [_docs/README.md](_docs/README.md) |
| `_tasks/` | Internal task notes from in-flight development |  |

## Quick start

**First time on a fresh machine:**

1. Install + authenticate the GAS CLI: `npm install -g @google/clasp && clasp login`
2. Follow first-time setup (Sheet + Apps Script project + secrets + deployment IDs): **[cicd/README.md § First-time setup](cicd/README.md#first-time-setup-per-environment)**
3. Fill in your dev `/exec` URL in `app/config.js` (and the prod one when you set prod up)

**Day-to-day development:**

- Edit frontend (`app/*`) — refresh the browser; no deploy needed. The runtime hostname detection in `config.js` picks dev locally / prod when hosted.
- Edit backend (`api/*.gs`) — push and deploy via the pipeline:
  ```bash
  bash forge/deploy.sh        # interactive: pick app + env
  # or directly:
  bash cicd/script-deployment.sh dev "expense-tracker: <change description>"
  ```
  The pipeline is backend-only: `clasp push` (GAS draft) → `clasp deploy` (live `/exec`) → `.clasp.json` placeholder revert. **Git operations are NOT performed by the script** — commit and push manually. Details: **[cicd/README.md](cicd/README.md)**.

**Where to look when:**

- Designing UI / writing frontend code → [app/README.md](app/README.md)
- Editing backend logic → [api/README.md](api/README.md)
- Deploying changes → [cicd/README.md](cicd/README.md)
- Understanding *what* the app does, not *how* → [_docs/](_docs/)

## Tech reference

| Layer | Choice |
|---|---|
| Frontend | Vanilla JavaScript ES modules, no framework, no build step |
| Charting | Chart.js 4.x via CDN |
| Backend runtime | Google Apps Script V8 |
| Store | Google Sheets |
| Auth | PIN + RFC 6238 TOTP (HMAC-SHA1, ±1 window) |
| CLI | [`clasp`](https://github.com/google/clasp) for local-to-GAS sync |
| Design tokens | Shared CSS variables from `forge/_shared/style-tokens.css` |

None of these are load-bearing requirements. The reference choices are documented in `_docs/README.md § Building this in any language` along with substitution candidates.

## Documentation map

```
_docs/
├── README.md             ← index
├── overview.md           ← domain model, capabilities, scope
├── data-model.md         ← all entity schemas in one place
├── accounts.md           ← types, balance convention, derived fields
├── transactions.md       ← three types, filters, FX handling
├── balance-lifecycle.md  ← how current_balance changes (two-phase reversal)
├── financial-rules.md    ← the six hard-block validation rules
├── categories.md         ← two-level taxonomy + account-type hints
├── rates.md              ← FX rates, upsert, conversion function
├── insight.md            ← summary cards, charts, date range
└── raw-requirement.md    ← original product brief (historical)
```

All docs are language- and platform-agnostic. They describe *what* the app does, not *how* the reference implementation happens to do it.
