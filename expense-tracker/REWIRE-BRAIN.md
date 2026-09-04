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

## Data model essentials

| Concept | Reality |
|---|---|
| **Base currency** | XAU — 1 gram of gold. All cross-currency totals convert to XAU. Never GBP. |
| **Transaction model** | Single-leg. Each row has one `account_id` + `tx_amount`. A transfer between two accounts is two rows linked via `parent_tx_id`. No `money-transfer` tx_type; no `source_account`/`target_account` on rows; no `fx_rate` column. |
| **Lifecycle field** | `record_status` (`active` / `inactive` / `deleted` / `locked`). There is no `is_active` field anywhere in the codebase. |
| **Balance field** | `current_value` on accounts. Not `current_balance`. System-managed — never written directly via the account API. |
| **Timestamp field** | `tx_date_local` on transactions. Not `transaction_date_utc`. |

---

## What is built

| Feature | Status |
|---|---|
| Transactions — create / edit / delete (money-in, money-out, transfer) | ✓ Done |
| Accounts — 13 types (current, savings, loan, credit card, crypto, …) | ✓ Done |
| Automatic balance tracking — two-phase reversal on edit/delete | ✓ Done |
| Multi-currency — per-account currency, FX rates, XAU base-currency conversion | ✓ Done |
| Categories — two-level taxonomy (major → minor), account-type hints | ✓ Done |
| FX Rates — manage rates, auto-seeded with GBP/INR/USD/EUR/AED defaults | ✓ Done |
| Subscriptions — 22-column schema, full CRUD, bulk CSV import, filter bar, sortable table, status icons, context menu, locked/deleted guard, auto-expiry | ✓ Done |
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
| `app/sections/subscriptions.js` | Subscriptions section — filter bar, sortable table, context menu, bulk import |
| `api/app-router.gs` | All backend actions wired here |
| `api/app-config.gs` | Sheet name constants |
| `api/subscription-schema.gs` | Subscription field registry (22 columns, append-only positions) |
| `api/subscription-core.gs` | Subscription CRUD — create, list, update, delete, bulk import |
| `api/subscription-validation.gs` | Subscription field validation and error codes |
| `cicd/envs.json` | Script IDs + Deployment IDs for dev + prod |

---

## Where to read more

| Topic | Doc |
|---|---|
| Adding a new backend domain | `../building-standards/APP-BE-GSCRIPT.md` |
| Adding a new frontend section | `../building-standards/APP-FE-VANILLA.md` |
| Auth implementation details | `../building-standards/APP-AUTH-PIN-TOTP.md` |
| Deploy pipeline internals | `../building-standards/APP-CICD-PATTERNS.md` |
| Design system + UX patterns | `../building-standards/UX-DESIGN-FULCRUM.md` |
| Naming conventions | `../building-standards/APP-CONVENTIONS.md` |
| Logging standards | `../building-standards/APP-LOGGING-PATTERNS.md` |
| Shared utilities catalog | `../building-standards/APP-SHARED-CODE.md` |
| Domain requirements (what the app does) | `_docs/README.md` |

---

## Recent changes (Rounds 1–14)

Changes made during documentation and bug-fix passes. Listed newest-first.

### Round-14 fix pass — Accounts, Transactions, Subscriptions, Categories (Round 14)

**Scope:** Fix pass applying all Round-14 audit findings. 2 effective CRITICALs, 14 HIGH, ~22 MEDIUM, ~12 LOW, 12 DOC items fixed across 12 files (7 BE, 3 FE, 2 docs). 4 parallel agents ran concurrently — one per entity. Many TX/SUB/CAT findings were already applied in prior passes by the time agents ran.

**BE fixes — Shared (`app-utils.gs`):**
- `splitToList` and `normaliseTags`: `filter(Boolean)` → `.filter(function(s) { return s !== ''; })` — eliminates banned falsy filter across all four entities.

**BE fixes — Accounts (`account-core.gs`, `account-validation.gs`, `account-utils.gs`, `account-schema.gs`):**
- `_buildAccountNetMap`: was returning `{}` on empty transactions sheet — all account balances computed as `NaN` on brand-new installs. Now returns the zero-seeded map (accounts pre-initialised to `0`) before the early return, so `listAccounts` always gets valid numbers.
- `validateAccountCreate` sub_type guard: removed dead `=== undefined` and `=== null` branches after a guaranteed-string assignment; simplified to `if (subType === '')`.
- `validateAccountUpdate`: added `.trim()` to `record_status` before `indexOf` — `"active "` (trailing space) no longer falsely rejected.
- `generateAccountId`: `!isNaN(n)` → `Number.isFinite(n)` — banned `isNaN` pattern removed.
- `getAccountSchemaForClient`: ternary-as-fallback on `TYPE_LABELS`/`TYPE_GROUPS` replaced with `throw` on missing key (programming error; all valid types are covered by the maps).
- `createAccountsBulk` result push: `error: r.error` and `id: r.id` now conditionally included only when defined — eliminates `error: undefined` on successful rows.

**FE fixes — Accounts (`accounts.js`):**
- Schema accessor functions (`_sch`, `_accountTypes`, etc.): removed `{}` / `[]` fallbacks; `renderAccounts` now guards at entry if schema is absent and renders an error state instead of silently degrading.
- `el('accImportConfirm').disabled = !_importParsed` → `=== null`.
- `if (_importParsed)` confirm handler → `if (_importParsed !== null)`.
- `_v(id)` helper: now null-checks the element and throws a descriptive error if not found.
- Duplicate `deleted`/`inactive` opacity branches collapsed to a single `||` condition in both table and card layouts.
- `if (!_accDraft)` filter toggle → `=== null`.
- `_accDraft !== undefined && !== null` dead `!== undefined` branch removed.

**BE fixes — Transactions (`transaction-core.gs`, `transaction-validation.gs`, `transaction-utils.gs`):**
- `createTransaction`: `_loadAccountMap()` now called once alongside `_buildCategoryMap()` and passed to `validateTransactionRecord` — eliminates redundant accounts-sheet read.
- `_loadAccountMap`: now excludes `inactive` and `locked` accounts (was only excluding `deleted`) — inactive/locked accounts can no longer be used as FK targets for new transactions.
- `_writeSingleTransaction`: accepts optional pre-opened `sheet` parameter; transfer path passes the already-opened sheet to avoid two extra header-row reads per transfer.
- `generateTransactionId`: `!isNaN(n)` → `Number.isFinite(n)`.

**FE fixes — Transactions (`transactions.js`):**
- `tx-delete` action: now resets `state.txAddOpen = false` — prevents add form and delete confirmation showing simultaneously.
- Sort direction: clicking a new column now starts ascending (was descending) — consistent with documented behaviour.
- Comprehensive sweep of all remaining banned patterns: `!value` falsy guards, `||` fallbacks, `&&` truthy object guards throughout `_saveTransaction`, `_saveEdit`, `_checkBalanceRules`, `_afRefreshToAccountField`, `_buildSiblingMap`, `_fmtBeneficiaries`, `_parseTxCsv`, `_submitTxImport`, geocode handlers, filter attachment, and ~20 other locations.
- Dead variables `_copyAcct` / `_copySibAcct` in `tx-copy` handler removed.
- `el('txImportConfirm').disabled = !_txImportParsed` → `=== null`.

**BE fixes — Subscriptions (`subscription-validation.gs`, `subscription-core.gs`):**
- `tx_type` now validated against `['money-in', 'money-out']` enum in both `validateSubscriptionCreate` and `validateSubscriptionUpdate` — arbitrary strings can no longer be persisted.
- `createSubscription` and `createSubscriptionsBulk`: `today` now derived from local date (matching `listSubscriptions`) — eliminates UTC/local mismatch that could mark subscriptions inactive at creation near midnight.
- `_validateSchedule`: now returns `missing_frequency` for absent/empty frequency and `invalid_frequency` for present-but-invalid — consistent with `validateSubscriptionUpdate`; both paths now use the same error codes.

**BE fixes — Categories (`category-validation.gs`, `category-core.gs`):**
- `VALID_RECORD_STATUSES` cross-file dependency in `validateCategoryUpdate` replaced with locally-derived `VALID_CATEGORY_RECORD_STATUSES = CATEGORY_SCHEMA.record_status.enum_values` — eliminates hidden cross-file dependency that would throw ReferenceError as HTML if the source constant were removed.
- `computeSyncStatus` cross-file dependency annotated with a comment noting it is defined in `app-utils.gs`.
- Hardcoded 0-based index comments removed from `catColIndex` calls in `onEdit`.

**FE fixes — Categories (`categories.js`):**
- `_errMsg(code)` helper added; all 5 `res.error !== undefined ? res.error : '[no error code]'` patterns replaced.
- `_parseCatCsv`: 9 ternary-as-fallback `v !== undefined ? v : ''` patterns removed — fields now passed directly, letting backend treat `undefined` as absent.
- `_renderForm` input `value` attributes: only emitted when field is non-empty (removes 5 ternary-as-fallback `''` patterns).
- `_renderAcctTypeCheckboxes` call args: `''` fallbacks replaced with `undefined`; function updated to handle `undefined` input.
- `btn.dataset.row` absent-sentinel changed from `null` to `undefined` with consistent downstream guards.

**Docs updated:** `accounts.md`, `transactions.md`, `subscriptions.md`, `categories.md`, `data-model.md`.

Notable doc fixes:
- `data-model.md`: `opening_value` corrected from "optional" to "required"; `tags` storage format corrected from "Comma-separated" to "Semicolon-delimited in storage".
- `accounts.md`: liability table column corrected from "Stored (`current_value`)" → "Stored (`opening_value`)"; `types[]` schema shape documented as `{ value, label, group }[]`.
- `transactions.md`: `duplicate_transaction` now lists both `create` and `update`; filter chips documented as not yet implemented; sort description corrected; system CSV columns documented as silently ignored.
- `categories.md`: bulk import duplicate description corrected; locked-row CSV import edge case documented.

---

### Round-13 fix pass — Accounts, Transactions, Subscriptions, Categories (Round 13)

**Scope:** Fix pass applying all Round-13 audit findings. 9 CRITICALs, 23 HIGHs, ~40 MEDIUMs/LOWs, 23 DOC items fixed across 14 files (8 BE, 4 FE, 2 docs). 4 parallel agents ran concurrently — one per entity.

**CRITICAL fixes — Accounts:**
- `account-validation.gs`: `opening_value` now validated as required — `missing_opening_value` returned for undefined/null/'', `invalid_opening_value` for non-finite values. Was previously accepted silently by validator but rejected inconsistently by core.
- `accounts.js` `_parseAccountsCsv`: ragged CSV rows (column absent from row) no longer crash — all `vals[idx]` accesses now guarded with `(vals[idx] !== undefined && !== null ? String(vals[idx]).trim() : '')`.

**CRITICAL fixes — Transactions:**
- `transaction-core.gs` `_checkDuplicate`: NaN amount now short-circuits to `null` (no duplicate) before the row scan — was producing `NaN === NaN → false` and silently bypassing the duplicate check.
- `transaction-validation.gs` `validateTransactionRecord`: `tx_amount` validation moved unconditionally before all category-conditional checks — a category with both `source_account_mandatory=false` and `target_account_mandatory=false` can no longer bypass amount validation.
- `transaction-core.gs` `deleteTransaction`: now checks `record_status === 'deleted'` before soft-deleting; returns `transaction_already_deleted` on double-delete.

**CRITICAL fixes — Subscriptions:**
- `subscription-validation.gs` + `subscription-core.gs`: `row_num` NaN guard added in `updateSubscription`, `restoreSubscription`, and `deleteSubscription`. `Number('abc')` no longer bypasses bounds check and crashes GAS.
- `subscriptions.js`: `restore_subscription` success path was dispatching `'subscriptions:reload'` — an event with no listener. Changed to `'et:reload'`. UI was never refreshing after restore.
- `subscriptions.js` `_renderSubRow`: banned `if (isActive && sub.next_payment_date)` replaced with explicit null/undefined/empty-string guard.

**CRITICAL fixes — Categories:**
- `category-core.gs` `createCategoriesBulk`: `majKey`/`minKey` now always re-slugified via `slugify()` before looking up `existing[]` — was using verbatim CSV value, which never matched sheet slugs, producing `duplicate_category` instead of performing the intended update.

**HIGH fixes — Accounts:**
- `account-validation.gs`: `!field.editable` → `field.editable === false`; dead `field.key !== 'row_num'` exclusion removed.
- `accounts.js`: `opening_value` treated as required in `_saveNew` and CSV parser; missing/invalid errors surfaced to user.
- All `res.error ?? 'unknown'` (×5), `!state.accounts.length`, `!accounts || !accounts.length`, and other banned patterns fixed throughout.

**HIGH fixes — Transactions:**
- `transaction-core.gs` `deleteTransaction` + `restoreTransaction`: refactored from individual `setValue` calls to single `setValues` batch write.
- `transaction-validation.gs` `validateTransactionUpdate`: now accepts optional `catMap` parameter — avoids redundant `_buildCategoryMap()` sheet read when caller already has it.
- `transaction-validation.gs` `_validateFinancialRules`: now accepts optional `accountMap` parameter — avoids redundant `_loadAccountMap()` per-call.
- `transaction-core.gs` `createTransactionsBulk`: `_loadAccountMap()` now called once before the loop, not once per row.
- `transaction-core.gs` `_writeSingleTransaction`: `Number.isFinite` guard added before writing `tx_amount`.
- `transaction-utils.gs` `getTransactionMetadata`: `if (trimmed)` → `if (trimmed !== '')`.
- `transactions.js`: `target_amount` fallback, `?? ''` in tx-copy, `?? '—'` in view mode, sort NaN handling — all banned patterns replaced.

**HIGH fixes — Subscriptions:**
- `subscriptions.js`: all `?? 'FAILURE'` sentinels in `_renderForm` prefill path replaced with explicit checks.
- `subscriptions.js`: `if (!txType)`, `if (!major)`, `if (!types || !types.length)`, `isForeign` falsy guard, `if (!file)`, `if (!btn)` — all replaced with explicit null/undefined/empty checks.
- `subscriptions.js` "Transactions" action: `state.filters` reset now includes `user_location_city` and `user_location_area` (were silently retained from previous view).

**HIGH fixes — Categories:**
- `category-validation.gs`: `'inactive'` removed from `validStatuses` in `validateCategoryCreate` — create always yields `'active'`, validation contract now truthful.
- `category-schema.gs` + `category-validation.gs` + `category-core.gs`: empty-slug guard added — `slugify('&')` → `''` now returns `invalid_category_label` before reaching the sheet.
- `categories.js`: all 4 hardcoded `['active','inactive','deleted','locked']` / `4` literals replaced with `state.categorySchema.record_statuses` / `.length`.
- `category-core.gs` `updateCategory`: locked-row check moved before duplicate scan and FK scan — eliminates 2 wasted sheet reads on locked rows.

**MEDIUM fixes — Subscriptions:**
- `subscription-core.gs` `restoreSubscription` + `deleteSubscription`: refactored from individual `setValue` calls to single `setValues` batch write.
- `subscription-core.gs` `listSubscriptions`: `today` now computed from local time (matching `computeNextPaymentDate`) — subscriptions no longer expire one day early/late for non-UTC users. Two separate `new Date()` calls collapsed to one.
- `subscriptions.js` `_sortSubs`: `next_payment_date` of `''` (inactive subscriptions) now treated as `'9999-12-31'` — was sorting before all active subscriptions on default ascending sort.
- `subscriptions.js`: `filter(Boolean)` on majors list and `msg || '...'` in import summary replaced with explicit patterns.
- `subscription-validation.gs`: dead `&& field.key !== 'row_num'` exclusion removed from immutable-field check.

**MEDIUM fixes — Categories:**
- `categories.js`: `!major_category_label`, `!minor_category_label`, `!categories.length`, `!cat`, `labelMap[val] ?? val`, `!btn` — all banned guards fixed.
- `category-core.gs`: `TX_TYPE_LABEL_MAP` constant added; `tx_type_label` derivation in create and update no longer silently falls back to `'Money Out'` for unknown tx types.
- `category-core.gs` `updateCategory` + `deleteCategory`: `Number.isFinite` guard added to `rowNum` bounds check — NaN `row_num` no longer silently passes.

**LOW fixes — Subscriptions:**
- `subscription-utils.gs`: `generateSubscriptionId` refactored to delegate to `_subscriptionIdBase` — eliminates duplicated date-prefix/max-scan logic.
- `subscription-core.gs`: `migrateSubscriptionColumnOrder` removed — dead code, migration was run in Round 5.
- `subscriptions.js`: double-click-to-close menu toggle logic removed — was always broken (reset at render time); global outside-click handler is sufficient.

**LOW fixes — Categories:**
- `categories.js`: `!cats.length`, `!res.results`, `!rows.length` banned guards fixed; category labels in filter bar now wrapped with `esc()` (XSS fix).
- `category-core.gs` `createCategoriesBulk`: `var r` → `const`/`let` inside forEach.

**Docs updated:** `accounts.md`, `transactions.md`, `subscriptions.md`, `categories.md`, `data-model.md`.

---

### Round-12 fix pass — Accounts, Transactions, Subscriptions, Categories (Round 12)

**Scope:** Fix pass applying all Round-11 unfixed findings plus new Round-12 findings. ~100 fixes across 14 files (7 BE, 5 FE, 2 docs). 4 parallel agents ran concurrently — one per entity.

**BE fixes — Transactions (`transaction-core.gs`, `transaction-validation.gs`, `transaction-utils.gs`):**
- `isTransfer` now uses explicit `!== undefined && !== null && .trim() !== ''` guards instead of banned `&&` falsy checks.
- All `Number(x) > 0` amount checks now guarded with `Number.isFinite()` first (rejects NaN and Infinity).
- PIN no longer propagated into per-row transfer body — auth is at the router level only.
- `updateTransaction` now rejects rows with `record_status === 'deleted'` — returns `transaction_deleted`.
- `updateTransaction` refactored from N individual `setValue` calls to a single `setValues` batch write.
- `updateTransaction` now calls `_checkDuplicate` before writing (with current row_num excluded from scan).
- `_checkDuplicate` extended with optional `excludeRowNum` parameter.
- `_loadAccountMap` now skips deleted accounts — deleted accounts can no longer be used as transaction targets.
- `_buildCategoryMap` changed from skip-`deleted` to skip-`!== 'active'` — only active categories are valid FK targets (inactive/locked are now excluded).
- `_buildCategoryMap` now guards against blank composite key parts.
- `distinct` helper replaced `v &&` with explicit `!== undefined && !== null && .trim() !== ''`.
- `active` variable in `getTransactionMetadata` renamed to `nonDeleted` (it was never active-only).

**BE fixes — Accounts (`account-core.gs`, `account-validation.gs`, `account-schema.gs`, `account-utils.gs`):**
- `current_value` schema entry now has an explicit comment marking it as a virtual computed column — header exists for ordering only, never written via API, value injected at read time by `listAccounts`.
- `updateAccount` now guards `body.row_num === undefined || === null` before `Number(body.row_num)` — eliminates NaN-crash at GAS runtime.
- `_buildAccountNetMap` `!accId` replaced with `accId === ''`; explicit comment added to the `net[a.id] = 0` pre-seed; explicit `netMap[a.id] !== undefined` guard added at the net-computation call site.
- `deleteAccount` refactored from 4 individual cell reads to a single `getDataRange().getValues()` call + single `setValues` write.
- `restoreAccount` refactored from 2 reads to 1 `getDataRange().getValues()` + 1 `setValues` write.
- `updateAccount` refactored from up to 7 individual `setValue` calls to single `setValues` batch write.
- `createAccount` replaced double-stacked `? 0` fallbacks on `opening_value` with explicit `missing_opening_value` / `invalid_opening_value` error returns.
- `createAccountsBulk` no longer copies PIN into sub-call bodies.
- `createAccountsBulk` now passes already-loaded sheet data to `generateAccountId` (eliminates second full sheet read).
- `createAccountsBulk` refactored toward batch reads — loads sheet once before loop.
- `generateAccountId` now accepts optional `existingData` to avoid redundant sheet read.
- `validateAccountUpdate` — blank `sub_type` (`''`) now correctly triggers enum check (was bypassed by `if (body.sub_type !== undefined)` only).
- `validateAccountCreate` / `validateAccountUpdate` — type→sub_type mapping now uses `ACCOUNT_TYPE_SUB_TYPES` map (new constant in account-schema.gs) instead of hardcoded ternary chain; new types now fail explicitly.
- Redundant `VALID_RS.indexOf` re-validation in `updateAccount` removed (validation already enforces it).
- Dead functions removed: `getAccountById`, `isLoanSubType`.
- `getAccountSchemaForClient` now logs a `console.error` when `TYPE_LABELS`/`TYPE_GROUPS` is missing an entry.

**BE fixes — Subscriptions (`subscription-core.gs`, `subscription-validation.gs`, `subscription-utils.gs`):**
- `createSubscriptionsBulk` bulk-ID collision fixed — `generateSubscriptionId` called once before loop; IDs now incremented per row via `_subscriptionIdBase` helper + counter.
- `validateSubscriptionUpdate` now requires `currency` and `frequency` (returns `missing_currency` / `missing_frequency` if absent) — eliminates silent field-blanking on update.
- `_validateSchedule` now always called in update path (was conditionally skipped when `frequency` absent).
- `updateSubscription` refactored from up to 19 individual `setValue` calls to single `setValues` batch write (reads current row once, patches in-memory, writes back).
- Lazy-expiry refactored — mutations accumulated in `expiredWrites`, flushed after loop (was 4 individual `setValue` calls per expired row inside the forEach).
- `subscription_end_date &&` falsy guard in lazy-expiry replaced with full explicit 4-part check.
- `endDate &&` falsy guard in `initStatus` computation replaced with `endDate !== ''` in both create paths.
- Restore duplicate guard aligned with create: now skips only `'deleted'` rows (was skipping all non-active, allowing inactive-name collisions).
- `restoreSubscription` reduced from 2 sheet reads to 1 `getDataRange().getValues()` + single `setValues` write.
- `field_not_editable:<key>` colon-embedded error code fixed to `{ error: 'field_not_editable', field: key }`.
- `computeNextPaymentDate` `!dom` replaced with `!Number.isInteger(dom)`.
- `generateSubscriptionId` now accepts optional `preloadedValues` to avoid redundant read.

**BE fixes — Categories (`category-core.gs`, `category-validation.gs`, `category-schema.gs`):**
- `getCategorySchemaForClient` now returns `record_statuses: CATEGORY_SCHEMA.record_status.enum_values` — FE can iterate dynamically.
- `validateCategoryCreate` now validates `record_status` (defence-in-depth — `createCategory` always writes `'active'`, but invalid values now explicitly rejected).
- All 10 `?? ''` occurrences on optional string fields in `createCategory` and `updateCategory` replaced with explicit null checks.
- `!String(body.major_category_label).trim()` and `!String(body.minor_category_label).trim()` split into two explicit sequential checks in both create and update validators.
- `updateCategory` refactored from ~18 individual `setValue` calls to single `setValues` batch write.
- `deleteCategory` refactored from 2 individual reads + 4 writes to 1 `getDataRange().getValues()` + 1 `setValues` batch write.
- `onEdit` now uses `getSheetByName` (correct for trigger context) with null guard and explanatory comment.
- Within-batch duplicate condition changed from `typeof existing[key] === 'number'` to `existing[key] !== undefined` — same-batch duplicates no longer fall through to `createCategory`.
- `createCategoriesBulk` now retries with `force: true` when `updateCategory` returns `category_key_change_has_dependents` — key-changing bulk renames no longer silently fail.
- Slug computed once before loop in `createCategory` (was computed twice).

**BE fixes — Shared (`app-utils.gs`):**
- `sheetToObjects` and `sheetToObjectsWithRow` — `row[i] ?? ''` replaced with explicit `!== null && !== undefined ? row[i] : ''` in both functions.

**FE fixes — Transactions (`transactions.js`, `daterange.js`):**
- Chip labels (country, city, area, tag, search) now wrapped in `esc()` before HTML insertion — eliminates XSS risk.
- Lat/lon falsy guards `if (!lat)` / `if (!lon)` replaced with explicit `=== undefined || === null || === ''` — coordinate `(0,0)` no longer treated as missing.
- `_datalist` helper `?? []` replaced with explicit null guard.
- `? 0` fallback in amount computation replaced with explicit non-finite guard.
- `?? ''` on account map lookups replaced with explicit ternaries.
- `|| 'unknown'` display fallbacks (4 sites) replaced with explicit checks.
- `?? 'FAILURE'` fallbacks (3 sites) replaced with explicit checks.
- Clear Filters now also resets `state.dateRange`, `state.customFrom`, `state.customTo`.
- `_isAlreadySubscribed` — both `?? ''` patterns and `!normCp` guard fixed.
- `daterange.js` `filteredTx` — `|| ''` on country/city and `?? ''` on area replaced with explicit null checks.
- `updateTransaction` now rejects deleted transactions (`transaction_deleted`).

**FE fixes — Accounts (`accounts.js`):**
- FE liability negation removed from `_saveNew` — backend handles sign convention exclusively (was a double-negation).
- `_saveEdit` no longer sends `sub_type` when blank; blank value no longer bypasses enum validation.
- All banned falsy guards in `_saveNew`, `_saveEdit`, `_parseAccountsCsv` replaced with explicit checks.
- CSV `opening_value` non-numeric now surfaces a per-row error instead of silently defaulting to 0.
- `record_status` enum now derived from `ALL_RECORD_STATUSES` constant (3 places were using the magic number `4`).
- `_renderAccountForm` `record_status` options now built dynamically from `EDIT_RECORD_STATUSES` constant (was hardcoded strings).
- `_subTypesForType(type)` helper added — used by all 3 sites that had hardcoded type→sub_type ternary chains.
- `_fmtBal` — `!Number.isFinite(v)` replaced with `Number.isFinite(v) === false`.
- `_balanceCell` — added finite guard for `parseFloat(a.current_value)` at entry.
- `_renderTable` — `isNaN(v) ? 0` fallbacks in reduce callbacks replaced with `Number.isFinite(v) ? s + ... : s`.
- `byGroup[a.type] ?? []` replaced with explicit `if (byGroup[a.type] === undefined)` initialiser.
- Schema accessors (`_sch`, `_accountTypes`, `_assetSubTypes`, `_invSubTypes`, `_liabSubTypes`) — `?? {}` / `?? []` replaced with explicit null checks.
- `_subTypeLabel` — `!v` replaced with explicit null/empty check.

**FE fixes — Subscriptions (`subscriptions.js`, `app/core/utils.js`):**
- `_saveAdd` / `_saveEdit` — all four banned falsy guards (`!body.name`, `!body.amount`, `!body.currency`, `!body.source_account`) replaced with explicit checks.
- 7 `res.error || 'unknown'` fallbacks replaced with explicit ternaries.
- `_freqShort` rewritten as named function — handles `f === ''` case (returns `'—'` instead of blank).
- `p.frequency ?? 'monthly'` replaced with explicit ternary that also handles `p.frequency === ''`.
- `_subImportResult ?? ''` replaced with `!== null` check.
- `tags` added to CSV column hint.
- Sort comparator `?? ''` patterns replaced with explicit null checks.
- Search haystack `?? ''` patterns replaced with explicit null checks.
- `SUB_COLS` export now includes `subscription_start_date`, `subscription_end_date`, `updated_at`.

**FE fixes — Categories (`categories.js`):**
- `!row.major_category_label` / `!row.minor_category_label` in CSV parser replaced with `=== ''`.
- `!rowNum` in `_saveCatEdit` replaced with explicit null/undefined/range check.
- `record_status` enum in form template now built from `state.categorySchema.record_statuses` (no longer hardcoded).
- Magic number `4` for status count replaced with `ALL_STATUS_COUNT` derived from schema.
- `record_status` no longer sent in create payload (backend always writes `'active'`).
- `_activeFilterCount()` no longer called twice per render — computed once, passed to `_renderCatFilterBar`.
- 8 `?? ''` in `_parseCatCsv` replaced with explicit `!== undefined` ternaries.
- `res.error ?? 'unknown'` in 5 error-display sites replaced with explicit `!== undefined && !== null` checks.
- `String(cat.x ?? '')` double-wrapping replaced with explicit form.
- All `?? ''` in `_renderForm` and `_renderAcctTypeCheckboxes` replaced with explicit null checks.

**Docs updated:** `transactions.md`, `accounts.md` (DOC-1 through DOC-4), `subscriptions.md`, `categories.md`, `data-model.md`.

---

### Round-10 re-audit fix pass — Accounts, Transactions, Subscriptions, Categories (Round 10)

**Scope:** Second fix pass targeting all CRITICAL and HIGH findings raised by the Round-10 re-audit. ~50 fixes across 12 files (8 BE, 4 FE).

**BE fixes — Accounts (`account-validation.gs`, `account-core.gs`):**
- Removed embedded values from `unknown_currency` and `field_not_editable` error codes — colon-embedded values are banned in error code strings.
- Removed `deleted` from the `VALID_RS` set in `validateAccountUpdate` — only `active`, `inactive`, and `locked` are valid update targets; `deleted` is set only via `deleteAccount`.
- Replaced 3 banned `!body.field` falsy guards with explicit `=== undefined || === null` checks in account validators.
- Removed `opening_value` write to the `current_value` column in `createAccount` — `current_value` is computed at read time and must never be written directly.
- Fixed duplicate-name check in `updateAccount` to exclude deleted accounts from the scan.

**BE fixes — Transactions (`transaction-validation.gs`, `transaction-core.gs`, `transaction-utils.gs`):**
- Fixed 4 colon-embedded error codes in `transaction-validation.gs`.
- Fixed transfer atomicity: both legs are now duplicate-checked BEFORE any row is written — a parent row can no longer be orphaned if the child leg fails validation.
- Reduced transfer duplicate-check from 4 sheet scans to 2 by adding a `skipDupCheck` option to `_writeSingleTransaction`.
- Added category FK validation to `validateTransactionUpdate` (was missing from update path).
- Replaced 3 banned `body.account_id &&` falsy guards in `_validateFinancialRules` with explicit null checks.
- Fixed `!tx.tx_tags` falsy guard in `getTransactionMetadata`.
- Fixed 3 `!body.row_num` falsy guards in update, delete, and restore paths.
- Fixed sequential ID scanner (`generateTransactionId`) to skip hex-suffix bulk IDs via a `SEQ_PATTERN` regex — bulk IDs were polluting the sequence counter.
- Consolidated multiple `getValue()` calls in `deleteTransaction` / `restoreTransaction` into a single row read.

**BE fixes — Subscriptions (`subscription-validation.gs`, `subscription-core.gs`):**
- Fixed empty-string `frequency` bypass in `validateSubscriptionUpdate` — an empty string was bypassing `_validateSchedule`; now always forwarded.
- Fixed 6 banned `!body.field` falsy guards across `validateSubscriptionCreate` and `validateSubscriptionUpdate`.
- Fixed `!body.row_num` falsy guards in `restoreSubscription` and `deleteSubscription`.
- Fixed `!body.day_of_week && !== 0` band-aids in `_validateSchedule` — `0` is a valid day value and must not be treated as absent.
- Consolidated `restoreSubscription` from 3 sheet reads to 1.
- Refactored `createSubscriptionsBulk` from N+1 individual writes to a single `setValues` batch write.
- Fixed lazy-expiry in-memory row patch: now updates `sync_status`, `sync_notes`, and `updated_at` alongside `record_status`.
- Fixed empty-string `amount` bypass in `validateSubscriptionUpdate`.
- Fixed `updateSubscription` to skip writing `amount` when the field is absent from the request body.

**BE fixes — Categories (`category-validation.gs`, `category-core.gs`):**
- Added FK check to `updateCategory`: blocks key-changing edits that would orphan dependent transactions/subscriptions; returns `category_key_change_has_dependents` with a count; accepts `force: true` to override.
- Fixed banned ternary on `record_status` in `updateCategory` — now a conditional write only when the field is present in the request body.
- Fixed 4 banned `!body.field` falsy guards in `validateCategoryCreate` and `validateCategoryUpdate`.
- Added `record_status` enum validation to `validateCategoryUpdate` — returns `invalid_record_status` on unknown values.
- Fixed 6 banned `x ? x : ''` ternaries in duplicate-name guards for both create and update paths.
- Fixed `!body.row_num` falsy guard in `deleteCategory`.
- Added within-batch duplicate protection in `createCategoriesBulk` for rows that share a key with existing active records.
- Replaced 10 verbose null-guard ternaries with `??` in `createCategory` / `updateCategory`.

**BE fixes — Shared (`app-utils.gs`):**
- Promoted `toBool` to a top-level function in `app-utils.gs`; removed duplicate inline closures from `category-core.gs` and `transaction-validation.gs`.

**FE fixes — Accounts (`accounts.js`):**
- `_saveEdit` now includes `sub_type` in the update payload (was silently dropped).
- `_fmtBal` now returns `'—'` for NaN values instead of rendering the string `"NaN"`.
- `_renderNetWorth` now skips non-finite values rather than treating them as 0 (3 call sites fixed).
- CSV import: removed FE-side liability `opening_value` negation — the double negation was producing wrong signs.
- CSV import: removed dead `current_value` column parsing.
- Edit form `record_status` dropdown: removed `deleted` option (not a valid update target).
- Removed dead `acc` variable from `_saveEdit`.

**FE fixes — Transactions (`transactions.js`):**
- `_sortTx`: replaced `?? ''` sort fallback with an explicit null-guard comparator that pushes nulls to the end of the list.

**FE fixes — Subscriptions (`subscriptions.js`):**
- `_saveAdd` / `_saveEdit`: added client-side `source_account` presence check with inline error display.
- Removed dead `_freqLabel` function.
- `_sortSubs`: replaced `isNaN(va) ? 0` fallback with explicit NaN-to-end sort logic.

**FE fixes — Categories (`categories.js`):**
- Add form `record_status` dropdown now restricted to `active` / `inactive` — `locked` and `deleted` are no longer offered.
- `_parseCatCsv`: replaced falsy guard and added client-side `tx_type_key` enum validation.
- Filter bar major/minor dropdowns now include only `active` categories.
- Removed `?? 0` fallbacks on bulk import result counts.

**Docs updated:** `accounts.md`, `transactions.md`, `subscriptions.md`, `categories.md`, `data-model.md`.

---

### Entity audit fix pass — Accounts, Transactions, Subscriptions, Categories (Round 10)

**Scope:** Comprehensive bug-fix pass across all four primary entities, targeting every finding from the Round-9 audit. 29 distinct fixes applied across 14 files.

**CRITICAL fixes — Accounts:**
- `account-core.gs` `updateAccount`: was never writing `record_status` to the sheet — deactivating an account was a silent no-op. Added guarded `writeField` for `active|inactive|locked` (not `deleted`, which is set only via `deleteAccount`).
- `account-core.gs` `updateAccount`: was blanking `sub_type` and `description` when absent from the request body. Now skips the write entirely when the caller does not provide those fields.
- `account-core.gs` `createAccount`: `Number(undefined) = NaN` was being written to `opening_value` when the field was absent. Now defaults to `0` and validates with `Number.isFinite`.
- `api.js`: `restoreAccount` method was missing from `ExpenseAPI`. Added (mirrors `restoreTransaction` pattern).
- `accounts.js` `_restoreAccount`: was calling `ExpenseAPI.updateAccount(...)` with a large payload instead of the dedicated `restoreAccount` action. Fixed to call `ExpenseAPI.restoreAccount({ row_num })`. Error codes updated to `missing_row_num | invalid_row | not_deleted`.
- `accounts.js` `_saveNew`: `parseFloat('')` returns `NaN`; added `Number.isFinite` guard before sending payload.
- `accounts.js` `_parseAccountsCsv`: truthy check `row.current_value ? ...` incorrectly treated `'0'` as absent. Fixed to explicit three-condition guard.

**CRITICAL fixes — Transactions:**
- `transaction-utils.gs` `getTransactionMetadata`: return key was `tags`. FE reads `res.tx_tags`. Tag autocomplete dropdown was always empty. Renamed to `tx_tags`.
- `transaction-core.gs`: CSV bulk import with blank `target_amount` for same-currency transfers was rejected by validation. Added defaulting of `target_amount = source_amount` in both `createTransaction` and the `createTransactionsBulk` per-row loop, before validation runs.
- `transaction-validation.gs`: all `if (!body.field)` and `if (!body.field || ...)` banned falsy guards in `validateTransactionRecord` and `validateTransactionUpdate` replaced with explicit `=== undefined || === null || .trim() === ''` / `!Number.isFinite(...)` checks.

**HIGH fixes — Subscriptions:**
- `api.js`: `restoreSubscription` method added to `ExpenseAPI`.
- `subscriptions.js`: Restore option added to deleted-subscription context menu → calls `ExpenseAPI.restoreSubscription({ row_num })`, dispatches `subscriptions:reload`.
- `subscription-core.gs` `listSubscriptions`: lazy expiry block was writing `record_status → inactive` and `updated_at` but not advancing `sync_status` or clearing `sync_notes`. Fixed to call `computeSyncStatus` and write both columns.
- `subscription-core.gs` `restoreSubscription`: no duplicate active-name check was performed before restoring. Added scan of all active rows for name collision (returns `duplicate_name` if found).
- `subscription-validation.gs` `validateSubscriptionUpdate`: no currency validation. Added guard rejecting blank currency string.
- `subscriptions.js`: Source account label missing asterisk (`*`). Added.

**MEDIUM fixes — both:**
- `account-validation.gs` `validateAccountUpdate`: no `record_status` enum validation. Added check for `active|inactive|locked|deleted`.
- `account-validation.gs` `validateAccountCreate`: no `opening_value` NaN guard. Added `parseFloat` + `Number.isFinite` check.
- `account-core.gs` `deleteAccount`: `record_status` column position was looked up twice into two different variable names. Collapsed to one.
- `account-core.gs` `deleteAccount` + `restoreAccount`: `if (!body.row_num)` → explicit null/undefined check.
- `account-core.gs` `_buildAccountNetMap`: comment "stores account name, not UUID" contradicted the actual behaviour. Fixed.
- `subscription-core.gs` `migrateSubscriptionColumnOrder`: `getSheetByName` is normally banned; this migration requires null-detection for sheet absence. Added justifying comment.
- `transactions.js` `_prefillAddForm`: optional fields (`counterparty_name`, location fields, `tx_tags`, `description`, `target_account`) were using `?? 'FAILURE'` — would have sent the literal string "FAILURE" to the API. Changed to `?? ''`. Required fields keep `?? 'FAILURE'`.
- `transactions.js` `_fmtAccType`: `_ACC_TYPE_LABEL[t] || t` → `?? t`.

**Category schema fixes:**
- `category-schema.gs` `getCategorySchemaForClient`: hardcoded `CATEGORY_TX_TYPES` array and label map replaced with dynamic iteration over `CATEGORY_SCHEMA.tx_type_key.enum_values`. Enum additions in the schema are now automatically reflected.
- `category-validation.gs` `VALID_CATEGORY_TX_TYPES`: was a hardcoded duplicate of the schema enum. Now references `CATEGORY_SCHEMA.tx_type_key.enum_values` directly.
- `state.js`: `accountSchema` comment described stale field names. Fixed to `{ types, asset_sub_types, investment_sub_types, liability_sub_types, loan_sub_types }`.

**Documentation fixes (5 files, 16 inaccuracies corrected):**
- `accounts.md`: removed two false "duplicate name check on restore" claims; removed false "liability form hint" claim; added `record_status` mutability clarification.
- `transactions.md`: corrected `parent_tx_id` directionality (parent row has empty `parent_tx_id`, child carries parent's `id`); removed `skipped` from bulk response shape; fixed Account filter from "single-select" to "multi-select"; removed non-existent `payment_method` filter; removed false backend account-type mismatch enforcement claim.
- `subscriptions.md`: updated `restore_subscription` duplicate check claim (now accurate — check is implemented); added `not_deleted` error code; fixed `tags` delimiter from "comma-separated" to "semicolon-delimited in storage"; added note that restore always targets `active`.
- `categories.md`: corrected `restore_category` (not a distinct route — done via `update_category`); removed auto-seed section (feature doesn't exist).
- `data-model.md`: corrected `parent_tx_id` directionality in 3 places; fixed `major_category`/`minor_category` FK refs from `*_label` → `*_key` for both transactions and subscriptions; corrected transaction ID format from `TXN-YYYYMMDD-NNN` to `YYYY-MM-DD-NNN` (single) / `YYYY-MM-DD-XXXXXXXX` (bulk).

**Intentionally deferred (design decisions or complex):**
- Transfer atomicity (two-phase write): complex; deferred.
- N+1 `_loadAccountMap` in bulk validation: optimization; deferred.
- Transaction ID format unification (single vs bulk): data-layer risk; deferred.
- Account type mismatch backend enforcement: new feature; deferred.
- `fortnightly` frequency: unclear if intentional; deferred.

---

### Full `||` → `??` sweep — all FE files (Round 9)

**Scope:** Complete codebase sweep for banned `||` fallback patterns (`|| 0`, `|| []`, `|| ''`) across all FE files not previously audited in Rounds 1–8.

**`_shared/utils.js`:**
- `fmtBase`: added `if (isNaN(val)) return '—'` guard before `.toLocaleString()`. Without this, a missing rate would produce `"GBP NaN"` in the DOM.

**Insight files (17 files, ~65 changes total):**
- `02-yoy-monthly.js`, `06-last-12-months.js`, `08-category-pie.js`, `09-category-trend.js`: `||` → `??` on Map.get(), array element access, and string field fallbacks.
- `10-top-categories.js`, `11-category-drilldown.js`, `14-networth-trend.js`, `15-account-balances.js`: same pattern on category strings and balance Map lookups.
- `16-asset-vs-liability.js`, `17-liability-paydown.js`, `18-income-vs-expenses.js`, `19-cashflow-waterfall.js`: `||` → `??` on daily snapshots, balance arrays, and Map lookups. HTML string fallbacks in 18 converted to `.length ? str : fallback` ternary.
- `20-savings-rate.js`, `21-income-sources.js`: Map.get() `|| []` → `?? []`; first `||` in `(tx[field] || '').trim()` → `??` (trailing `|| fallback` for empty-after-trim intentionally kept).
- `27-debt-to-income.js`: `completeMKs.length || monthKeys.length` → explicit ternary (length 0 is a meaningful value, not null/undefined).
- `29-daily-spend.js`, `30-daily-spend-no-payments.js`: Map.get() and array index `||` → `??`.
- `00-earn-burn-rate.js`: 8 `||` → `??` on daily accumulator object access and array tail reads.
- `25-spend-by-city.js`: tooltip label chain `|| ctx[0]?.label || ''` → `?? ctx[0]?.label ?? ''`.
- `insight-utils.js`: `ctx.dataset.label || ''` → `?? ''` in shared tooltip formatter.

**Section and core files:**
- `advisor.js`: `res.data || []` → `?? []`.
- `insights.js`: `payload || {}` → `?? {}`; `stat_cards || []` → `?? []`.
- `subscriptions.js`: `_subImportResult || ''` → `?? ''`.
- `transactions.js`: 13 changes — `_txImportResult || ''` → `??`; 10 form `.value || ''` redundant fallbacks removed (`.value` always returns string); 2 Nominatim address chains `||` → `??`.
- `rates.js`: 5 `el(...)?.value || ''` → `?.value ?? ''` in `_saveNewRate` and `_saveEdit`.
- `_shared/auth.js`: `d.ip || 'unknown'`, `d.city || ''`, `d.country_name || ''` → `??` (ipapi.co response fields).
- `app/core/daterange.js`: `tx.user_location_area || ''`, `tx.tx_tags || ''`, `state.accountMap[id] || {}`, `acctEntry.name || ''` → `??`.

**Result:** Zero banned `||` patterns remain in any FE file (confirmed by final grep). All logical `||` in `if (!a || !b)` guards left untouched.

---

### Codebase fixes + docs accuracy pass (Round 8)

**Scope audited:**
- BE: `account-validation.gs`, `transaction-validation.gs`, `category-validation.gs`, `subscription-validation.gs`, `app-utils.gs`, `advisor-core.gs` spot-check, category FK consistency
- FE: `_shared/utils.js`, insight files 22/23/25/26, `01-mom-cumulative.js`, `05-ytd-comparison.js`, sections spot-check (`subscriptions.js`, `home.js`, `transactions.js`)
- Docs: accuracy pass post-Round-7; `restoreAccount`/`restoreSubscription` documented in `accounts.md`, `subscriptions.md`

**High-severity BE fix — `category-core.gs` onEdit (two bugs):**
- Hardcoded column positions `TYPE_COL=5`, `MAJOR_COL=8`, `MINOR_COL=9` replaced with schema-derived values from `TRANSACTION_SCHEMA`.
- Dropdown cells were populated with category **labels** (e.g. "Food & Dining") instead of **keys** (e.g. "food-dining"). `_buildCategoryMap` in `transaction-validation.gs` keys its lookup on `major_category_key` values, so any transaction edited directly in the spreadsheet UI would store a label that would never match the catMap — silently producing `unknown_category` for that row. Fixed: `onEdit` now stores keys.

**Category FK consistency confirmed:** Both transactions and subscriptions store category **keys** (not labels) in `major_category` and `minor_category` columns. The API path was always correct; only the direct sheet-edit path (onEdit) was wrong.

**Medium-severity BE fixes:**
- `app-utils.gs` `extractMeta`: 4 truthy ternary fallbacks → explicit `!== undefined && !== null` guards.
- `app-utils.gs` `splitToList` / `normaliseTags`: truthy `if (!str)` guards → explicit null/undefined/empty checks.
- `account-validation.gs`: 3 truthy ternary fallbacks in `validateAccountCreate` / `validateAccountUpdate`.
- `category-validation.gs`: 2 truthy ternary fallbacks in `validateCategoryCreate` / `validateCategoryUpdate`.
- `advisor-core.gs`: `monthsBack`/`limit` ternaries now guard with `Number.isFinite()` to reject NaN; `acc ? acc.currency : null` → `!== null` guard.

**High-severity FE fix — `_shared/utils.js` (core currency functions):**
- `getSymbol`: `r.symbol || ''` → `r.symbol ?? ''`.
- `toBase`: `parseFloat(amount) || 0` → `Number.isFinite` guard.
- `toQuote`: two `|| 0` → single `Number.isFinite` guard.
- `fmtNative` + `fmtAmount`: `parseFloat || 0` → `Number.isFinite` guards.
These affected every currency conversion and display across the entire app.

**FE insight file fixes (all `||` → `??`):**
- `25-spend-by-city.js`: 5 fixes on `tx_location_city`, `tx_location_country`, `major_category`, `catFreq`.
- `22-top-counterparties.js`: 5 fixes on `counterparty_name` (3 sites) and category chain.
- `23-recurring-payments.js`: 5 fixes on `counterparty_name` (3 sites) and category fields.
- `26-loan-progress.js`: 6 fixes on `daily[0]`, `opening_date`, `acc.id`, `sub_type/type`, `currency`.
- `01-mom-cumulative.js`: 1 fix — `Map.get() || []` → `?? []`.
- `05-ytd-comparison.js`: 7 fixes — `Map.get() || []` (×2) and array tail `|| 0` (×5).

**FE section fixes:**
- `subscriptions.js` line 93: `dayVal || '1'` → explicit three-condition check.
- `transactions.js` line 2129: stale `tx.source_currency` reference removed (field does not exist in single-leg model).

**Docs fixes:**
- `accounts.md`: restore description updated to reference dedicated `restore_account` POST action.
- `subscriptions.md`: "No restore endpoint" removed; lifecycle diagram, transition table, and API surface table updated with `deleted → active` / `restore_subscription`.
- `_docs/insight/AUDIT.md`: Bug status table added. B6 (`12-tag-pie.js`) and B7 (`13-tag-trend.js`) recorded as closed.

**Confirmed clean (no changes):**
- `transaction-validation.gs`, `subscription-validation.gs`: no banned patterns, correct field names.
- `app-utils.gs` `sheetToObjects`/`json()`/`getOrCreateSheet`: no issues.
- `home.js`: `record_status === 'active'` filters correct on both pass-throughs.
- `subscriptions.js`: monthly cost uses `s.amount`, `subPrefill` key set matches what `transactions.js` reads.
- `_isAlreadySubscribed`: correctly uses `s.tags` and `tx.tx_tags`.
- `03-wow-daily.js`, `04-qtd-comparison.js`: confirmed clean.

---

### Docs accuracy pass (Round 7)

Cross-referenced every doc claim against the five schema files (`account-schema.gs`, `transaction-schema.gs`, `subscription-schema.gs`, `category-schema.gs`, `rate-schema.gs`). Scope of audit: column positions, field names, types, editable flags, required status, enum values, and all high-level model descriptions.

**Fixes applied:**
- `README.md` item 6: description of `balance-lifecycle.md` said "two-phase reversal" (the old incremental model). Updated to accurately describe the read-time computation model (`_buildAccountNetMap`) that replaced it in Round 5.
- `data-model.md` Subscription intro: said "Recurring transaction templates that generate transactions on a schedule." Subscriptions are obligations/planning layer — they never post to an account balance and never auto-generate transactions. Description corrected.

**No doc issues found in:**
- All column positions in all five schema tables are correctly reflected in every doc that references them.
- `tx_amount`, `tx_date_local`, `account_id`, `record_status`, `sync_status` field names are correct throughout.
- No `is_active`, `transaction_date_utc`, `source_account`/`target_account` on transactions, `money-transfer`, `fx_rate`, or `adjustAccountBalance` references anywhere in the docs.
- Base currency correctly stated as XAU (1 gram of gold) throughout. GBP and `£` appear only as illustrative worked-example currencies (cross-currency transfer example in `balance-lifecycle.md`, `£100` typo-edit example in `financial-rules.md`), not as base currency claims.
- Subscription `tags` vs transaction `tx_tags` distinction correctly documented in `subscriptions.md`, `data-model.md`, and all cross-references.
- Subscription column order (record_status=15, created_at=16) matches schema.
- Rate entity missing fields (record_status, sync_status, created_at) acknowledged correctly in `rates.md` and `data-model.md`.
- Category no-surrogate-id acknowledged correctly in `categories.md` and `data-model.md`.
- `AUDIT.md` note in B3 correctly states `amount_base` is not a stored field.
- `INSIGHT-UTILS.md` accurately describes all shared helpers.

**Codebase fixes (Round 7 — all applied):**
- `rates.js`: base-currency guard changed from `r.currency === 'GBP'` to `r.currency === 'XAU'` (both card and table row). GBP row was incorrectly rendered as read-only; XAU is the true base.
- `rates.js`: all UI labels and hints updated from "per 1 GBP" / "per £1" → "per 1g XAU" (section subtitle, table header, add form, edit form).
- `state.js`: comment on `rateMap` corrected from "units per 1 GBP" → "units per 1g XAU".
- `28-forex-spend.js`: `state.accounts || []`, `state.quoteCurrency || 'GBP'`, `quoteCcy || 'GBP'` → `??` equivalents.
- `transaction-core.gs`: `_checkDuplicate` and `createTransactionsBulk` — banned truthy ternaries replaced with explicit `!== undefined && !== null` guards.
- `insights-core.gs`: `getComputedInsights` success response reshaped from flat `{ ok, computed_at, commentary, data }` to `{ ok: true, data: { computed_at, commentary, payload } }` (response envelope conformance).
- `category-core.gs`: `createCategory`, `updateCategory`, `createCategoriesBulk` — 5+5+3 banned truthy ternaries replaced.
- `subscription-core.gs`: `createSubscription` and `updateSubscription` — all `!== undefined` only guards tightened to `!== undefined && !== null` to prevent null coercion to `'null'` string.
- `app-router.gs`: brace style on `list_accounts` and `list_rates` routes made consistent. `restore_account` and `restore_subscription` routes added.
- `account-core.gs`: `restoreAccount()` function added — mirrors `restoreTransaction` pattern; checks `record_status === 'deleted'`, sets to `'active'`, advances sync_status.
- `subscription-core.gs`: `restoreSubscription()` function added — same pattern.
- `accounts.js`: `esc(a.sync_notes)` → `esc(a.sync_notes ?? '')` to prevent literal 'undefined' in DOM. Import summary `msg || '...'` → ternary.
- `categories.js`: import summary `parts.join(' · ') || '...'` → ternary; `labelMap[val] || val` → `?? val`.
- `12-tag-pie.js`: `t.tags` → `t.tx_tags` (wrong field — transactions use `tx_tags` not `tags`); `|| ''` → `?? ''`; `bodyRows || fallback` → length ternary.
- `13-tag-trend.js`: `tx.tags` → `tx.tx_tags` (same wrong-field bug, 3 occurrences — drill panel and inline attribution were reading a non-existent field, producing empty tag data); `|| []` → `?? []`; `|| 0` → `?? 0`.
- `24-spend-by-country.js`: dead `import { state }` removed; 10 `||` → `??` replacements; empty-join fallback patterns converted to length ternaries.

**Cross-entity naming inconsistencies (structural, no migration fix possible):**
- `tags` (subscriptions, col 13) vs `tx_tags` (transactions, col 12): same concept, different column names. Documented in `subscriptions.md § Known structural notes` and `data-model.md`.
- `source_account` (subscriptions, col 9) vs `account_id` (transactions, col 6): subscriptions use the old field name from the pre-Round-1 dual-leg model. Documented as a known gap; no impact on transaction operations.
- `subscription_id` FK missing from transactions: documented in `data-model.md § Known gaps`.

---

### Docs maintenance (Round 6)
- `subscriptions.md` and `data-model.md`: corrected subscription column order — `record_status` is at column 15, `created_at` at column 16 (both docs had them reversed).
- `balance-lifecycle.md`: full rewrite to reflect the read-time computation model (`_buildAccountNetMap`). The old doc described an incremental `adjust()` model that no longer exists.
- `accounts.md`: updated intro and `current_value` section to state that balances are computed at read time, not written back during transaction operations.
- `data-model.md`: `current_value` description updated to reflect computed model; invariant #5 corrected from "mutated by transaction lifecycle" to "computed at read time".
- `overview.md`: "Maintain" item corrected from "adjusting on every create/edit/delete" to read-time computation.
- `REWIRE-BRAIN.md`: Round-5 summary added; stale Round-3 workflow engine note removed.

### Codebase fixes (Round 5)
- **Workflow engine deleted.** `workflow-engine.gs` had all functions removed — it is now a comment stub. `executeWorkflow`, `reverseWorkflow`, and `adjustAccountBalance` no longer exist.
- **Balance model changed to read-time.** `adjustAccountBalance` was deleted from `transaction-utils.gs`. Account `current_value` is now computed on every `listAccounts` call via `_buildAccountNetMap` (`opening_value + net from transactions`). No transaction operation writes to the accounts sheet.
- **Subscription column migration.** Columns 15 and 16 in the subscriptions schema were swapped (`record_status` moved to 15, `created_at` to 16). `migrateSubscriptionColumnOrder()` added to `subscription-core.gs` to fix pre-existing sheets; it is idempotent and must be run once after schema deployment.
- **Fallback sweep (BE).** Bare `||` fallbacks eliminated across `subscription-schema.gs`, `subscription-core.gs`, `subscription-validation.gs`, `account-schema.gs`, `account-core.gs`, `account-validation.gs`, `category-core.gs`, `transaction-core.gs`, `transaction-validation.gs`.
- **`getSheetByName` violation fixed.** `category-core.gs` `onEdit` handler was calling `getSheetByName` directly; replaced with `getOrCreateSheet`.
- **Fallback sweep (FE).** `||` → `??` sweep across `transactions.js` and `subscriptions.js` for all nullable field reads.
- **`_attachTabs` dead code removed.** `28-forex-spend.js` had a dead `_attachTabs` call removed.
- **`insight-utils.js` `|| 0` removals.** Bare `|| 0` patterns on metric accumulators in `insight-utils.js` removed.

### Docs verification (Round 5)
- `accounts.md`: corrected intro sentence — "one or two accounts" replaced with the accurate single-leg model description (each row references exactly one account; transfers use two linked rows).
- `data-model.md` Subscription table: `day_of_month` notes extended to cover `monthly`, `quarterly`, and `annual`; `day_of_week` type corrected from `enum` (`mon…sun`) to `number` (1–7); `tx_type`, `major_category`, and `minor_category` required column corrected from `yes` to `optional` (schema has `required_for: []`).
- Insight suggestion result builder `|| ''` patterns in `_mostFrequent` left as-is — these are legitimate neutral values for a most-frequent helper that returns an empty string when no mode exists, not a fallback-value anti-pattern.
- `28-forex-spend.js` tab bar / scatter cleanup reviewed; no doc change required.
- `27-debt-to-income.js` remaining `|| 0` on `tx_amount` access — covered by AUDIT.md B3; fix: replace bare `t.tx_amount || 0` with `Number(t.tx_amount) || 0` throughout.
- Insights coordinator account-filter consistency check: all active insights filter `record_status === 'active'` before passing account lists to sub-modules; no inconsistency found.
- Insight sub-doc directory is `_docs/insight/` (not `_docs/insights/`).

### Insight audit (Round 4)
- Full insight audit completed covering all 28 insight JS files + coordinator + insight-utils.js. Findings captured in `_docs/insight/AUDIT.md` (5 bugs, 9 improvements, 12 drilldown opportunities).
- `_docs/insight/INSIGHT-UTILS.md` created as the canonical reference for all shared computation helpers in `insight-utils.js`.
- B1–B5 bugs and I1–I9 improvements are open items; none were auto-fixed in Round 4 — they are tracked for incremental resolution.

### Subscriptions module (Round 3)
- Full subscriptions section built and shipped: 22-column schema, CRUD backend, bulk CSV import, frontend filter bar, sortable table, status icons, context menu with locked/deleted guard.
- Subscription toggle (pause/resume) was unreachable before Round 3 — fixed; `active → inactive → active` transitions now work correctly.
- `_docs/subscriptions.md` created as the canonical spec.

### Bug fixes (Round 3)
- **Home dashboard** was computing zero for all metrics due to an `is_active` reference in the balance aggregation. Fixed to use `record_status`.
- **Advisor** was using `is_active` checks and GBP as the base currency. Fixed to use `record_status` and XAU.
- **Workflow engine** was referenced in the codebase but was dead code. It was fully deleted in Round 5 — see Round-5 entry above.

### Data model corrections (Rounds 1–2)
- Transaction model rewritten throughout all docs from dual-leg (source_account / target_account / money-transfer) to single-leg (`account_id` + `tx_amount` + `parent_tx_id`). No `money-transfer` tx_type exists.
- All `is_active` references replaced with `record_status` across backend, frontend, and docs.
- Base currency corrected from GBP to XAU (1 gram of gold) throughout docs and Advisor.
- `current_balance` renamed to `current_value` on accounts — all docs updated.
- `transaction_date_utc` renamed to `tx_date_time` — all docs and schema updated.
- `fx_rate` column removed from transaction schema — effective rate is implicit via `tx_in.tx_amount / tx_out.tx_amount`.
