# Fulcrum Forge — Expense Tracker

> This module belongs to the **Fulcrum Forge** family. Every Forge module is a
> self-contained static web app backed by a Google Apps Script Web App on a
> Google Sheet. They share `_shared/sheets-client.js` (HTTP layer) and
> `_shared/style-tokens.css` (design tokens) and use the same PIN + TOTP auth
> gate. Modules are independent — no shared backend, no framework, no bundler.

---

## 1. Overview

The **Expense Tracker** is a personal income/expense module. It lets you log
transactions and analyse spending patterns. It is the Forge's financial journal:
a record of what you *earn and spend*, with multi-currency accounts and
categorised flows.

**Dual capture model:** You can add transactions directly from the app (preferred
for mobile use), or type rows straight into the Google Sheet — both paths land in
the same `transactions` tab and are equally valid. The sheet is the source of
truth; the app is both a capture tool and an analysis platform.

---

## 2. Scope & decisions

| Decision | Choice | Reason |
|---|---|---|
| Auth | PIN + TOTP | Forge security convention |
| Hosting | Static file (GitHub Pages or `file://`) | No server, no build step |
| HTTP layer | `_shared/sheets-client.js` | Shared across all Forge modules |
| Rates | `rates` sheet tab, editable from app | Standard Forge rates handling |
| Charts | Chart.js 4.x via CDN | Lightweight, no build step |
| Write capability | Yes — add transactions from the app | Capture happens where the user is |
| Categories | 3-level controlled hierarchy in a `categories` tab | Dependent dropdowns in Sheet; cascade in app form |
| Accounts | Named accounts in an `accounts` sheet tab | Dropdown in the add-transaction form |
| Base currency | GBP default, switchable in the header | Forge convention |
| Pagination | Client-side; 50 rows per page | Transactions can grow large |
| Export | CSV + JSON of the filtered view | For future database import |

**Out of scope for v1:** recurring transactions, budget limits, bank/API integrations,
edit/delete of logged transactions, write-back from the categories or accounts tabs.

---

## 3. File layout

```
forge/expense-tracker/
  _shared/                     ← symlink / relative path to forge/_shared/
  app/
    index.html                 ← app shell (HTML + tab structure)
    expense-tracker.js         ← all module logic
    expense-tracker.css        ← module-specific styles
    config.example.js          ← committed template (SCRIPT_URL placeholder)
    config.js                  ← actual URL (gitignored)
  backend/
    Code.gs                    ← doGet + doPost + onEdit cascade
    appsscript.json            ← Apps Script manifest
  cicd/README.md               ← first-time + subsequent deployment steps
```

`index.html` links `../../_shared/style-tokens.css`, `../../_shared/sheets-client.js`,
`config.js`, Chart.js CDN, then `expense-tracker.js`.

---

## 4. Sheet tabs

### 4.1 `transactions`

Row 1 is the header (map by name; tolerate extra/blank columns):

```
id | date | transaction_type | amount | currency | account | major_category | minor_category | counterparty | notes | tags | transfer_id | fx_rate | country | payment_method
```

| Column | Type | Required | Example | Rules |
|---|---|---|---|---|
| `id` | text | yes | `2026-06-14-001` | Unique, stable. Never reused. Dedupe key. |
| `date` | date | yes | `2026-06-14` | ISO `YYYY-MM-DD`. |
| `transaction_type` | enum | yes | `money-out` | `money-in` / `money-out` / `money-transfer`. Carries direction. |
| `amount` | number | yes | `42.50` | Always **positive**. |
| `currency` | text | yes | `GBP` | ISO code. Must exist in the rates tab (warn if missing). |
| `account` | text | yes | `HDFC Savings` | Must match a name in the `accounts` tab. |
| `major_category` | text | yes | `Food` | Controlled by `categories` tab (depends on transaction_type). |
| `minor_category` | text | yes | `Groceries` | Controlled by `categories` tab (depends on major_category). |
| `counterparty` | text | no | `Tesco` | Payee / payer. Use the lender name for debt-related rows. |
| `notes` | text | no | `weekly shop` | Free text. |
| `tags` | text | no | `reimbursable;work` | Semicolon-separated. |
| `transfer_id` | text | no | `T-2026-06-14-1` | Links the two legs of a transfer. Both rows share the same value. |
| `fx_rate` | number | no | `105.2` | Rate to the base currency on that date. Overrides the static rate from the `rates` tab for that row. |
| `country` | text | no | `UK` | Country where the transaction occurred. For slicing. |
| `payment_method` | text | no | `card` | `card` / `cash` / `bank` / `UPI` / other. |

**Transfer model:** A `money-transfer` is always **two rows** sharing one
`transfer_id` — one leg leaving the source account, one entering the destination
(currencies may differ). Transfers are **excluded from income/expense totals** but
shown separately as account flows. The app enforces this by checking
`transfer_id` pairing; unpaired transfer rows get a warning badge.

**Currency handling:**
- Store the native transaction currency only. Convert to the selected base at
  view time using the `rates` tab.
- If a row has `fx_rate`, prefer it for that row; fall back to the static rate.
  Flag rows using row-level rates with a footnote badge.
- If a currency is missing from the `rates` tab: show a warning, treat the rate
  as 1:1, never drop the row.

### 4.2 `categories`

One row per leaf node:

```
transaction_type | major_category | minor_category
```

Used by the Apps Script `onEdit` cascade (for direct sheet editing) and by the
app's add-transaction form (fetched via API).

**Seed tree:**

**money-in:**
- Salary → Monthly pay, Bonus, Commission, Overtime
- Freelance / Self-employed → Client payment, Consulting, Royalties
- Business → Sales revenue, Service income
- Investments → Dividends, Interest earned, Capital gains, Rental income
- Refunds & reimbursements → Tax refund, Work reimbursement, Purchase refund, Cashback & rewards
- Borrowing → Loan received, Credit drawn, Money from friend/family
- Gifts & other → Gift received, Sale of asset, Other income

**money-out:**
- Housing → Rent, Mortgage, Council/Property tax, Repairs & maintenance, Home insurance
- Utilities → Electricity, Gas, Water, Internet, Mobile/Phone, Streaming/TV
- Food → Groceries, Eating out, Takeaway/Delivery, Coffee & snacks
- Transport → Fuel, Public transport, Taxi/Rideshare, Vehicle insurance, Vehicle maintenance, Parking & tolls
- Health → Doctor/Medical, Pharmacy, Dental, Optical, Health insurance, Fitness/Gym
- Shopping → Clothing, Electronics, Household goods, Personal care, Furniture
- Entertainment → Subscriptions, Events & movies, Hobbies, Books & media, Sports
- Travel → Flights, Accommodation, Local transport, Activities, Travel insurance
- Education → Tuition & fees, Courses, Books & supplies
- Family & dependents → Childcare, School fees, Family support, Pet care
- Debt & finance → Loan repayment, Credit card payment, Interest & charges, Bank fees
- Insurance → Life insurance, General insurance
- Taxes → Income tax, Other taxes
- Gifts & donations → Gift given, Charity/Donation
- Lending → Money lent to friend/family
- Other → Cash spending, Miscellaneous, Uncategorised

**money-transfer:**
- Between own accounts → Account to account, To savings, From savings
- Cross-border → UK to India, India to UK
- Currency exchange → FX conversion
- Cash → ATM withdrawal, Cash deposit
- Card payment → Pay credit card
- Investments → To investment, From investment, To pension

> **Convention note (document in deployment guide):** A credit-card payment is
> `money-transfer → Card payment → Pay credit card` when the credit card is
> tracked as its own account. If credit cards
> are not tracked as accounts, log it as `money-out → Debt & finance → Credit card
> payment`. Pick one convention and stick to it — mixing the two causes double-
> counting.

### 4.3 `accounts`

```
name | currency | type | notes
```

| Column | Type | Example | Notes |
|---|---|---|---|
| `name` | text | `HDFC Savings` | Must match the `account` field in transactions. |
| `currency` | text | `INR` | Default currency for transactions on this account. |
| `type` | text | `savings` | `savings` / `current` / `credit` / `cash` / `investment` / other. |
| `notes` | text | `primary India account` | Optional. |

The `accounts` tab is managed directly in the Sheet. The app fetches it to
populate the account dropdown in the add-transaction form and the account filter.

### 4.4 `rates`

```
currency | rate | symbol | updated_at
```

Standard Forge `rates` schema. Units of currency per 1 GBP. GBP is the base
(rate = 1, read-only). Other currencies are editable from the Rates tab in the
app. Seeded with defaults on first load.

**Default seed:**

| Currency | Rate (per GBP) | Symbol |
|---|---|---|
| GBP | 1 | £ |
| INR | 105 | ₹ |
| USD | 1.27 | $ |
| EUR | 1.17 | € |
| AED | 4.66 | AED |

### 4.5 `audit_access`

One row per IP: tracks attempts, success/failure counts, lockout flag. 3 failed
PIN attempts locks the IP; unlock by setting `is_locked` to FALSE in the sheet.

---

## 5. Backend API contract

### Auth flow

1. `GET ?action=verify&totp=XXXXXX` — PIN + TOTP. Returns `{ ok: true }` or
   `{ ok: false, error: "auth" | "totp_invalid" | "locked" }`.
2. All subsequent requests carry the PIN in the query string (GET) or request body
   (POST). Apps Script validates on every call.

`SheetsClient.js` handles PIN injection and retries automatically.

### GET actions

| `action` | Parameters | Returns |
|---|---|---|
| `verify` | `totp` | `{ ok }` |
| `list_transactions` | — | `{ ok, data: Transaction[] }` |
| `list_categories` | — | `{ ok, data: Category[] }` |
| `list_accounts` | — | `{ ok, data: Account[] }` |
| `list_rates` | — | `{ ok, data: Rate[] }` |

### POST actions

| `action` | Payload | Effect |
|---|---|---|
| `create_transaction` | Transaction fields | Appends a row to `transactions`; generates `id` as `YYYY-MM-DD-NNN` (sequential per date) |
| `upsert_rate` | `{ currency, rate, symbol }` | Updates or inserts a row in `rates` |

> `create_transaction` is the only write action in v1. Edit and delete of
> transactions is out of scope; correct the row directly in the Sheet.

### Error responses

All errors: `{ ok: false, error: "string" }`. The app shows a banner and never
crashes on a bad response.

### `onEdit` cascade (for direct Sheet editing)

When a user edits the `transaction_type` cell in the `transactions` tab, the
`major_category` dropdown is rebuilt from the matching rows in `categories`.
When `major_category` changes, `minor_category` is rebuilt. This keeps direct
Sheet entry consistent with the controlled hierarchy.

---

## 6. Navigation

Five tabs:

| Tab | Contents |
|---|---|
| **Insight** | Summary cards + charts. Date-range and base-currency controls pinned to the header. |
| **Transactions** | Add-transaction form + filterable/paginated transaction table. |
| **Accounts** | Read-only list of accounts from the `accounts` tab (name, currency, type). |
| **Categories** | Read-only tree view of the categories hierarchy (for reference). |
| **Rates** | Exchange rate table, editable inline. Quote-currency picker. |

---

## 7. Insight tab

### Header controls (sticky)
- **Base currency selector** (default GBP) — reconverts all figures across the whole app on change.
- **Date range presets**: This month / Last month / Last 3 months / Last 6 months / Last 12 months / Year to date / All / Custom (from–to date pickers).
- **Theme toggle** (light ☽ / dark ☀), persisted in `localStorage`.

### Summary cards

4-grid (2×2 on mobile):

| Card | Value |
|---|---|
| Total income | Sum of `money-in` in the selected range, in base currency |
| Total expenses | Sum of `money-out` in the selected range, in base currency |
| Net | Income − Expenses (teal if positive, ember if negative) |
| Savings rate | Net / Income × 100 % |

Transfers are **excluded** from all four cards. A separate transfer-flows row sits
below the cards showing total transfer volume and number of transfer pairs.

### Charts (Chart.js 4.x)

1. **Income vs expenses by month** — grouped bar chart. Each month shows two bars
   (teal = income, ember = expenses). Current partial month uses a dashed/lighter
   fill. Max 24 months shown; older months truncated with a "show all" toggle.

2. **Spend by major category** — horizontal bar chart, sorted largest first. Top 8
   categories shown; remainder collapsed into "Other". Clicking a bar drills
   into the minor-category breakdown for that major category (same chart,
   back-button to return).

3. **Spend by account** — horizontal bar chart, sorted largest first. Clicking an
   account filters the transaction table to that account.

4. **Balance over time (optional / v1.1)** — cumulative net line chart. Requires
   consistent start_date to be useful; mark as v1.1.

All charts respect the active date-range and base-currency selection. All charts
update on filter change. Dark-mode colours read the `data-theme` attribute at
render time.

### Filters (collapsible filter bar, below header)

- Transaction type (multi-select: money-in / money-out / money-transfer)
- Account (multi-select, from accounts tab)
- Major category (multi-select, cascades to minor)
- Minor category (multi-select)
- Country (multi-select)
- Payment method (multi-select)
- Tag (free-text, matches any semicolon-separated tag)
- Free-text search (matches counterparty and notes, case-insensitive)

Active filters shown as dismissible chip badges below the filter bar.

---

## 8. Transactions tab

### Add-transaction form

Shown as a collapsible card (collapsed by default on mobile, expanded on desktop).
Fields:

| Field | Input | Required | Notes |
|---|---|---|---|
| Date | date picker | yes | Defaults to today |
| Transaction type | select (money-in / money-out / money-transfer) | yes | Drives category cascade |
| Account | select (from `accounts` tab) | yes | — |
| Amount | number | yes | Positive |
| Currency | select (from `rates` tab) | yes | Defaults to selected account's currency |
| Major category | select | yes | Options filtered by transaction_type |
| Minor category | select | yes | Options filtered by major_category |
| Counterparty | text | no | Free text |
| Country | text | no | Free text; optional |
| Payment method | select | no | card / cash / bank / UPI / other |
| Notes | text | no | Free text |
| Tags | text | no | Comma or semicolon separated; stored as semicolons |
| Transfer ID | text | no | Only shown when type = money-transfer; user generates (e.g. `T-YYYY-MM-DD-1`) |
| FX rate | number | no | Only shown when currency ≠ base currency |

On save: call `create_transaction`, show loading state on button, show success
banner, reload transactions. On error: show inline error, re-enable form.

### Transaction table

Columns (horizontal scroll on mobile):

`Date | Type badge | Account | Amount (native) | ≈ Base CCY | Major → Minor | Counterparty | Country | Method | Tags | Notes`

- **Type badge**: teal `in`, ember `out`, muted `transfer`
- Transfer rows show a link icon and are visually grouped if the `transfer_id`
  partner is visible in the current page
- Rows with missing `fx_rate` and the currency differs from base show a footnote marker
- Rows with unknown currencies show a warning badge

**Table controls:**
- Column sort (click header): date (default desc), amount, account, category
- Pagination: 50 rows per page with prev/next and page indicator
- **Export buttons** (above table, right-aligned): CSV and JSON of the *current
  filtered* rows (all pages, not just the visible page)

**Malformed rows:** Rows that fail schema validation (missing required field,
unknown transaction_type) are shown at the bottom with a warning badge, not
dropped. The header area shows a count: "3 rows have warnings — expand to review".

---

## 9. Rates tab

- Quote currency picker (sets the base currency for the whole app, persisted to `localStorage`)
- Exchange rates table: currency, symbol, rate (units per 1 GBP), last updated, Edit/Save/Cancel inline

GBP is read-only (base). Other currencies editable. Enter key saves; Escape cancels.
Button disable + "Saving…" text during save.

---

## 10. Design tokens & mobile-first

### Tokens

Use `_shared/style-tokens.css`. Do **not** hardcode hex values in module CSS.

```css
--ink         /* body text */
--canvas      /* page background */
--panel       /* card / table background */
--ember       /* money-out, warnings, attention (#DC5B3B light / #F07055 dark) */
--teal        /* money-in, positive, success (#0F9D8C light / #26C0B0 dark) */
--muted       /* secondary text */
--hair        /* light borders */
--hair-strong /* darker borders */
--row-hover   /* table row hover */
--grotesk     /* body/heading font */
--mono        /* numbers, codes */
```

### Color semantics for this module

| Context | Token |
|---|---|
| `money-in` | `--teal` |
| `money-out` | `--ember` |
| `money-transfer` | `--ink` / neutral |
| Net positive | `--teal` |
| Net negative | `--ember` |
| Warning / error | `--ember` |

### Mobile-first requirements

- Viewport meta tag, `theme-color` meta.
- Large tap targets (min 44px).
- Sticky header with tab nav that overflows horizontally.
- Collapsible filter bar (hidden by default on mobile).
- Collapsible add-transaction form (hidden by default on mobile).
- All charts are responsive (`maintainAspectRatio: false`): 220px height on mobile,
  300px on ≥640px.
- Transaction table: horizontal scroll, no column hiding (let the user scroll).
- Add-to-Home-Screen friendly: app loads and works offline if data is cached in
  sessionStorage (see §12).

### Dark mode

`data-theme` attribute on `<html>`, toggled by a `☽ / ☀` button in the header.
Charts read the attribute at render time to pick the correct palette. Preference
persisted to `localStorage` under key `et_theme`.

### Loading indicator

Global 3 px loading bar at the top of the page. `showLoading()` / `hideLoading()`
wrapped in `try/finally` on every async call.

---

## 11. Data-handling rules

- **Tolerant parsing:** map transactions by header name; skip-with-warning on
  malformed rows; one bad row must never crash the view.
- **Never store converted amounts** as source data; conversion is view-time only.
- **No sensitive data in `localStorage`.**  `sessionStorage` may cache the raw
  transaction payload for the session (avoids re-fetching on tab switch); cleared
  on browser close.
- **PIN** persisted to `sessionStorage` so re-fetches within the session don't
  require re-auth.
- **Transfers always excluded** from income/expense totals. If `transfer_id` is
  set, the row is a transfer regardless of `transaction_type`.
- **Append-only mindset:** each row is an immutable fact keyed by `id`. The app
  does not edit or delete existing rows.
- **Currency missing from rates:** warn, treat as 1:1, never drop.

---

## 12. Session & state

| Key | Store | Value |
|---|---|---|
| `et_pin` | sessionStorage | PIN (cleared on tab close) |
| `et_section` | sessionStorage | Active tab |
| `et_quote_currency` | localStorage | Selected base currency |
| `et_theme` | localStorage | `light` or `dark` |
| `et_transactions_cache` | sessionStorage | Raw API response (optional cache) |
| `et_date_range` | sessionStorage | Selected range preset + custom dates |

---

## 13. Backend — `Code.gs` functions

| Function | Purpose |
|---|---|
| `doGet(e)` | Routes GET actions: verify, list_transactions, list_categories, list_accounts, list_rates |
| `doPost(e)` | Routes POST actions: create_transaction, upsert_rate |
| `listTransactions()` | Reads `transactions` tab, maps by header, returns all rows |
| `createTransaction(body)` | Validates, generates `id`, appends row |
| `listCategories()` | Reads `categories` tab, returns all rows |
| `listAccounts()` | Reads `accounts` tab, returns all rows |
| `listRates()` | Reads `rates` tab; seeds defaults on first call |
| `upsertRate(body)` | Updates or inserts a rate row |
| `onEdit(e)` | Cascade: rebuilds major/minor dropdowns in `transactions` when transaction_type or major_category changes |
| `getOrCreateSheet(name, columns)` | Gets the named tab or creates it with the given headers; migrates missing columns |
| `checkPin(pin)` | PIN validation against Script Property |
| `verifyTotp(token)` | RFC 6238 TOTP, ±1 window |
| `checkLocked(ip)` | IP lockout check |
| `recordAccess(meta, success)` | Audit log update |

### Transaction ID generation

Format: `YYYY-MM-DD-NNN` where NNN is a zero-padded integer starting at `001`,
incremented for each transaction on the same date. The backend scans existing rows
to find the highest NNN for that date and increments.

---

## 14. Deployment guide outline

`cicd/README.md` must cover:

1. **Prerequisites:** Google account, the `_shared/` folder present locally.
2. **Create the Google Sheet:** create a new Sheet; all tabs are created
   automatically by the script on first request.
3. **Set up Apps Script:** paste `Code.gs`; save; open Project Settings; add
   Script Properties `PIN_SECRET` and `TOTP_SECRET`.
4. **Deploy as Web App:** Deploy → New deployment → Web app → Execute as Me →
   Anyone → Deploy → copy the `/exec` URL.
5. **Configure the app:** copy `config.example.js` → `config.js`; paste the URL.
6. **Seed the categories:** paste the seed tree rows (from §4.2 above) into the
   `categories` tab; or run the provided `seedCategories()` helper function in
   Apps Script once.
7. **Add your accounts:** add rows to the `accounts` tab manually before first use.
8. **Open the app locally** and verify auth works.
9. **Subsequent backend deployments:** Deploy → Manage deployments → Edit → New
   version → Deploy. URL unchanged.
10. **Operations reference:** unlock IP, reset PIN, reset TOTP, backup.

---

## 15. Acceptance criteria

1. On load, app fetches and renders summary cards + charts + transaction table for
   the default date range (this month) in GBP; shows a clear state if unreachable.
2. Changing base currency reconverts every figure across all cards, charts, and
   table rows.
3. A `money-transfer` pair (same `transfer_id`) is excluded from income/expense
   totals; visible as a transfer row with a link icon.
4. Spend-by-major-category chart drills into minor-category on click; back button
   returns.
5. All filters (type, account, category, country, method, tag, search) update
   summary cards, charts, and table simultaneously.
6. A currency missing from the rates tab warns visibly and shows 1:1 — no crash.
7. Export produces a correct CSV and JSON of all filtered rows (all pages).
8. Fully usable at iPhone width; large tap targets; horizontal table scroll.
9. Adding a transaction from the form appends it to the sheet and reloads the view.
10. Theme toggle switches light/dark; chart colours update; preference persists across sessions.
11. Malformed rows show a warning badge; they are not dropped from the table.
12. IP lockout works after 3 failed PIN attempts; `audit_access` tab is created automatically.

---

## 16. Out of scope for v1

- Edit or delete existing transactions from the app (fix in the Sheet directly)
- Recurring / templated transactions
- Budget targets or spending limits
- Bank API integrations or statement import
- Category / account management from within the app
- Shared / multi-user access
- Server-side filtering or aggregation (all filtering is client-side)
- Cumulative balance chart (planned for v1.1 once start-date data is established)
