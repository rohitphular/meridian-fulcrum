# Forge CI/CD — Reference

> **Audience**: LLMs and developers deploying or setting up new Forge module backends.
> **Stack**: `clasp` (GAS CLI) · `bash` · Google Apps Script Web App deployments · GitHub Pages (frontend)

---

## What the pipeline does (and does not do)

The deploy pipeline is **backend-only**. It pushes `.gs` source files to a Google Apps Script project and promotes a new live version. It does not:

- Commit, push, or tag anything in git — do that manually.
- Touch frontend files — `app/` is served via GitHub Pages on every `git push`.
- Create or modify Script Properties (secrets) — those are set once per environment in the GAS editor.

---

## Invocation

**Interactive (recommended):**

```bash
bash forge/expense-tracker/cicd/deploy.sh
# Prompts: pick env → optional description
```

**Direct (for scripting or CI):**

```bash
bash cicd/deploy.sh dev  "expense-tracker: <change description>"
bash cicd/deploy.sh prod "expense-tracker: <change description>"
```

The description becomes the GAS deployment label — it appears in the Apps Script editor's "Deployments" list.

---

## `cicd/deploy.sh` — the deploy script

```
expense-tracker/
└── cicd/
    ├── deploy.sh    ← interactive launcher + deployment logic
    ├── logs.sh      ← interactive log viewer (pick env)
    └── envs.json    ← script/deployment IDs per env
```

Six steps, in order:

### Step 1 — Resolve env

If no env arg is provided, presents an interactive prompt. Validates the choice against `cicd/envs.json` (any top-level key not starting with `_`). Exits with an error if the env is unknown.

### Step 2 — Resolve description

If no description arg is provided and the script is running interactively, prompts for one. Defaults to `expense-tracker: code pushed` if left blank.

### Step 3 — Resolve IDs

Reads `script_id` and `deployment_id` for the target env from `cicd/envs.json`. Exits with a clear error if either value is `TODO` — this prevents accidental deploys to unconfigured environments.

### Step 4 — Install EXIT trap

Registers a `trap restore_placeholder EXIT` before touching any files. The trap rewrites `api/.clasp.json` back to `${SCRIPT_ID_PLACEHOLDER}` no matter how the script exits — success, `clasp` error, or Ctrl-C. The placeholder is a literal string, not a shell variable.

### Step 5 — Write real `scriptId` into `api/.clasp.json`

Injects the env's `script_id` into `api/.clasp.json` so `clasp` knows which GAS project to target. This file is committed to git with the placeholder; the real ID exists on disk only during the deploy window.

### Step 6 — `clasp push` → `clasp deploy`

```bash
clasp push --force            # uploads .gs files to the GAS draft
clasp deploy \
  --deploymentId "$DEPLOYMENT_ID" \
  --description "$MSG"        # promotes draft → new live version on the env's /exec URL
```

`clasp push --force` replaces the draft with local files. `clasp deploy` creates a new immutable version on the existing deployment (the `/exec` URL stays the same).

On exit, the trap fires and `api/.clasp.json` is restored.

---

## `cicd/envs.json` — environment registry

Single source of truth for all environment IDs. Edit by hand. Never auto-generated.

```json
{
  "_comment": "Not a secret — Script IDs and Deployment IDs are public URL components.",
  "dev": {
    "script_id":     "1pAeKp...",
    "deployment_id": "AKfycbx...",
    "script_url":    "https://script.google.com/macros/s/AKfycbx.../exec"
  },
  "prod": {
    "script_id":     "1yyhaG...",
    "deployment_id": "AKfycbz...",
    "script_url":    "https://script.google.com/macros/s/AKfycbz.../exec"
  }
}
```

Rules:
- Any top-level key (except those starting with `_`) is a valid env. Adding `"staging": { ... }` makes it selectable immediately.
- `_comment` and other `_`-prefixed keys are skipped by the script.
- `TODO` in `script_id` or `deployment_id` causes the deploy to refuse — intentional safety gate.
- IDs are **not secrets**. They are public URL components committed to git.

---

## `api/.clasp.json` — clasp config

```json
{
  "scriptId": "${SCRIPT_ID_PLACEHOLDER}",
  "rootDir": ".",
  "scriptExtensions": [".js", ".gs"]
}
```

- **Always committed with the placeholder** — `${SCRIPT_ID_PLACEHOLDER}` is the literal string in git.
- The deploy script writes the real `scriptId` here at step 5 and restores the placeholder at exit.
- `rootDir: "."` means `clasp push` uploads everything in `api/` (where `.clasp.json` lives).
- `scriptExtensions` limits uploads to `.gs` and `.js` files — JSON, markdown, and other files are excluded.

**Never commit a real `scriptId` here.** If it happens, rotate the GAS project or accept the exposure (Script IDs are not credentials; they just reveal which project to push to).

---

## Frontend deploy (not this script)

The frontend (`app/`) is static and does not use `cicd/deploy.sh`.

| Trigger | Result |
|---|---|
| `git push` to `main` | GitHub Pages republishes `app/` automatically |
| `make app-start` | Serves from `forge/` at http://localhost:8000/expense-tracker/app/ |

`app/config.js` picks the backend URL based on `location.hostname` at runtime — no per-deploy mutation:

| Where loaded | Backend URL used |
|---|---|
| `http://localhost:*` | dev `/exec` URL |
| `https://*.github.io/...` | prod `/exec` URL |

Note: `file://` is blocked at the HTML level — the app refuses to load outside an HTTP server.

Do not edit `app/config.js` as part of a backend deploy.

---

## First-time setup (per environment)

Do this once for `dev`, then repeat for `prod`.

### 1. Create the Google Sheet

Create a blank Google Sheet (e.g. `Expense Tracker — DEV`). All tabs (`transactions`, `categories`, `accounts`, `rates`, `audit_access`) are created automatically on first request — do not pre-create them.

### 2. Create the Apps Script project

In the Sheet: **Extensions → Apps Script**. Note the **Script ID** from **Project Settings → IDs**.

Enable the manifest: **Project Settings → Show "appsscript.json" in Editor**. Replace the manifest with:

```json
{
  "timeZone": "Europe/London",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

### 3. Set Script Properties

In the Apps Script editor: **Project Settings → Script Properties → Add script property**.

| Property | Value |
|---|---|
| `PIN_SECRET` | Chosen PIN (numeric or alphanumeric) — use a different PIN per env |
| `TOTP_SECRET` | Base32 secret. Generate: `python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"`. Add to an authenticator app (Google Authenticator, Authy). |
| `TOTP_ENABLED` | `false` for dev (skip TOTP at login); `true` for prod |

See `APP-AUTH.md` for full auth details including `OPENAI_API_KEY` (only needed if the module uses the advisor).

### 4. Record the Script ID in `envs.json`

Edit `cicd/envs.json`, set `script_id` for this env. Leave `deployment_id` and `script_url` as `TODO` for now.

### 5. Bootstrap push

`deploy.sh` refuses to run while `deployment_id` is `TODO`. For the first push, temporarily hand-edit `api/.clasp.json`:

```bash
# 1. Set scriptId in api/.clasp.json to this env's script_id value
# 2. Push:
cd api/
clasp push --force
cd ..
# 3. Restore the placeholder in api/.clasp.json manually
```

### 6. Create the first deployment

In the Apps Script editor: **Deploy → New deployment → Web app**.

- Execute as: **Me**
- Who has access: **Anyone**

Click **Deploy**. Copy the `/exec` URL.

### 7. Record the deployment IDs in `envs.json`

Update `cicd/envs.json`:

- `deployment_id` — the long token between `/s/` and `/exec` in the URL
- `script_url` — the full `/exec` URL

### 8. Update `app/config.js`

Paste the env's `/exec` URL into the matching constant in `app/config.js` (`DEV_SCRIPT_URL` or `PROD_SCRIPT_URL`).

### 9. First scripted deploy

```bash
bash cicd/deploy.sh dev "bootstrap"
```

All subsequent deploys: `bash forge/expense-tracker/cicd/deploy.sh`.

---

## Adding a new Forge app

1. Create `<app>/cicd/deploy.sh` — copy verbatim from `expense-tracker/cicd/deploy.sh`. Update the banner title and default description string.
2. Create `<app>/cicd/logs.sh` — copy verbatim from `expense-tracker/cicd/logs.sh`. Update the banner title.
3. Create `<app>/cicd/envs.json` with `TODO` placeholders for `dev` and `prod`.
4. Create `<app>/api/.clasp.json` with the placeholder `scriptId`.
5. Complete the first-time setup steps above for each env.

---

## Safety notes

| Situation | What to do |
|---|---|
| `clasp deploy` fails with auth error | `clasp login` tokens expire roughly annually — re-run `clasp login` |
| You edited GAS code in the browser editor since the last `clasp push` | Run `clasp pull` from `api/` first, merge locally, then push — otherwise `clasp push --force` overwrites browser edits silently |
| `api/.clasp.json` left with a real `scriptId` after a failed deploy | Restore manually: replace `scriptId` value with the literal string `${SCRIPT_ID_PLACEHOLDER}` |
| `envs.json` `TODO` still set after setup | The script will refuse — this is intentional. Fill in the real IDs before deploying. |
| `clasp push` succeeded but `clasp deploy` failed | The draft is updated but the live version is not. Re-run the deploy script — `clasp push` is idempotent. |
| Deploying to wrong env | There is no undo for a GAS deploy. Redeploy the correct content to the correct env. Versions pile up in the deployments list — old ones become inactive when a new one is promoted. |

---

## Prerequisites

```bash
npm install -g @google/clasp   # install clasp globally
clasp login                    # one-time OAuth — opens browser
```

`clasp login` persists credentials in `~/.clasprc.json`. The token is associated with the Google account that owns the GAS projects.
