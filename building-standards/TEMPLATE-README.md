# README Template

<!--
INSTRUCTIONS FOR THE LLM WRITING THE README
============================================

BEFORE WRITING ANYTHING:
  Read every source file, schema definition, config file, and entry script in the codebase.
  Do not write a single word without first verifying it in the source.

RULES:
  1. Replace every {{PLACEHOLDER}} with the real value. Never leave a placeholder unfilled.
  2. Every [OPTIONAL] section: include it if it applies, delete it entirely if it does not.
  3. One sentence per bullet. No filler, no restating what a name already says.
  4. If a section says "Read X" — read X before writing that section. No exceptions.
  5. Remove ALL comment blocks (this one included) from the final README.
  6. Run the Self-Check at the bottom before delivering. Then delete the Self-Check section.

STYLE:
  - Plain declarative sentences. Active voice. Present tense.
  - No marketing language ("powerful", "seamless", "robust").
  - No meta-commentary ("This section describes…", "As mentioned above…").
  - Shorter is always better. If a sentence adds nothing, cut it.
-->

---

# {{NAME}}

<!--
  One sentence only. What it is + what it does + what it serves (if part of a larger system).
  Example: "Fetches daily currency exchange rates from external APIs and stores them in PostgreSQL, backing the expense-tracker's multi-currency valuation."
-->

{{ONE_LINE_DESCRIPTION}}

---

## What it does

<!--
  3–5 sentences. Cover: core behaviour, what goes in, what comes out, and the key design decision if one is non-obvious.
  Do not explain motivation, history, or future plans.
  Read: the main entry point and orchestration logic before writing this.
-->

{{WHAT_IT_DOES}}

---

## Key concepts [OPTIONAL]

<!--
  Include ONLY if the codebase uses domain terms, data models, or invariants a reader cannot infer from naming alone.
  One bullet per concept. Format: "**Term** — one-sentence definition."
  Delete this section entirely if everything is self-evident.
-->

- **{{TERM}}** — {{DEFINITION}}

---

## External interfaces [OPTIONAL]

<!--
  Include ONLY if the system reads from or writes to anything outside its own process:
  external APIs, databases it does not own, message queues, files, third-party services.
  One subsection per interface. For each: state what it is, the endpoint or location,
  auth requirements, what subset of data is used, and any limits or gotchas.
  Delete this section if there are no external interfaces.
-->

### {{INTERFACE_NAME}}

<!--
  Example interfaces: "stooq HTTP API", "S3 bucket", "Kafka topic orders.created", "Postgres read replica"
  Read: the relevant source file (http client, queue consumer, file reader) before writing.
-->

{{INTERFACE_DETAILS}}

---

## Schema [OPTIONAL]

<!--
  Include ONLY if this codebase defines or owns a data schema:
  database tables, message schemas, file formats, API contracts.
  One subsection per table / entity / schema.

  For each:
    - List every field: name | type | notes (meaning, constraints, default behaviour).
    - State the primary key and any unique constraints.
    - State what happens on conflict (upsert overwrites / skip / error).
    - List derived views or computed outputs as bullets below the table.

  Read: the schema definition source (migration file, proto, JSON schema, DDL, ORM model).
  Never infer field names or types from application code — only from the schema definition.
  Delete this section if this codebase does not own a schema.
-->

### `{{ENTITY_NAME}}`

| Field | Type | Notes |
|-------|------|-------|
| `{{FIELD}}` | `{{TYPE}}` | {{NOTES}} |

<!--
  Repeat the table above for each entity. Add constraint and view notes below each table:
  "Unique on (field_a, field_b) — upserts overwrite on conflict."
  "View v_name — one-line description of what it computes."
-->

---

## Configuration

<!--
  List every configuration input the system reads.
  Read: the config loader, env-var reads, and flag definitions in source — do not guess.
  Required = raises/fails at startup if absent. Optional = has a safe default.
-->

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `{{VAR}}` | Yes / No | `{{DEFAULT_OR_NONE}}` | {{ONE_LINE_PURPOSE}} |

### Config file [OPTIONAL]

<!--
  Include ONLY if the system reads a config file (YAML, TOML, JSON, INI, etc.).
  Show the complete canonical structure with every key the code reads.
  Annotate each key inline. Delete if no config file.
-->

`{{CONFIG_FILENAME}}`:

```{{CONFIG_FORMAT}}
{{CONFIG_CONTENT_WITH_INLINE_COMMENTS}}
```

---

## Project layout

<!--
  List every file and directory that matters to a reader.
  Read: the actual filesystem. Do not invent entries.
  Exclude: build artifacts, dependency caches (.venv, node_modules, target/),
           generated files, IDE folders, lock files, test fixtures.
  For each entry: ≤ 8-word description of its role — not what it contains.
-->

```
{{ROOT_DIRECTORY}}/
├── {{FILE_OR_DIR}}    # {{ROLE_DESCRIPTION}}
```

---

## How to run

<!--
  State exact, copy-pasteable commands in the correct order.
  Read: the entry script, Makefile, or runner before writing — do not assume commands.
  If there are prerequisites (credentials, local files, running services), list them before the commands.
  If there are multiple modes, label each block clearly.
-->

{{PREREQUISITES_IF_ANY}}

```bash
{{COMMANDS}}
```

<!--
  If the entry script presents a menu or prompt, show the exact output the user will see.
-->

---

<!--
SELF-CHECK — complete before delivering. Then delete this entire block.
================================================================
[ ] Every {{PLACEHOLDER}} replaced with a real value.
[ ] Every [OPTIONAL] section: included only if it applies, deleted if it does not.
[ ] Schema section: every field name and type verified against the schema definition source.
[ ] Configuration section: every variable verified against the config loader source.
[ ] Project layout: every listed file exists on disk; no file that exists is missing.
[ ] How to run: every command verified against the actual entry script.
[ ] No sentence describes what a name already makes obvious.
[ ] No marketing language, filler, or meta-commentary.
[ ] All comment blocks removed from the output.
-->
