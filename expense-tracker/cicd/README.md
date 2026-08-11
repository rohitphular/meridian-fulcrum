# Expense Tracker — CI/CD

Backend deploy pipeline. Pushes `.gs` source to a GAS project draft and promotes it to a new live version on the configured deployment. **Backend-only — git is not part of this script.**

## Folder contents

| File | Purpose |
|---|---|
| `envs.json` | Single source of truth for both envs' Script ID + Deployment ID + /exec URL. Edited by hand. |
| `script-deployment.sh` | Backend deploy pipeline — takes env as required first arg; pure clasp (no git). |

## Prerequisites

| What | How |
|---|---|
| `clasp` CLI | `npm install -g @google/clasp` |
| `clasp login` done | One-time OAuth |

## Environments

Configured in `cicd/envs.json`. Each env declares `script_id`, `deployment_id`, `script_url`:

| Env | When to use |
|---|---|
| `dev` | Iteration — pushes to the dev GAS project |
| `prod` | Live — pushes to the prod GAS project |

Until prod's IDs are filled in (currently `TODO`), prod deploys are refused. The env list in the menu is derived from `envs.json` — adding a new top-level block in that file makes it selectable.

## The model

Three files are involved at deploy time:

1. **`cicd/envs.json`** — read-only source of truth. The script reads IDs from here.
2. **`backend/.clasp.json`** — committed with `"scriptId": "${SCRIPT_ID_PLACEHOLDER}"`. The script writes the real `scriptId` here at the start of the deploy and restores the placeholder on exit (via an `EXIT` trap that fires on success, failure, or Ctrl-C).
3. **`app/config.js`** — committed with runtime hostname detection. `file://` / `localhost` → dev URL; `*.github.io` → prod URL. **NOT touched by the deploy script.**

## Deploy flow

The canonical entry point is the Forge launcher:

```bash
bash forge/deploy.sh
```

It asks for app and env, then dispatches. You can also call the script directly:

```bash
bash cicd/script-deployment.sh dev  "expense-tracker: <change>"
bash cicd/script-deployment.sh prod "expense-tracker: <change>"
```

### What `script-deployment.sh` does (5 steps)

1. **Validate env arg** against `envs.json`. Unknown env is rejected with the list of valid envs.
2. **Resolve `scriptId` + `deploymentId`** for that env from `envs.json`. Refuses if either is `TODO`.
3. **Install EXIT trap** that restores `backend/.clasp.json` `scriptId` to the placeholder — fires on any exit path.
4. **Write target env's `scriptId`** into `backend/.clasp.json` so `clasp push` targets the right GAS project.
5. **`clasp push --force`** uploads `.gs` source → **`clasp deploy --deploymentId <id>`** promotes it to a new live version on the env's deployment.

Script exits → trap fires → `.clasp.json` back to `${SCRIPT_ID_PLACEHOLDER}`.

## First-time setup (per environment)

Do this once for `dev`, then again for `prod`.

1. **Sheet** — create a Google Sheet (e.g. `Expense Tracker — DEV`). Tabs (`transactions`, `categories`, `accounts`, `rates`, `audit_access`) auto-create on first request.
2. **Apps Script** — in the Sheet: Extensions → Apps Script. Note the **Script ID** in Project Settings → IDs. Enable the manifest in **Project Settings → Show "appsscript.json"**, then paste:
   ```json
   {
     "timeZone": "Europe/London",
     "exceptionLogging": "STACKDRIVER",
     "runtimeVersion": "V8",
     "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
   }
   ```
3. **Script Properties** — add three:
   - `PIN_SECRET` — numeric PIN (different per env)
   - `TOTP_SECRET` — Base32 secret. Generate: `python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"`. Add to an authenticator app.
   - `TOTP_ENABLED` — `false` for dev (faster iteration), `true` for prod.
4. **Record the Script ID** in `cicd/envs.json` under the matching env. Leave `deployment_id` and `script_url` as `TODO`.
5. **Bootstrap push** — `script-deployment.sh` refuses while `envs.json` has TODOs, so for the first push hand-edit `backend/.clasp.json` to set `scriptId` to this env's value, then:
   ```bash
   cd backend/
   clasp push --force
   cd ..
   ```
6. **Deploy** — in the Apps Script editor: **Deploy → New deployment → Web app**, Execute as = `Me`, Access = `Anyone`. Copy the `/exec` URL.
7. **Record the deployment** in `cicd/envs.json`:
   - `deployment_id` — the long segment between `/s/` and `/exec`
   - `script_url` — the full `/exec` URL
8. **Update `app/config.js`** — paste the env's `/exec` URL into the matching constant (`DEV_SCRIPT_URL` or `PROD_SCRIPT_URL`).
9. **First real deploy** — `bash cicd/script-deployment.sh <env> "bootstrap"`.

After step 9, subsequent deploys are one command: `bash forge/deploy.sh`.

## Frontend hosting

`app/config.js` is committed. On load, it picks the backend `/exec` URL based on `location.hostname` — no per-deploy file mutation, no build step.

| Where the page is loaded | URL chosen |
|---|---|
| `file://app/index.html` | dev |
| `http://localhost:*` | dev |
| `https://*.github.io/...` | prod |

To host on GitHub Pages: push `main` to GitHub, enable Pages from the main branch. Hosted = prod automatically. Local = dev automatically.

## Alternative — manual backend push, no script

When you want to push without involving the deploy script:

```bash
# 1. Hand-edit backend/.clasp.json so scriptId = the target env's value from envs.json
cd backend/
clasp push --force
clasp deploy --deploymentId "<paste from envs.json>" --description "your description"
# 2. Restore the placeholder in .clasp.json — by hand, OR by running script-deployment.sh once
#    (which flips to env's scriptId, then trap restores placeholder on exit).
```

## Safety notes

- `clasp push --force` overwrites the GAS draft with local files. If you edited code in the GAS browser editor since the last push, run `clasp pull` first.
- `clasp login` tokens expire roughly once per year. Re-run `clasp login` if `clasp deploy` fails with an auth error.
- The PIN + TOTP gate is what protects your data, not the URL. Both URLs are publicly committed.
