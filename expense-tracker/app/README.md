# Expense Tracker — Frontend

Single-page app written in vanilla JavaScript ES modules. No framework, no bundler, no build step. Serve the repository over HTTP and open `/expense-tracker/app/`.

## A pure renderer

The browser renders what the GAS backend returns and nothing more. Each screen requests a view GET (`ExpenseAPI.view(action, params)`, see [api/README.md](../api/README.md#view-gets)) that comes back converted to the selected quote currency, aggregated, filtered, sorted, paged and labelled, with per-row `allowed_actions` / readonly flags. Forms load their choices from `get_*_form_options` and submit what the user typed; the server validates and answers with `{ error, field, message }`, which the form shows as-is.

Rules for frontend code:
- No currency conversion, sums, balances or net-worth math; no date-range or period math; no sort, filter, search or pagination of collections; no validation or business rules. Definitions live in [calculations](../_docs/calculations.md).
- Presentation only: number / date formatting of server values, colours for server tone / style / status keys, Chart.js configuration, UI state (open panel, applied query, filter draft), and input UX (geocoding, tag autocomplete over the server tag list, cascading selects that look values up in the server option tree).
- No raw collections in `state`: only `state.context` (`get_app_context`), `state.views` (the last payload per screen) and UI keys.
- Open panels hold record ids, never Sheet row numbers; mutations send `id` + `row_num` + `updated_at` of the row in hand (`stale_record` on the server catches moved or changed rows).

## Why vanilla

- Static files run directly in the browser; Apps Script serves the API.
- Every file you see in this folder is exactly what ships.

## File layout

```
app/
├── index.html              entry — shell, auth overlay, tab nav, mounts
├── main.js                 boots auth, loads get_app_context, wires tab nav → section renderers
├── config.js               committed hostname-based dev/prod GAS /exec selection
├── core/                   cross-cutting modules
│   ├── state.js              UI state + state.context / state.views (no entity collections)
│   ├── api.js                ExpenseAPI — view(action, params), POST mutations, auth hook
│   ├── auth.js               PIN + TOTP gate, expiring PIN session in sessionStorage
│   ├── nav.js                showSection(name) — swaps visible tab content
│   ├── utils.js              el, esc, fmtDateTime, downloadExport, import result / form error rendering …
│   └── ui.js                 re-exports loading/toast helpers from expense-tracker/_shared/ui.js
├── sections/               one module per tab; each exports a render<Name>() function
│   ├── home.js               renders get_home_view
│   ├── insights.js           insight shell: controls → get_insight params
│   ├── insights/render-kinds.js  generic renderer for get_insight payloads (Chart.js config only)
│   ├── insights/chart-theme.js   colours, value / tick formats, base chart options, drill table
│   ├── transactions.js       renders list_transactions_view + get_transaction_facets; transfer entry
│   ├── accounts.js           renders list_accounts_view (summary cards, groups)
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
3. `loadAll` requests `get_app_context` only (schemas, quote currencies, option trees, periods, insight registry) and checks each schema before committing it to `state.context` (plus `categorySchema`, `subscriptionSchema`, `accountTypeSchema` aliases). A failure keeps the previous context and names the failing schema. Only the latest requested refresh may commit or reopen the PIN gate.
4. The saved section renders, defaulting to Home. Clicking a tab calls `showSection(name)`, whose `renderXxx()` shows the last payload at once and requests its own view.
5. On any data mutation (save / delete), the section fires `document.dispatchEvent(new CustomEvent('et:reload'))` — `main.js` reloads the context and re-renders the current section, which refetches its view (the server cache key changes with `data_version`). The header refresh icon does the same.
6. An `auth` or `locked` answer to any view GET reopens the PIN gate (`ExpenseAPI.onAuthError`, registered by `main.js`).

Row-based mutations include `expected_id` and, when available, `expected_updated_at` from the row in hand. The backend rejects a moved or concurrently edited row with `stale_record`. Open panels are keyed by record id, so a refresh that moves Sheet rows cannot retarget them. On a stale-record message, refresh and reopen the record before retrying.

Sign-in suppresses repeated submissions, clears the PIN/TOTP inputs after success, and re-enables Unlock if authentication is required again. Optional IP geolocation stops waiting after three seconds and falls back to unavailable metadata.

## State model

`core/state.js` exports a single mutable object with UI state only. Sections read it directly, mutate it, then call their own `renderXxx()` to repaint.

```js
state.context        // get_app_context data (schemas, quote_currencies, options, periods, nav)
state.views          // last view payload per screen, e.g. views.list_accounts_view
state.quoteCurrency  // 'GBP' — sent with every view GET
state.filters        // deep link into Transactions (assign a new object, then navigate)

state.accAddOpen / accViewRow / accEditRow / accDeleteRow   // panels hold account ids
state.catAddOpen / catViewRow / catEditRow / catDeleteRow   // category ids
state.subAddOpen / subEditRow / subDeleteRow                // subscription ids
state.accountTypePanel / accountTypeViewId / accountTypeExport …
state.insightId / insightPeriod / insightTab / insightDrill / insightParams
```

Transactions keeps its applied query, filter draft, facets and open panel in module scope.

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
- **Event delegation.** Action buttons carry `data-action="acc-menu"` + `data-row="<record id>"`. A single listener on the section container fans out to handlers.
- **No inline expansions in tables.** View/Edit always render above the table as a `.card`. Delete confirmation stays in the row on desktop and in the corresponding card on mobile, including blocked-deletion recovery actions.
- **Cards mirror table rows on mobile.** Desktop sees the table; at 640px and below the table hides and the cards show. Header and pagination controls wrap, form controls use a 16px font, and primary actions have a minimum 44px touch target.
- **Transaction drafts survive suggestion updates.** An asynchronous suggestions response and expanding/collapsing that panel update only the panel. They do not recreate the add/edit form.
- **Transaction precision.** Entry, edit, copy and CSV export retain decimal amount text. Blank target amounts default only for same-currency transfers; cross-currency transfers require a target amount. Editing another field preserves the original seconds and fractional seconds when the displayed minute is unchanged.

## CSV import and export

Every CSV import (account types, categories, accounts and detail tabs, subscriptions, transactions) sends the raw file text to that entity's own import endpoint, which parses and validates it on the server (`api/csv-import.gs` plus `api/<entity>-import.gs`). The browser has no CSV parser, preview or client-side validation. The server accepts quoted commas, escaped quotes and multiline text, keeps monetary amounts as decimal strings, and rejects the whole file with line-numbered errors when headers or row formats are invalid, writing nothing. Otherwise it imports the file in one request and returns per-row results carrying the CSV line, which the panel shows as a summary and a failure table. There is no failed-rows retry: correct the file and import it again (rows are matched by UUID; rows without an id are added again each time, which the transaction panel warns about). Imports do not geocode location text. Endpoints also accept `dry_run: true`, which validates without reading or writing any Sheet (used by `make factory-reset`). Imports cannot be started twice while their current request is running. GAS requests have a 60-second read deadline and a 180-second write deadline; timed-out writes may still finish on the server, and the client never automatically repeats them. Optional location lookups have a five-second deadline and leave the supplied location unchanged when unavailable.

Exports download what the server builds (`export_transactions`, `export_accounts`, `export_account_types` return `{ filename, columns, rows }`; subscriptions and categories download their list view with `page_size=all`). Account and account-type exports always cover every row regardless of filters, so they are complete restore points. Transaction exports use `transaction_master` as the filename, retain `record_status`, and put a standalone money-in amount on its target account. The compact import format represents a transfer as one row with shared metadata. If its legs were independently edited, have different lifecycle statuses, or include historical deleted children, app export stops with an explanation instead of silently losing those differences. Use a direct export of the `transaction_master` Sheet when both original rows and their history are needed.

Date filters and buckets are applied on the server using the recorded calendar date. Suggestions use an account-specific identity (cache key `et_suggestions_v3`) so identical merchants in different accounts/currencies remain distinct; retired browser caches (`et_transaction_schema_v1`, `et_metadata_v1`, `et_suggestions_v2`) are cleared on start.

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
- **Number formatting** — views return native and quote amounts (and usually display strings); sections only format them (`toLocaleString`, `fmtValue(value, format, sym)` for insights). Changing the display currency re-requests the active view.

## Local verification

Run `node --test expense-tracker/tests/*.cjs` from the repository root. `mobile-daily-use-review.cjs` covers sign-in recovery, refresh races, stale identities, transaction precision and transfer copying, draft preservation, mobile confirmation rendering and the view auth hook. Browser layout checks use synthetic data and block external requests; they do not write to Sheets or PostgreSQL. A September 25 review verified Chrome mobile viewports at 320, 390 and 640px, including confirmation visibility, touch targets, viewport overflow and transaction entry. `frontend-final-review.cjs` covers multiline CSV/decimal preservation, malformed headers, file-read races, uncertain write results, transfer-export guards, portable date filters, suggestion identity and HTTP deadlines. Browser checks also exercise valid/invalid CSV button state. Physical iOS/Android keyboard and deployed GAS integration still require device testing.

## Adding a new section

1. Create `sections/<name>.js` exporting `renderName()`.
2. Add a view GET for it in a backend view file (registered through its hook), and `xxxAddOpen` / `xxxViewRow` / … UI keys to `core/state.js`.
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
