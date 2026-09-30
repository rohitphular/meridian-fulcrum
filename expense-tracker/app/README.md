# Expense Tracker — Frontend

Single-page app written in vanilla JavaScript ES modules. No framework, no bundler, no build step. Serve the repository over HTTP and open `/expense-tracker/app/`.

## Why vanilla

- Static files run directly in the browser; Apps Script serves the API.
- Every file you see in this folder is exactly what ships.

## File layout

```
app/
├── index.html              entry — shell, auth overlay, tab nav, mounts
├── main.js                 boots auth, loads schemas, wires tab nav → section renderers
├── config.js               committed hostname-based dev/prod GAS /exec selection
├── core/                   cross-cutting modules
│   ├── state.js              single mutable state object (the source of truth)
│   ├── api.js                ExpenseAPI — typed wrappers over fetch(SCRIPT_URL)
│   ├── auth.js               PIN + TOTP gate, expiring PIN session in sessionStorage
│   ├── schema.js             loads account/transaction/category schemas from the backend
│   ├── nav.js                showSection(name) — swaps visible tab content
│   ├── daterange.js          this_month / last_30 / custom filter for transactions
│   ├── date-utils.js         timezone-aware balance snapshot comparisons
│   ├── utils.js              el, esc, fmtDateTime, fmtNative, fmtBase, exportData …
│   └── ui.js                 re-exports loading/toast helpers from expense-tracker/_shared/ui.js
├── sections/               one module per tab; each exports a render<Name>() function
│   ├── insights.js           summary cards, charts
│   ├── transactions.js       filterable + sortable single-leg ledger and transfer entry
│   ├── accounts.js           accounts table + net-worth summary
│   ├── categories.js         category tree (major → minor) with archive toggle
│   ├── rates.js              FX rates per currency (base = XAU; selectable display currency)
│   ├── subscriptions.js      recurring payment definitions and CSV import
│   ├── configure.js          collapsible Account Types configuration
│   └── advisor.js            LLM chat panel
└── style/
    └── expense-tracker.css   all app styles — light + dark themes
```

Design tokens (`--ink`, `--ember`, `--teal`, type scale, fonts) live in `../_shared/style-tokens.css` and are linked from `index.html`. Do not redefine them locally.

## How it boots

1. `index.html` links `_shared/style-tokens.css` then `style/expense-tracker.css`, loads `config.js` (sets `window.CONFIG.SCRIPT_URL`), then `main.js` as `type="module"`.
2. `main.js` checks the local six-hour PIN session. No valid local session → show PIN gate; otherwise initialise the API client and load data. Every API request validates the PIN server-side.
3. Schemas are loaded onto `state`; account, category, account-type and subscription schemas refresh on each load. The transaction schema uses a versioned cache.
4. The saved section renders, defaulting to Home. Clicking a tab calls `showSection(name)` which calls the section's `renderXxx()`.
5. Refresh validates every entity/schema response before assigning one complete snapshot. A failed dependency preserves the previous view and displays its error. Only the latest requested refresh may commit; an older response cannot replace newer data. The header refresh icon button reloads Sheet changes and sync acknowledgements.
6. On any data mutation (save / delete), the section fires `document.dispatchEvent(new CustomEvent('et:reload'))` — `main.js` listens, refetches, and re-renders the current section.

Row-based mutations include `expected_id` and, when available, `expected_updated_at` from the displayed snapshot. The backend rejects a moved or concurrently edited row with `stale_record`. Refresh remaps open account/category/transaction/subscription selections by UUID before replacing the arrays. Account Types retains its draft identity and timestamp. On a stale-record message, refresh and reopen the record before retrying.

Sign-in suppresses repeated submissions, clears the PIN/TOTP inputs after success, and re-enables Unlock if authentication is required again. Optional IP geolocation stops waiting after three seconds and falls back to unavailable metadata.

## State model

`core/state.js` exports a single mutable object. There is no Redux, no observers. Sections read from it directly and mutate it directly, then call their own `renderXxx()` to repaint.

```js
state.transactions   // [] of tx rows
state.accounts       // [] of accounts
state.accountMap     // { 'acc-001': account } — keyed lookup
state.categories     // [] of categories
state.rates          // [] of FX rates
state.rateMap        // currency units per 1g XAU; XAU = 1
state.quoteCurrency  // 'GBP'

state.dateRange / customFrom / customTo   // insight + tx filter
state.filters                              // transactions filter bar
state.txSort / txPage / txPerPage          // tx table state

state.txAddOpen / txViewRow / txEditRow / txDeleteRow   // tx form state
state.accAddOpen / accViewRow / accEditRow / accDeleteRow
state.catAddOpen / catViewRow / catEditRow / catDeleteRow
// … same shape for rates
```

Each section owns its own `xxxAddOpen` / `xxxViewRow` / `xxxEditRow` / `xxxDeleteRow` keys. Set one, call `renderXxx()`, the right card appears.

## Section pattern

```
┌─ sec-head ────────────────────────────────────┐
│ <h2>Section</h2>             [+ Add / × Close]│
├───────────────────────────────────────────────┤
│ Add form (card)        — shown if xxxAddOpen   │
│ View card              — shown if xxxViewRow   │
│ Edit form (card)       — shown if xxxEditRow   │
├───────────────────────────────────────────────┤
│ Summary (where applicable)                     │
│ Table   — desktop                              │
│ Cards   — mobile (same data, different layout) │
└───────────────────────────────────────────────┘
```

- **One render function per section.** Sets `innerHTML`, then attaches events. No setTimeout — bind synchronously.
- **Event delegation.** Action buttons carry `data-action="tx-edit"` + `data-row="42"`. A single listener on the section container fans out to handlers.
- **No inline expansions in tables.** View/Edit always render above the table as a `.card`. Delete confirmation stays in the row on desktop and in the corresponding card on mobile, including blocked-deletion recovery actions.
- **Cards mirror table rows on mobile.** Desktop sees the table; at 640px and below the table hides and the cards show. Header and pagination controls wrap, form controls use a 16px font, and primary actions have a minimum 44px touch target.
- **Transaction drafts survive suggestion updates.** An asynchronous suggestions response and expanding/collapsing that panel update only the panel. They do not recreate the add/edit form.
- **Transaction precision.** Entry, edit, copy and CSV export retain decimal amount text. Blank target amounts default only for same-currency transfers; cross-currency transfers require a target amount. Editing another field preserves the original seconds and fractional seconds when the displayed minute is unchanged.

## CSV import and export

Every CSV import (account types, categories, accounts and detail tabs, subscriptions, transactions) sends the raw file text to that entity's own import endpoint, which parses and validates it on the server (`api/csv-import.gs` plus `api/<entity>-import.gs`). The browser has no CSV parser, preview or client-side validation. The server accepts quoted commas, escaped quotes and multiline text, keeps monetary amounts as decimal strings, and rejects the whole file with line-numbered errors when headers or row formats are invalid, writing nothing. Otherwise it imports the file in one request and returns per-row results carrying the CSV line, which the panel shows as a summary and a failure table. There is no failed-rows retry: correct the file and import it again (rows are matched by UUID; rows without an id are added again each time, which the transaction panel warns about). Imports do not geocode location text. Endpoints also accept `dry_run: true`, which validates without reading or writing any Sheet (used by `make factory-reset`). Imports cannot be started twice while their current request is running. GAS requests have a 60-second read deadline and a 180-second write deadline; timed-out writes may still finish on the server, and the client never automatically repeats them. Optional location lookups have a five-second deadline and leave the supplied location unchanged when unavailable.

Transaction exports use `transaction_master` as the filename, retain `record_status`, and put a standalone money-in amount on its target account. The compact import format represents a transfer as one row with shared metadata. If its legs were independently edited, have different lifecycle statuses, or include historical deleted children, app export stops with an explanation instead of silently losing those differences. Use a direct export of the `transaction_master` Sheet when both original rows and their history are needed.

Date filters compare the recorded calendar date using numeric date components, avoiding browser-dependent parsing of space-separated Sheet timestamps. Suggestions use an account-specific identity and cache version 2 so identical merchants in different accounts/currencies remain distinct.

## Design system

**Tokens** (`_shared/style-tokens.css`):

| Group | Tokens |
|---|---|
| Colour | `--ink`, `--canvas`, `--panel`, `--ember`, `--ember-soft`, `--teal`, `--teal-soft`, `--muted`, `--hair`, `--hair-strong`, `--row-hover` |
| Type   | `--grotesk` (sans), `--mono` |
| Scale  | `--text-2xs` 10px · `--text-xs` 11px · `--text-sm` 12px · `--text-base` 13.5px · `--text-md` 14px · `--text-lg` 15px · `--text-xl` 18px · `--text-2xl` 20px · `--text-3xl` 22px |

Never use literal px font sizes in code or styles. Pick the closest token. Mobile controls also use `--text-input-mobile` (16px) and `--touch-target` (44px).

**Dark mode.** Toggling `[data-theme="dark"]` on `<html>` rebinds the colour tokens — no per-rule overrides needed. The theme button in the header persists choice to `localStorage`.

**Brand wordmark.** `<span class="brand-dim">Expense</span> <span class="brand-ember">Tracker</span>` — first word muted weight-400, second word ember. Use it consistently anywhere the app name appears.

## UX patterns

- **Sticky header** with brand, display-currency picker, theme toggle, and tab nav.
- **Card-form-above-table** for view/edit on every section — never inline row expansion.
- **Filter bar** (transactions) — collapsible, summarises active filters with a count.
- **Loading overlay** (`showLoading()` / `hideLoading()`) — used for every network call.
- **Toast** (`showMsg(text)`) — non-blocking confirmations.
- **Number formatting** — `fmtNative(amount, currency)` for source-currency; `fmtBase(amount, currency, fxRate)` for the selected display-currency equivalent.

## Local verification

Run `node --test expense-tracker/tests/*.cjs` from the repository root. `mobile-daily-use-review.cjs` covers sign-in recovery, refresh races, stale identities, transaction precision and transfer copying, draft preservation, mobile confirmation rendering and the precomputed-insight response envelope. Browser layout checks use synthetic data and block external requests; they do not write to Sheets or PostgreSQL. A September 25 review verified Chrome mobile viewports at 320, 390 and 640px, including confirmation visibility, touch targets, viewport overflow and transaction entry. `frontend-final-review.cjs` covers multiline CSV/decimal preservation, malformed headers, file-read races, uncertain write results, transfer-export guards, portable date filters, suggestion identity and HTTP deadlines. Browser checks also exercise valid/invalid CSV button state. Physical iOS/Android keyboard and deployed GAS integration still require device testing.

## Adding a new section

1. Create `sections/<name>.js` exporting `renderName()`.
2. Add `xxxAddOpen` / `xxxViewRow` / `xxxEditRow` / `xxxDeleteRow` to `core/state.js`.
3. Import the render function in `core/nav.js` and add it to the tab dispatcher.
4. Add `<button class="tab-btn" data-section="<name>">Label</button>` to the tab nav in `index.html`.
5. Style with existing tokens. Do not introduce new colours unless they're added to `_shared/style-tokens.css` first.

## Running locally

Run from the `meridian-fulcrum` repository root so the app and its shared assets are served together:

```bash
python3 -m http.server 8000
# Open http://localhost:8000/expense-tracker/app/
```

ES modules do not run over `file://`. Serving only `app/` hides the sibling `_shared/` assets. Local hosting selects the dev API in `config.js`.

Frontend changes are NOT shipped via the deploy script — they only need a `git commit && git push` (GitHub Pages publishes the main branch automatically). The deploy script in `cicd/deploy.sh` handles backend-only operations (`clasp push` + `clasp deploy`). See `cicd/README.md` and `api/README.md` for the push-vs-deploy distinction.
