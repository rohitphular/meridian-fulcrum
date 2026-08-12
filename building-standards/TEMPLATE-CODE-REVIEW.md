# CODE-REVIEW Template

<!--
INSTRUCTIONS FOR THE LLM WRITING THE CODE-REVIEW DOCUMENT
==========================================================

WHAT YOU ARE CREATING:
  A standing instruction set used by a reviewer (LLM or human) each time they review this
  module. The output is a directive checklist — every step tells the reviewer what to do,
  not what the standard says. Write for the reviewer, not for yourself.

BEFORE WRITING ANYTHING:
  1. Read every source file in the module.
  2. Read every standards document that governs this module (list them in Step 1).
  3. Read the module's README, config files, and environment documentation.
  Do not write a checklist item you cannot trace back to a source file or a standards rule.

RULES:
  1. Replace every {{PLACEHOLDER}} with the real value. Never leave a placeholder unfilled.
  2. Every [OPTIONAL] section: include it if it applies, delete it entirely if it does not.
  3. Step 4 (language standards) and Step 6 (naming) must be extracted from the standards docs
     for this codebase. Do not write generic best-practice advice. Every check must trace back
     to a specific rule in a standards doc or a pattern the codebase is required to follow.
  4. For Steps 4 and 6, only include checks for patterns the codebase actually uses. If the
     standards doc covers database migrations but this module has none, omit migration checks.
  5. Remove ALL comment blocks (this one included) from the final document.
  6. Run the Self-Check at the bottom before delivering. Then delete the Self-Check section.

STYLE:
  - Directive voice: "Check...", "Verify...", "Confirm...", "Flag..."
  - One sentence per checklist item — state the rule and what constitutes a violation.
  - No filler phrases ("make sure to", "be sure that", "please check").
  - Shorter is always better. If a check restates something obvious, cut it.
-->

---

# CODE-REVIEW — {{MODULE_NAME}}

<!--
  Purpose: one sentence — what this review document is for and who should use it.
  Scope: one sentence — which files and directories are in scope.
  Example:
    Purpose: "Standing instruction set for reviewing the `currency-rates` data-sync job.
              Use this document each time you perform a code review."
    Scope: "Everything under `data-synchronization/currency-rates/` including migrations,
             sources, database helpers, core logic, config, and README."
-->

**Purpose:** {{PURPOSE}}

**Scope:** {{SCOPE}}

---

## Step 1 — Read before reviewing

<!--
  List every standards document the reviewer must read in full before touching any code.
  Also list the module's own documentation (README, config, env file).
  Read: find every building-standards doc referenced by the CLAUDE.md task table for the
  work this module does, then list them all. Omitting one means a rule goes unchecked.
  Format: table with Document path | What it governs.
-->

Read these documents in full before examining any code. They are the authoritative standards this module must conform to.

| Document | What it governs |
|----------|-----------------|
| `{{STANDARDS_DOC_PATH}}` | {{WHAT_IT_GOVERNS}} |

Then read the module's own documentation:

- `{{MODULE_README_PATH}}` — source of truth for what this module does
- `{{MODULE_CONFIG_PATH}}` — {{CONFIG_PURPOSE}} [OPTIONAL]
- `{{ENV_FILE_OR_DOTENV_PATH}}` — which environment variables are defined [OPTIONAL]

---

## Step 2 — File inventory

<!--
  Paste the exact project layout from the module's README here.
  Read: the README Project layout section, then verify it against disk.
  Add a note about what to exclude (build artifacts, dependency caches, generated files).
-->

Confirm every file in the layout below exists on disk, and that no extra source files exist outside the layout. Flag any mismatch in either direction.

```
{{PROJECT_LAYOUT_TREE}}
```

Exclude from this check: {{EXCLUDED_PATTERNS}}

---

## Step 3 — Dead code

For each file in scope, check:

1. **Unused imports** — every import statement must be used within the file it appears in. Flag any that are not.
2. **Unused functions** — every function defined must have at least one call site inside the module, or be a documented external entry point. Flag functions with no call site and no entry-point designation.
3. **Unused variables** — local variables assigned but never read. Flag them.
4. **Unreachable code** — any code after an unconditional return, raise, exit, or equivalent. Flag it.
5. **Unused constants** — module-level constants defined but never referenced anywhere in the module. Flag them.
6. **Orphaned config keys** — every key in the config file must be read somewhere in the code. Flag any key the code never reads.
7. **Orphaned env vars** — cross-check every env var read in code against the env var table in the README. Flag any read in code but absent from docs, and any listed in docs but absent from code.

---

## Step 4 — {{LANGUAGE_NAME}} standards ({{STANDARDS_DOC_FILENAME}})

<!--
  This is the most codebase-specific step. Fill it in by reading the standards doc(s) listed
  in Step 1, then extracting every rule that applies to what this module actually does.

  HOW TO WRITE THIS SECTION:
  - Replace "{{LANGUAGE_NAME}} standards ({{STANDARDS_DOC_FILENAME}})" in the Step 4 header
    with the actual language/framework and doc name.
    Example: "Python standards (APP-BE-PYTHON.md)", "GAS standards (APP-BE-GSCRIPT.md)"
  - Group checks by category using H3 headers. Typical concern areas: Project setup,
    Dependencies, Data access / DB client, Configuration, Schema / migrations,
    Type annotations, Error handling, Concurrency. Add a category for every distinct
    concern area in the standards doc — do not collapse multiple concerns into one.
  - Each item: [ ] checkbox, one sentence, what rule is violated if the check fails.
  - Only include rules the codebase actually uses. Skip categories the module does not need.
  - Do not rephrase the standard — distil it into a single verifiable check.

  DEPTH EXPECTATION: a standards doc typically yields 4–8 categories, each with 3–10 checks.
  The two {{CATEGORY}} blocks below are scaffolding — replace them with the full list.
  A Step 4 with fewer than 4 categories almost certainly missed rules from the standards doc.
-->

Check each item against the standard. Mark PASS or FAIL with file and line reference.

### {{CATEGORY_1}}

- [ ] {{SPECIFIC_CHECK}}
- [ ] {{SPECIFIC_CHECK}}

### {{CATEGORY_2}}

- [ ] {{SPECIFIC_CHECK}}
- [ ] {{SPECIFIC_CHECK}}

---

## Step 5 — Code quality

Check each item. Mark PASS or FAIL with file and line reference.

- [ ] Every external I/O call (HTTP request, database operation, file read/write, queue publish/consume, subprocess) is wrapped in error handling — a failure must not crash the process silently.
- [ ] No exception handler swallows an error without logging it — every caught exception must produce a log entry at warning or error level before returning or re-raising.
- [ ] Every resource that must be released (connection, file handle, transaction, lock) is closed in a finally block or context manager — never left open on the error path.
- [ ] Required configuration fails explicitly at startup if absent — it does not silently fall back to a wrong default.
- [ ] Optional configuration with a safe default uses the optional-read pattern — it does not use the required-read pattern and catch the resulting error as a fallback.
- [ ] No direct console or print output is used in place of the module's logging mechanism.
- [ ] No dependency is known-vulnerable or formally abandoned — lock file is committed and reflects the declared version constraints.

---

## Step 6 — Naming conventions ({{CONVENTIONS_DOC_FILENAME}})

<!--
  Read: the naming conventions standards doc listed in Step 1.
  Extract every naming rule that applies to the artifacts this module uses.
  Group by artifact type. Typical types: Variables and functions, Private helpers, Classes,
  Constants, File names, Database tables, Database columns, Constraints and indexes,
  API routes, Message topics, Config keys. Add one H3 subsection per artifact type that
  has explicit naming rules — do not merge types that have different rules.
  Include the banned generic variable name list — if the standards doc specifies one, use it;
  otherwise use the default list: data, info, result, obj, temp, item, val.
  Delete [OPTIONAL] subsections that don't apply to this module.

  DEPTH EXPECTATION: most naming standards cover at least 4–6 artifact types. The two
  {{ARTIFACT_TYPE}} blocks below are scaffolding — replace them with the full list.
-->

Check each item. Mark PASS or FAIL with file and line reference.

### {{ARTIFACT_TYPE_1}}

- [ ] {{NAMING_RULE}}
- [ ] {{NAMING_RULE}}

### {{ARTIFACT_TYPE_2}} [OPTIONAL]

<!--
  Include only if this module owns database schema, API routes, message topics, config keys,
  file names, or other domain artifacts with explicit naming rules in the standards doc.
-->

- [ ] {{NAMING_RULE}}
- [ ] {{NAMING_RULE}}

### Banned generic names

- [ ] No variable, parameter, local, or constant uses a banned generic name: `{{BANNED_NAMES_LIST}}`

---

## Step 7 — Observability

<!--
  Read: the logging / observability standards doc listed in Step 1.
  Fill in {{LOGGER_INIT_PATTERN}} and {{LOG_FORMAT_PATTERN}} with the exact patterns
  this project requires. Keep the remaining checks as-is — they are universal.
-->

- [ ] Every file initialises the logger using the project's standard pattern: `{{LOGGER_INIT_PATTERN}}`
- [ ] Every log message follows the project's format: `{{LOG_FORMAT_PATTERN}}`
- [ ] Every significant operation logs at start (with its input parameters) and at end (with output counts or final status).
- [ ] Info-level logging is used for normal operation (start, end, counts, status).
- [ ] Warning-level logging is used for skipped items and non-fatal misses (missing file, empty response, retried call).
- [ ] Error-level logging is used only inside error handlers for actual failures.
- [ ] No log message contains any of: API keys, passwords, tokens, session values, or PII.

---

## Step 8 — Documentation accuracy

The README must be accurate enough that a reviewer can understand the module without reading code. Verify each section:

### File inventory

- Every file listed in the README project layout exists on disk.
- No source file on disk (excluding {{EXCLUDED_PATTERNS}}) is absent from the README layout.

### Configuration

- Every env var read in the code appears in the README's env var table.
- Every entry in the README env var table is read somewhere in the code.

### Config file [OPTIONAL]

<!--
  Include only if the module reads a config file (YAML, TOML, JSON, INI, etc.).
-->

- Every key the code reads from the config file appears in the README config section.
- Every key shown in the README config section exists in the actual config file.

### Schema [OPTIONAL]

<!--
  Include only if the module owns a data schema (database tables, message schemas, file
  formats, API response contracts, etc.).
-->

- Every field listed in the README schema section exists in the schema definition source (migration file, DDL, proto, ORM model, etc.).
- No field in the schema definition source is absent from the README.
- Every constraint described in the README (unique, foreign key, check) exists in the schema source.

### API / interface contract [OPTIONAL]

<!--
  Include only if this module exposes an interface with defined consumers: HTTP API, RPC,
  event schema, message format, CLI flags, or exported library API.
  Delete if the module has no external interface contract.
-->

- Every endpoint, route, or operation documented in the contract exists in the code and is reachable.
- Every response field, payload key, or output column the contract documents is produced by the code — no silent omissions.
- Every status code, error code, or failure mode documented in the contract is handled and returned consistently by the code.

### How to run

- Every command shown in the README How to run section matches what the entry script actually executes.
- Every mode, flag, or menu option listed in the README matches the entry script's actual behaviour.

---

## Step 9 — Testing [OPTIONAL]

<!--
  Include this step only if the module has test files OR the standards doc defines testing rules.
  Delete this step entirely if the module has no tests and no test standards apply.
  Read: all test files in the module, and any testing section of the standards doc listed in Step 1.
  Group by test type if the module has multiple (unit, integration, end-to-end, contract).
-->

- [ ] All test files live in the location the standards doc defines — not scattered ad hoc through the source tree.
- [ ] Test infrastructure (database, HTTP, file system, queues) is used at the level the standards doc requires — integration tests use real or containerised equivalents where mock use is prohibited.
- [ ] Shared test helpers and fixtures live in a designated location (e.g. `testutil/`, `conftest.py`, `__tests__/helpers/`) — test files do not import business logic from other test files.
- [ ] Test function names describe the behaviour being verified, not the mechanism — `test_rejects_duplicate_entry_for_same_date`, not `test_upsert_2`.
- [ ] Every test cleans up its own state — no test leaves data that can cause another test to pass or fail depending on execution order.

<!--
  Add further checks here for any test-specific rules in the standards doc (e.g. required
  assertion libraries, forbidden use of time.sleep in tests, coverage thresholds, fixture patterns).
-->

---

## Step 10 — Security

- [ ] No hardcoded credentials, API keys, tokens, or passwords appear in any source file, config file, or comment.
- [ ] All secrets are read from environment variables or a secrets manager — not from config files checked into source control.
- [ ] No secret value appears in any log output — check all log lines that include request parameters, response bodies, config values, or headers.
- [ ] Any input that originates outside the module (user input, external API response, file content) is validated or sanitised before it reaches a system boundary (query, file path, shell command, template).

---

## Step 11 — Report format

Produce a findings report with this exact structure:

```
## Findings

### PASS
- List every checked item that fully complies.

### FAIL
- [file:line] Description of the violation and which step or standard it violates.

### WARNINGS
- Items that are not strict violations but reduce clarity or maintainability.
```

If there are no failures, state explicitly: "All checks passed."

Do not suggest changes beyond what the standards and this document describe. Do not refactor code that is not flagged by a specific check.

---

<!--
SELF-CHECK — complete before delivering. Then delete this entire block.
================================================================
[ ] Every {{PLACEHOLDER}} replaced with a real value.
[ ] Every [OPTIONAL] section: included only if it applies, deleted if it does not.
[ ] Step 1: every standards doc that governs this module is listed — none omitted.
[ ] Step 2: project layout matches the README exactly; exclusion list is accurate.
[ ] Step 4 header: updated with actual language/framework name and standards doc filename.
[ ] Step 4: has at least 4 categories — one per distinct concern area in the standards doc.
[ ] Step 4: every check traces back to a specific rule in the standards doc — no generic advice.
[ ] Step 4: every check is a reviewer directive, not a restatement of the standard.
[ ] Step 6 header: updated with actual conventions doc filename.
[ ] Step 6: has at least 4 artifact-type subsections from the standards doc — none collapsed together.
[ ] Step 6: naming rules extracted from the standards doc — none invented.
[ ] Step 7: logger init pattern and log format pattern match the project's actual pattern.
[ ] Step 8 config file section: included only if the module reads a config file.
[ ] Step 8 schema section: included only if the module owns a schema.
[ ] Step 8 API/interface contract section: included only if the module exposes a defined interface.
[ ] Step 9 (Testing): included with module-specific test checks if tests exist; deleted entirely if not.
[ ] {{EXCLUDED_PATTERNS}} used consistently — not mixed with any other placeholder name.
[ ] All comment blocks removed from the final document.
-->
