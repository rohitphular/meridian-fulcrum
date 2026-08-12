# Deployment & Environment Management — Patterns

> **Audience**: LLMs and developers deploying or setting up new modules in this codebase.

---

## What the deploy pipeline does (and does not do)

The deploy pipeline is **backend-only**. It pushes source files to the target service and promotes a new live version. It does not:

- Commit, push, or tag anything in git — do that manually.
- Touch frontend files — frontend deploys are separate and auto-triggered.
- Create or modify secrets — those are set once per environment in the secret store (environment variables, secrets manager, etc.).

---

## Invocation

**Interactive (recommended):**

```
./cicd/deploy.sh
# Prompts: pick env → optional description
```

**Direct (for scripting or CI):**

```
./cicd/deploy.sh dev  "<module>: <change description>"
./cicd/deploy.sh prod "<module>: <change description>"
```

The description becomes the deployment label and appears in the deployment history.

---

## The deploy script — six steps

Every deploy script follows this sequence:

### Step 1 — Resolve env

If no env argument is provided, present an interactive prompt. Validate the choice against the environment registry (any top-level key not starting with `_`). Exit with a clear error if the env is unknown.

### Step 2 — Resolve description

If no description is provided and running interactively, prompt for one. Default to `<module>: code pushed` if left blank.

### Step 3 — Validate IDs from registry

Read the env's configuration from the environment registry. Exit immediately with a clear error if any required value is still `TODO` — this prevents accidental deploys to unconfigured environments.

### Step 4 — Install cleanup trap

Register a cleanup hook that fires **regardless of how the script exits** — success, error, or Ctrl-C. The trap's job: restore any files that were mutated during deploy back to their committed placeholder state.

### Step 5 — Inject real config and deploy

Write the real service identifier into the config file (which is committed with a placeholder). Run the deploy command. The real identifier exists on disk only during this window.

### Step 6 — Restore placeholder (via trap)

The cleanup trap fires on exit and rewrites the config file back to the placeholder. The placeholder is a literal string — not a shell variable — so it is immune to environment differences.

---

## Environment registry — `cicd/envs.json`

Single source of truth for all environment configuration. Edit by hand. Never auto-generated.

```json
{
  "_comment": "Describes the purpose of this file — _-prefixed keys are ignored by scripts.",
  "dev": {
    "service_id":  "TODO",
    "endpoint":    "TODO"
  },
  "prod": {
    "service_id":  "TODO",
    "endpoint":    "TODO"
  }
}
```

Rules:
- Any top-level key (except `_`-prefixed ones) is a valid env. Adding `"staging": { ... }` makes it selectable immediately.
- `_`-prefixed keys are skipped by the deploy script — use them for comments or metadata.
- `TODO` in any required field causes the deploy to refuse — intentional safety gate.
- Non-sensitive identifiers (service IDs, endpoint URLs) are committed to git. Secrets (credentials, tokens) are **never** in this file.

---

## Secrets in git — placeholder pattern

Config files that reference a service (e.g. a deploy target config) are committed to git with a **placeholder value**, not a real identifier or credential.

```
# In git:
service_id = "${SERVICE_ID_PLACEHOLDER}"

# During deploy window only:
service_id = "real-service-id-abc123"
```

The deploy script:
1. Writes the real value before the deploy command.
2. Registers a cleanup trap to restore the placeholder.
3. The placeholder is restored whether the deploy succeeds, fails, or is interrupted.

**If a real value is accidentally committed**: assess whether the ID is a credential (rotate it) or just a public identifier (exposure is low, but clean it up). Then restore the placeholder and force-push if needed.

---

## Frontend deploy (separate pipeline)

Frontend assets are static and do not use the backend deploy script.

| Trigger | Result |
|---|---|
| Push to `main` | CI/CD republishes the frontend automatically |
| Local dev | Serve the frontend with a local HTTP server |

The frontend resolves the backend endpoint at **runtime** based on the current hostname — no per-deploy mutation of config files:

| Where loaded | Endpoint used |
|---|---|
| `localhost` / `127.0.0.1` | Dev endpoint |
| Production hostname | Prod endpoint |

Do not edit frontend config files as part of a backend deploy.

---

## First-time setup (per environment)

Do this once for `dev`, then repeat for `prod`.

1. **Provision the service** — create the backend service instance for this environment. Note its ID and endpoint URL.
2. **Configure the secret store** — add all required secrets (credentials, API keys) to the environment's secret store. Never put secrets in `envs.json` or committed files.
3. **Record IDs in the registry** — edit `cicd/envs.json`, set `service_id` and `endpoint` for this env. Replace all `TODO` placeholders.
4. **Bootstrap first deploy** — if the deploy script requires a valid config file to run and that file currently has a placeholder, temporarily set the real value, run the first deploy, then restore the placeholder manually.
5. **Verify the deployment** — confirm the service endpoint responds correctly.
6. **All subsequent deploys** — use the deploy script normally.

---

## Makefile targets — conventions

Use a `Makefile` at the repo root for common operations. Recommended targets:

| Target | What it does |
|---|---|
| `make infra-up` | Start local infrastructure (databases, queues, etc.) |
| `make infra-down` | Stop local infrastructure |
| `make app-start` | Start the frontend dev server |
| `make app-stop` | Stop the frontend dev server |
| `make deploy` | Interactive backend deploy (picks env + description) |
| `make logs` | Open or tail the service logs |

---

## Adding a new module — checklist

1. Create `<module>/cicd/` — add a deploy script and a logs script.
2. Create `<module>/cicd/envs.json` with `TODO` placeholders for `dev` and `prod`.
3. Create or update any config file that the deploy script mutates — commit with the placeholder, not a real value.
4. Complete first-time setup for each environment.

---

## Safety notes

| Situation | What to do |
|---|---|
| Deploy fails mid-way | Identify which step failed. Steps before the deploy command are usually idempotent — re-run the script. If the deploy command itself partially succeeded, check the service's deployment history and re-deploy to get to a known-good state. |
| Config file left with a real ID after a failed deploy | Restore manually: replace the real value with the placeholder string before committing or pushing anything. |
| Registry `TODO` still set after setup | The script will refuse to deploy — this is intentional. Fill in the real IDs before deploying. |
| Deployed to wrong env | Redeploy the correct content to the correct env immediately. Check both envs to confirm the right version is live on each. |
| Secret accidentally committed | Rotate the secret immediately. Remove it from git history. Update the secret store with the new value. |

---

> For running Python jobs and applying migrations, see `APP-CICD-BE-PYTHON.md`.
