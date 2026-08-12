# Frontend Architecture — Patterns Guide

> **Audience**: LLMs and developers designing or building frontend modules in this codebase.
> **Scope**: Framework-agnostic patterns — applicable to vanilla JS, React, Vue, or any other stack. For stack-specific implementation, see the relevant implementation guide (e.g. `APP-FE-VANILLA.md`).

---

## Module structure

Every frontend module follows the same canonical layout regardless of framework:

```
<module>/
  shell            ← entry point (index.html or root component)
  config           ← runtime config (backend URL, env detection)
  core/
    state          ← single source of truth for all data and UI state
    api            ← typed wrappers over the HTTP layer
    auth           ← session management, auth gate
    utils          ← pure utility functions (formatting, escaping, date)
    nav            ← navigation / routing
  views/           ← one file per screen, section, or route
  style/           ← CSS or style layer
```

Rules:
- Core modules have no knowledge of specific views.
- Views import from core but never from other views.
- The HTTP layer is never called directly from views — always through `core/api`.

---

## Config and environment detection

- Config is resolved **at runtime**, not baked in at build time.
- Detect environment by inspecting the runtime context (hostname, env var, build flag).
- Set the backend URL based on the detected environment.
- Guard against missing config — show a setup banner if config is absent rather than silently failing or hitting a wrong endpoint.
- Config contains public configuration only. Never put credentials or secrets in config files.

---

## Boot sequence

```
1. Apply saved theme preference (or system default)
2. Check for existing session
3. No session → show auth gate; halt
4. Session found → hide auth gate → load all data → render active view
```

`loadAll` fetches all required data in parallel. Do not fetch sequentially unless there is a hard dependency between calls.

---

## State management

- One exported state object — the single source of truth for all data and UI state.
- All data loaded from the backend lives in state.
- All UI state (which form is open, which item is being edited/viewed/deleted) lives in state — never in local variables or DOM attributes.
- Views read and write state directly, then call their own render function to repaint.
- Derived lookups (maps, indexes keyed by ID) are built from canonical arrays at load time and stored in state. Use O(1) map lookups inside render loops, not O(n) `.find()` scans.

```
state = {
  // data
  items: [],
  itemMap: {},        // { id → item } — built in loadAll

  // UI state per view
  itemAddOpen: false,
  itemViewId:  null,
  itemEditId:  null,
  itemDeleteId: null,
  itemDeleteBlocked: null,  // set when backend refuses delete (e.g. FK constraint)
}
```

---

## API abstraction

- One typed wrapper function per backend action — never inline HTTP calls in views.
- Reads use HTTP GET; writes use HTTP POST.
- All responses follow a uniform shape:

```
{ ok: true,  data: <payload> }
{ ok: false, error: 'snake_case_error_code' }
```

- Always check `ok` before reading `data`.
- Error codes are snake_case strings — display them to the user as-is or map them to human-readable messages in the view layer.

---

## View / section pattern

Each view exports exactly one render entry point:

```
render_items():
  1. Build the view's full HTML/markup from current state
  2. Mount it into the view's container element
  3. Attach all event listeners (after mounting — never before)
  4. No I/O inside render — reads from state only
```

Rules:
- HTML/markup is set in one pass, then events are attached. Never interleave.
- Never use `setTimeout` to defer event binding — bind synchronously after mount.
- Opening and closing sub-panels (add form, edit form, detail card) is driven by state, not DOM manipulation:

```
// Open edit form for item with id=42
state.itemEditId = 42
render_items()

// Close all sub-panels
state.itemAddOpen  = false
state.itemViewId   = null
state.itemEditId   = null
state.itemDeleteId = null
render_items()
```

---

## Event handling

- Use **event delegation**: attach one listener to the view container, not to individual buttons.
- Interactive elements carry `data-action` and `data-id` (or `data-row`) attributes.
- Listener dispatches by action name:

```
on click in container:
  target = find closest ancestor with [data-action]
  if no target: return
  action = target.data-action
  id     = target.data-id

  if action == 'edit':   state.itemEditId   = id; render()
  if action == 'delete': state.itemDeleteId = id; render()
  if action == 'delete-confirm': save_delete(id)
  if action == 'delete-cancel':  state.itemDeleteId = null; render()
```

Delegation survives re-renders because the container element is stable even when its children are replaced.

---

## Mutation / save flow

Standard sequence for any create, update, or delete:

```
async save(form_data):
  show_loading()
  try:
    result = api.create_item(form_data)
  finally:
    hide_loading()

  if not result.ok:
    show_message(result.error, type='warn')
    return

  state.itemAddOpen = false
  dispatch('<slug>:reload')
```

Rules:
- `hide_loading()` is always in a `finally` block — it fires on error too.
- On success: reset state flags, then dispatch the reload event.
- **Never** call `load_all()` or `render()` directly after a successful mutation — always dispatch the reload event and let the entry point handle it.

---

## Reload event pattern

Views are decoupled from the data-loading function via a custom event. This prevents circular imports between views and the entry point.

```
// In any view — after a successful mutation:
dispatch('<slug>:reload')

// In the app entry point (main / root):
listen('<slug>:reload', load_all)
```

`<slug>` is a 2–3 character module abbreviation unique across modules. It prefixes storage keys and reload events to prevent collisions when multiple modules share a page.

---

## Security

- **Escape all user-supplied values** before inserting into HTML. Use an `esc()` helper or the framework's safe interpolation. This applies to any value that came from the backend — names, descriptions, error strings.
- Use `textContent` (not `innerHTML`) when rendering server-sourced error messages or toast text.
- Never put credentials, session tokens, PINs, or API keys into HTML, logs, or the DOM.
- **Schema-driven UI**: never hardcode enum values in view markup — read them from API response or state. If the schema fetch fails, fall back to a small hardcoded default and log a warning.

---

## Pagination

- Pagination state lives in the state object: `{ page: 1, per_page: 50 }`.
- Calculate `start` and `end` indices inside the render function — not in event handlers.
- Clamp `page` to 1 if the total count drops below the current page boundary (items were deleted).

---

## Sorting

- Sort state: `{ col: 'field_name', dir: 'asc' | 'desc' }`.
- Column headers carry a `data-sort` attribute with the field name.
- Toggling the same column flips `dir`; clicking a different column resets `dir` to `'asc'`.
- Sorting is applied inside the render function over the in-memory state array — never re-fetched from the backend.

---

## Adding a new view — checklist

1. **State** — add UI state keys: `<name>AddOpen`, `<name>ViewId`, `<name>EditId`, `<name>DeleteId`, `<name>DeleteBlocked`.
2. **API** — add typed wrappers for all backend actions this view needs (`list`, `create`, `update`, `delete`, `get_schema`).
3. **Schema** — if the view renders dynamic fields or dropdowns, add schema loading with a versioned cache key.
4. **View file** — create the view module exporting a single `render_<name>()` function.
5. **Navigation** — register the view in `core/nav` and map it to a route or tab.
6. **Entry point** — add the view's data fetch to `load_all`; store result in state.
7. **Shell** — add the nav entry (tab button or link) and the view's mount point to the HTML shell.
8. **Styles** — add view-specific styles using the design token system (`UX-DESIGN.md`).
