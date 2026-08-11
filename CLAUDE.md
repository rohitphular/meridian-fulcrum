# Forge — Claude Context

Forge is a family of personal-use web apps backed by Google Apps Script + Google Sheets. Each module has a static frontend (vanilla JS ES modules, GitHub Pages) and a GAS backend (single `/exec` endpoint, Sheets as datastore).

Current modules: **expense-tracker** (personal finance ledger — multi-currency, multi-account, category-driven).

---

## Before starting any task

Read `expense-tracker/REWIRE-BRAIN.md` for current project state, URLs, and what is/isn't built.

---

## Which doc to consult for which task

| Task | Read first |
|---|---|
| Writing or modifying backend `.gs` files | `building-standards/APP-BE-GSCRIPT.md` |
| Writing or modifying Python job processor | `building-standards/APP-BE-PYTHON.md` |
| Writing or modifying frontend `.js` / `.html` files | `building-standards/APP-FE.md` |
| Authentication, PIN, TOTP, audit log | `building-standards/APP-AUTH.md` |
| Deploying to dev or prod | `building-standards/APP-CICD.md` |
| UI components, layout, CSS, dark mode | `building-standards/UX-DESIGN.md` |
| Naming variables, functions, files, CSS classes | `building-standards/APP-CONVENTIONS.md` |
| Logging — what to log, format, what to never log | `building-standards/APP-LOGGING.md` |
| Shared utilities — existing functions, adding new ones | `building-standards/APP-SHARED-UTILS.md` |
| What the app does (domain requirements) | `expense-tracker/_docs/README.md` |

---

## Non-negotiable rules

**Backend (GAS)**
- Always validate before any sheet write — never mutate on invalid input
- Always use `getOrCreateSheet` — never `getSheetByName` directly
- Always wrap `JSON.parse` and `UrlFetchApp.fetch` in try/catch
- Always set `muteHttpExceptions: true` on external HTTP calls
- `checkLocked` before `checkPin` — never swap the order
- Every response: `{ ok: true, ... }` or `{ ok: false, error: 'snake_case_code' }`

**Frontend (JS)**
- Always wrap user-supplied values in `esc()` before inserting into `innerHTML`
- Always dispatch `<slug>:reload` after a successful mutation — never call `loadAll` directly
- Always use `el()` instead of `document.getElementById`
- Never hardcode enum values in section HTML — read from schema
- Set `innerHTML` first, attach events after — never interleave

**Both**
- Follow naming conventions in `building-standards/APP-CONVENTIONS.md` exactly
- Follow logging standards in `building-standards/APP-LOGGING.md` — never log PINs, tokens, or session objects

---

## Agents

- **forge-fe** — use for frontend, CSS, UX, and design work
- **forge-be** — use for backend (GAS or Python), auth, and deploy work
