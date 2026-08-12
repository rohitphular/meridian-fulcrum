# Backend Module Architecture — Guide

> **Audience**: LLMs and developers designing or building backend modules in this codebase.

---

## What a backend module is

Each backend module exposes a single entry point (HTTP handler, CLI, or function dispatcher). The handler parses the request, enforces auth, dispatches to the appropriate domain function, and returns a structured response. All data lives in a persistent store (database, spreadsheet, file system). The handler itself is stateless — every request carries everything it needs.

---

## Module file structure

```
<module>/
├── router.*             ← single entry point — parse → auth → dispatch → respond
├── config.*             ← all named constants (table names, limits, etc.)
├── auth.*               ← credential check, rate-limit check, session/audit
├── utils.*              ← shared helpers used across all domains
│
├── <domain>-schema.*    ← field registry, enum lists, helper fns
├── <domain>-core.*      ← CRUD: list / create / update / delete
├── <domain>-validation.*← input validation functions
├── <domain>-utils.*     ← domain-specific helpers (ID gen, computed field adj.)
│
└── <domain>-seed.*      ← (optional) default data seeded on first use
```

Repeat the `<domain>-*` quartet for each entity. Simple domains may skip the utils file.

---

## config — constants

Defines all named constants for the module. Nothing else.

```
# constants / names for every data store table or collection
TRANSACTIONS_TABLE = 'transactions'
CATEGORIES_TABLE   = 'categories'
ACCOUNTS_TABLE     = 'accounts'

# limits
MAX_AUTH_FAILURES = 3
```

Rules:
- Every table/collection name is a constant here. Never use a raw string in a domain file.
- Column definitions that belong to a domain live in that domain's schema file, not here.

---

## router — the entry point

The router is a thin dispatcher. It:

1. Parses the incoming request.
2. Checks rate-limit / lockout **before** the credential check — locked callers are refused immediately, no credential attempt is recorded.
3. Verifies the credential. On failure: record the failed attempt, return `auth` error.
4. On success: record the successful attempt.
5. Dispatches by action name.
6. Returns a structured response.

```
function handle_request(request):
    action = request.params["action"]
    meta   = extract_meta(request)          # { ip, user_agent, ... }

    if check_locked(meta.ip):
        return respond({ ok: false, error: "locked" })

    if action == "login":
        # special — also verifies second factor
        if not verify_credential(request.params["pin"]):
            record_attempt(meta, success=false)
            return respond({ ok: false, error: "auth" })
        if not verify_totp(request.params["totp"]):
            return respond({ ok: false, error: "totp_invalid" })
        record_attempt(meta, success=true)
        return respond({ ok: true })

    if not verify_credential(request.params["pin"]):
        record_attempt(meta, success=false)
        return respond({ ok: false, error: "auth" })
    record_attempt(meta, success=true)

    if action == "list_transactions":  return respond({ ok: true, data: list_transactions() })
    if action == "create_transaction": return respond(create_transaction(request.body))
    # ...
    return respond({ ok: false, error: "unknown_action" })
```

Key rules:
- Always wrap request body parsing in try/catch — malformed input returns `invalid_json`, not a 500.
- Keep the router thin — no business logic here, only dispatch.
- List actions that require lazy migration run the migration **before** the list: `migrate_xxx(); return list_xxx()`.

### Lazy migration

When a schema adds new fields, a migration helper back-fills existing rows on the first list call after deployment. These are idempotent and run only once (they check for completion before acting). Add the migration to the domain's core file; call it from the router before the matching list action returns.

---

## `<domain>-schema` — field registry

Single source of truth for every entity. It answers: what fields does this entity have, in what order, what type, which variants they apply to, whether they're required, whether they're editable.

### Schema object structure

```
ACCOUNT_SCHEMA = {
  "id": {
    column_name:  "id",
    position:     1,         # drives column/field order; append-only — never change existing positions
    ui_label:     "ID",
    type:         "string",  # string | number | boolean | enum | date | datetime | multi-select
    enum_values:  null,      # list of allowed values, or null
    group:        "core",    # used by frontend to group fields in forms
    applies_to:   null,      # null = all variants; list = restrict to these discriminant values
    required_for: null,      # null = never required; [] = optional; ["savings"] = required for that variant
    editable:     false,     # false = never writable after creation (IDs, types, created_at)
    default_value: null,
  },
  ...
}
```

### Required helper functions — every schema must expose these

```
# 1. Ordered field name list — used to initialise the data store table/collection
get_<domain>_columns() -> list[str]

# 2. Field lookup by key — throws on unknown key (fail loudly, not silently)
get_<domain>_field(key) -> field_definition | raise Error("Unknown field: <key>")

# 3. Fields applicable to a specific variant
get_fields_for_<domain>_type(type) -> list[field_definition]

# 4. Client-safe schema subset — returned by get_<domain>_schema action
get_<domain>_schema_for_client() -> dict
```

### Position rules

- **Positions are append-only.** Never change an existing field's position — doing so silently misaligns the schema against stored data.
- **Add new fields at unused high positions** or fill gaps in the sequence.
- `applies_to: null` — field applies to all rows of this entity.
- `applies_to: ["credit_card"]` — field only applies to rows where the discriminant field has this value.
- `editable: false` — the `write_field` helper skips this field on updates. Use for IDs, creation timestamps, and type discriminants that cannot change after creation.

---

## `<domain>-core` — CRUD

Business logic for one entity. Four standard functions:

```
list_<domain>s()
create_<domain>(body)
update_<domain>(body)
delete_<domain>(body)
```

### list — seed on first use

```
function list_categories():
    rows = data_layer.get_rows(CATEGORIES_TABLE)
    if len(rows) == 0:
        seed_categories()
        rows = data_layer.get_rows(CATEGORIES_TABLE)
    # type coercion: external stores may return booleans as strings
    for row in rows:
        row["is_active"] = coerce_bool(row["is_active"])
    return rows
```

**Type coercion rule**: External data stores (spreadsheets, some DBs, CSV) may return booleans as `"TRUE"`/`"FALSE"` strings. Always coerce explicitly in list functions, not in create/update.

### create — validate-first pattern

```
function create_transaction(body):
    # 1. Validate first — nothing is written if validation fails
    v = validate_transaction_create(body)
    if not v.ok: return v

    # 2. Build the record
    record = {}
    set_field(record, "id",     generate_transaction_id(body.date))
    set_field(record, "amount", float(body.amount))
    # ... all other fields

    # 3. Persist
    data_layer.append_row(TRANSACTIONS_TABLE, record)

    # 4. Side effects last (e.g. balance adjustments on another entity)
    adjust_account_balance(body.source_account, -float(body.amount))

    return { ok: true, id: record["id"] }
```

`set_field` writes any field, including non-editable ones (ID generation needs this). It is only used in create.

### update — write_field pattern

```
function update_account(body):
    # Bounds / existence check before anything else
    record = data_layer.get_row(ACCOUNTS_TABLE, body.row_id)
    if not record: return { ok: false, error: "invalid_row" }

    v = validate_account_update(body, current_type=record["type"])
    if not v.ok: return v

    # write_field checks field.editable — skips non-editable fields silently
    write_field(record, "name",      str(body.name).strip())
    write_field(record, "is_active", coerce_bool(body.is_active))

    data_layer.update_row(ACCOUNTS_TABLE, body.row_id, record)
    return { ok: true }
```

`write_field` checks `field.editable` and returns without writing if `false`. This prevents callers from overwriting IDs, types, and creation timestamps.

### Two-phase update for entities with side effects

When updating an entity that has side effects on another entity (e.g. a transaction that adjusts an account balance), use two-phase reversal. Validation runs before both phases.

```
Phase 1 — Reverse the old record's side effects
  old = data_layer.get_row(TRANSACTIONS_TABLE, body.row_id)
  adjust_account_balance(old.source_account, +old.amount)  # undo

Phase 2 — Apply the new record
  write_field(...)
  data_layer.update_row(...)
  adjust_account_balance(body.source_account, -float(body.amount))  # apply
```

All validation runs **before Phase 1**. If validation fails, neither phase executes.

Validation for updates receives `old_row` so rules can project the post-reversal state:

```
v = validate_transaction_update(body, old_row=old)
if not v.ok: return v
reverse_transaction_effects(old)
apply_transaction(body)
```

### delete — FK check pattern

Before deleting, check whether any related entity references this record. Return a blocked response with `referenced_count` instead of deleting. The caller uses this to show an informative error.

```
function delete_account(body):
    record = data_layer.get_row(ACCOUNTS_TABLE, body.row_id)
    if not record: return { ok: false, error: "invalid_row" }

    ref_count = _count_transactions_referencing_account(record["id"])
    if ref_count > 0:
        return {
            ok: false,
            error: "account_in_use",
            referenced_count: ref_count,
            hint: "archive_instead",
        }

    data_layer.delete_row(ACCOUNTS_TABLE, body.row_id)
    return { ok: true }
```

FK check helpers are private (`_count_xxx`) and read the data store directly — they do **not** call the other domain's core functions, to avoid circular dependencies.

---

## `<domain>-validation` — input validation

Two functions per entity:

```
validate_<domain>_create(body) -> { ok: true } | { ok: false, error: "snake_case_code" }
validate_<domain>_update(body, old_row) -> { ok: true } | { ok: false, error: "..." }
```

### Validation order — always in this sequence

1. **Required fields** — check presence before anything else.
2. **Enum values** — validate against the schema's allowed list.
3. **Numeric ranges** — positive amounts, valid percentages, valid day-of-month, etc.
4. **Date ordering** — e.g. end date after start date.
5. **Cross-field rules** — e.g. FX rate required for cross-currency transfer.
6. **Cross-entity rules** — e.g. referenced account exists, referenced category exists.

For entities with type-specific required fields, drive the check from the schema rather than hardcoding:

```
fields = get_fields_for_account_type(type)
for field in fields:
    if type not in (field.required_for or []):
        continue
    if body.get(field.key) in (None, ""):
        return { ok: false, error: "missing_" + field.key }
```

For updates, also reject requests that send immutable fields:

```
for field in fields:
    if not field.editable and field.key in body:
        return { ok: false, error: "field_not_editable:" + field.key }
```

---

## `<domain>-utils` — domain helpers

Small, focused helpers. Prefer pure computation — no data store I/O in most of them.

### ID generation

Two patterns:

**Event / journal ID** — date-prefixed, 3-digit sequence, reset per date:
```
2024-01-15-001
2024-01-15-002
```

```
function generate_event_id(date):
    prefix = date[:10]  # "YYYY-MM-DD"
    existing = data_layer.get_column(TABLE, "id")
    max_seq = max(
        int(id[len(prefix)+1:]) for id in existing
        if id.startswith(prefix + "-")
    ) if existing else 0
    return f"{prefix}-{max_seq + 1:03d}"
```

**Resource / entity ID** — type prefix, compact date, 3-digit sequence:
```
ACC-20240115-001
ACC-20240115-002
```

Choose the pattern that fits the entity. Both scan the existing ID column to find the highest sequence for the current date prefix, then increment.

### Computed field adjustment

```
function adjust_account_balance(account_id, delta):
    record = data_layer.get_row_by_id(ACCOUNTS_TABLE, account_id)
    if not record:
        log.warning(f"adjust_account_balance: account_not_found id={account_id}")
        return { ok: false, error: "account_not_found:" + account_id }
    new_balance = float(record["current_balance"] or 0) + delta
    data_layer.update_field(ACCOUNTS_TABLE, account_id, "current_balance", new_balance)
    return { ok: true }
```

Returns `{ ok, error }` rather than throwing. Old-row references during update reversal may point to entities that no longer exist — callers tolerate a miss and log it.

---

## `<domain>-seed` — default data (optional)

For entities that need rows pre-populated on first use.

```
CATEGORY_SEED = [
    { "tx_type": "money-in",  "major": "Income",   "minor": "Salary",  "is_active": true },
    { "tx_type": "money-out", "major": "Housing",  "minor": "Rent",    "is_active": true },
    # ...
]

function seed_categories():
    if data_layer.row_count(CATEGORIES_TABLE) > 0:
        return   # idempotent — do nothing if rows exist
    for row in CATEGORY_SEED:
        data_layer.append_row(CATEGORIES_TABLE, row)
```

The list function calls `seed_<domain>()` when the result set is empty. The seed is idempotent — it checks for existing rows and exits if any are present.

---

## External HTTP calls

When a domain needs to call an external API, follow this pattern in any language:

```
function call_external_api(url, payload, api_key):
    try:
        resp = http_client.post(
            url,
            json=payload,
            headers={"Authorization": "Bearer " + api_key},
            timeout=30,
        )
        if resp.status_code != 200:
            log.warning(f"call_external_api: status={resp.status_code}")
            return { ok: false, error: "api_error_" + str(resp.status_code) }
        return { ok: true, data: resp.json() }
    except Exception as e:
        log.error(f"call_external_api: error={e}")
        return { ok: false, error: "fetch_error" }
```

Key rules:
- Always handle non-2xx responses explicitly — do not let the HTTP client throw for you.
- Wrap in try/catch to handle network failures.
- Store API keys in environment variables / secret store, never in code.
- Return `{ ok: false, error: '...' }` on failure — same shape as all other responses.

---

## Coding guidelines

> Naming conventions are in **APP-CONVENTIONS.md**.
> Logging standards are in **APP-LOGGING.md**.

### Public vs private helpers

Prefix private module helpers with `_` (e.g. `_validate_financial_rules`, `_count_transactions_referencing_account`). Public functions are unprefixed: `create_transaction`, `list_accounts`.

### set_field vs write_field

- **`set_field`** — used in create functions. Writes any field, including non-editable ones (you need this to set the ID on creation). Skips silently if the key is not in the schema.
- **`write_field`** — used in update functions. Checks `field.editable` and skips if `false`. This prevents callers from overwriting immutable fields.

### Record existence check before update/delete

Before any update or delete, verify the record exists:

```
record = data_layer.get_row(TABLE, body.row_id)
if not record: return { ok: false, error: "invalid_row" }
```

### Timestamps

Use UTC ISO 8601 strings for `created_at` / `updated_at`. Store as strings to avoid timezone interpretation issues in data stores that auto-convert datetime values.

### Return shape consistency

Every function that can fail: `{ ok: false, error: "snake_case_code", detail?: "..." }`.
Every function that succeeds: `{ ok: true, ...data }`.
The router serialises these to JSON and returns them. Never return raw unstructured objects from domain functions.

### No unhandled exceptions in handler paths

Unhandled exceptions produce unexpected responses (HTML error pages, empty bodies). Validate defensively so exceptions are never reachable in normal operation. Wrap any code that can fail (external HTTP, JSON parsing, data store reads) in try/catch.

---

## Cross-domain dependencies

Conceptual dependency order (lower layers have no deps on higher):

```
config            (no deps)
utils             (no deps)
auth              (uses config)
<domain>-schema   (uses utils)
<domain>-utils    (uses schema helpers)
<domain>-validation (uses schema, utils, cross-domain schemas)
<domain>-core     (uses all of the above)
router            (uses everything)
```

When validation or core reads another entity (e.g. `transaction-validation` checking that an account exists), it calls that domain's **schema helpers and data layer directly** — it does **not** call the other domain's core functions (e.g. `list_accounts()`). This avoids circular calls and unnecessary overhead.

---

## Adding a new domain — checklist

1. Add table/collection name constant to `config`.
2. Create `<domain>-schema` with the field registry and all four required helper functions.
3. Create `<domain>-validation` with `validate_<domain>_create` and `validate_<domain>_update`.
4. Create `<domain>-utils` with ID generation and any domain-specific helpers.
5. Create `<domain>-core` with list / create / update / delete.
6. If the list function needs seed data, create `<domain>-seed`.
7. If list needs a lazy migration pass, add a `migrate_xxx()` function in core and call it from the router before the list action returns.
8. Add dispatch cases to the router for every new action.
9. Add a `get_<domain>_schema` action — the frontend uses this to build forms without hardcoding enums.

---

## Common pitfalls

| Pitfall | What happens | Fix |
|---|---|---|
| Raw table/collection name string in domain code | Typo causes silent miss | Use named constants from `config` |
| Hardcoded field index instead of schema lookup | Breaks silently when fields are reordered | Use `get_<domain>_field(key)` — throws on unknown key |
| Changing an existing field position | Stored data misaligns with schema silently | Only add at unused high positions; never reorder |
| Unhandled exception in a handler | Returns HTML/stack trace instead of JSON | Validate defensively; wrap risky calls in try/catch |
| Side effects before validation | Store mutates on invalid input | Validate fully before any `append_row` or `update_row` |
| Using `set_field` in update | Overwrites immutable fields (id, type, created_at) | Use `write_field` in update — it checks `field.editable` |
| Missing record existence check | Update/delete on stale ID corrupts data | Always get_row and check before update/delete |
| Cross-domain core function call in validation | Circular dependency risk; unnecessary overhead | Call schema helpers and data layer directly |
| No try/catch around external HTTP | Network error returns unexpected response format | Always wrap external calls; return `{ ok: false, error }` |
