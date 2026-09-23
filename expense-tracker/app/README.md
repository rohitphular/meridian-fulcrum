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
│   ├── utils.js              el, esc, fmtDateTime, fmtNative, fmtBase, exportData …
│   └── ui.js                 re-exports loading/toast helpers from expense-tracker/_shared/ui.js
├── sections/               one module per tab; each exports a render<Name>() function
│   ├── insights.js           summary cards, charts
│   ├── transactions.js       filterable + sortable list (largest module — ~1200 lines)
│   ├── accounts.js           accounts table + net-worth summary
│   ├── categories.js         category tree (major → minor) with archive toggle
│   ├── rates.js              FX rates per currency (base = XAU; selectable display currency)
│   └── advisor.js            LLM chat panel
└── style/
    └── expense-tracker.css   all app styles — light + dark themes
```

Design tokens (`--ink`, `--ember`, `--teal`, type scale, fonts) live in `../_shared/style-tokens.css` and are linked from `index.html`. Do not redefine them locally.

## How it boots

1. `index.html` links `_shared/style-tokens.css` then `style/expense-tracker.css`, loads `config.js` (sets `window.CONFIG.SCRIPT_URL`), then `main.js` as `type="module"`.
2. `main.js` checks the local six-hour PIN session. No valid local session → show PIN gate; otherwise initialise the API client and load data. Every API request validates the PIN server-side.
3. Schemas are fetched once (`loadAccountSchema`, `loadTransactionSchema`, `loadCategorySchema`) and stored on `state`.
4. The saved section renders, defaulting to Home. Clicking a tab calls `showSection(name)` which calls the section's `renderXxx()`.
5. Refresh validates every entity/schema response before assigning one complete snapshot. A failed dependency preserves the previous view and displays its error.
6. On any data mutation (save / delete), the section fires `document.dispatchEvent(new CustomEvent('et:reload'))` — `main.js` listens, refetches, and re-renders the current section.

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
- **No inline expansions in tables.** View/Edit always render above the table as a `.card`. Delete confirmation stays inline (one-line confirm).
- **Cards mirror table rows on mobile.** Desktop sees the table; below 640px the table hides and the cards show.

## Design system

**Tokens** (`_shared/style-tokens.css`):

| Group | Tokens |
|---|---|
| Colour | `--ink`, `--canvas`, `--panel`, `--ember`, `--ember-soft`, `--teal`, `--teal-soft`, `--muted`, `--hair`, `--hair-strong`, `--row-hover` |
| Type   | `--grotesk` (sans), `--mono` |
| Scale  | `--text-2xs` 10px · `--text-xs` 11px · `--text-sm` 12px · `--text-base` 13.5px · `--text-md` 14px · `--text-lg` 15px · `--text-xl` 18px · `--text-2xl` 20px · `--text-3xl` 22px |

Never use literal px font sizes in code or styles. Pick the closest token.

**Dark mode.** Toggling `[data-theme="dark"]` on `<html>` rebinds the colour tokens — no per-rule overrides needed. The theme button in the header persists choice to `localStorage`.

**Brand wordmark.** `<span class="brand-dim">Expense</span> <span class="brand-ember">Tracker</span>` — first word muted weight-400, second word ember. Use it consistently anywhere the app name appears.

## UX patterns

- **Sticky header** with brand, display-currency picker, theme toggle, and tab nav.
- **Card-form-above-table** for view/edit on every section — never inline row expansion.
- **Filter bar** (transactions) — collapsible, summarises active filters with a count.
- **Loading overlay** (`showLoading()` / `hideLoading()`) — used for every network call.
- **Toast** (`showMsg(text)`) — non-blocking confirmations.
- **Number formatting** — `fmtNative(amount, currency)` for source-currency; `fmtBase(amount, currency, fxRate)` for the selected display-currency equivalent.

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
