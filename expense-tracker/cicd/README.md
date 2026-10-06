# Expense Tracker — CI/CD

Backend deploy pipeline. Pushes `.gs` source to a GAS project draft and promotes it to a new live version on the configured deployment. **Backend-only — git is not part of this script.**

## Folder contents

| File | Purpose |
|---|---|
| `envs.json` | Single source of truth for both envs' Script ID + Deployment ID + /exec URL. Edited by hand. |
| `deploy.sh` | Backend deploy pipeline — takes env as required first arg; pure clasp (no git). |

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

Deployment is refused if the selected environment still has `TODO` IDs. The interactive menu offers dev/prod; explicit environment arguments are validated against `envs.json`.

## The model

Three files are involved at deploy time:

1. **`cicd/envs.json`** — read-only source of truth. The script reads IDs from here.
2. **`api/.clasp.json`** — committed with `"scriptId": "${SCRIPT_ID_PLACEHOLDER}"`. The script writes the real `scriptId` here at the start of the deploy and restores the placeholder on exit (via an `EXIT` trap that fires on success, failure, or Ctrl-C).
3. **`app/config.js`** — committed with runtime hostname detection. `file://` / `localhost` → dev URL; `*.github.io` → prod URL. **NOT touched by the deploy script.**

## Deploy flow

From the repository root, the deploy entry point is:

```bash
bash expense-tracker/cicd/deploy.sh
```

It asks for an environment and description. From `expense-tracker/`, you can also provide them directly:

```bash
bash cicd/deploy.sh dev  "expense-tracker: <change>"
bash cicd/deploy.sh prod "expense-tracker: <change>"
```

### What `deploy.sh` does (5 steps)

1. **Validate env arg** against `envs.json`. Unknown env is rejected with the list of valid envs.
2. **Resolve `scriptId` + `deploymentId`** for that env from `envs.json`. Refuses if either is `TODO`.
3. **Install EXIT trap** that restores `api/.clasp.json` `scriptId` to the placeholder — fires on any exit path.
4. **Write target env's `scriptId`** into `api/.clasp.json` so `clasp push` targets the right GAS project.
5. **`clasp push --force`** uploads `.gs` source → **`clasp deploy --deploymentId <id>`** promotes it to a new live version on the env's deployment.

Script exits → trap fires → `.clasp.json` back to `${SCRIPT_ID_PLACEHOLDER}`.

## First-time setup (per environment)

Do this once for `dev`, then again for `prod`.

1. **Sheet** — create a Google Sheet (e.g. `Expense Tracker — DEV`). Normal entity tabs initialize through their APIs. `account_types` has no automatic seed: import the supplied 13-column catalog through Configure before creating accounts or using category hints.
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
   - `MERIDIAN_FULCRUM_PIN` — numeric PIN (different per env)
   - `MERIDIAN_FULCRUM_SECRET` — Base32 TOTP secret. Generate: `python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"`. Add to an authenticator app.
   - `TOTP_ENABLED` — `false` for dev (faster iteration), `true` for prod.

   `infrastructure/.env.<env>` holds the same two names and values for the data-synchronization jobs (see [Credentials](#credentials-meridian_fulcrum_pin-and-meridian_fulcrum_secret)). Apps Script can only read Script Properties, so the values live in both places; keep them identical.
4. **Record the Script ID** in `cicd/envs.json` under the matching env. Leave `deployment_id` and `script_url` as `TODO`.
5. **Bootstrap push** — `deploy.sh` refuses while `envs.json` has TODOs, so for the first push hand-edit `api/.clasp.json` to set `scriptId` to this env's value, then:
   ```bash
   cd api/
   clasp push --force
   cd ..
   ```
6. **Deploy** — in the Apps Script editor: **Deploy → New deployment → Web app**, Execute as = `Me`, Access = `Anyone`. Copy the `/exec` URL.
7. **Record the deployment** in `cicd/envs.json`:
   - `deployment_id` — the long segment between `/s/` and `/exec`
   - `script_url` — the full `/exec` URL
8. **Update `app/config.js`** — paste the env's `/exec` URL into the matching constant (`DEV_SCRIPT_URL` or `PROD_SCRIPT_URL`).
9. **First real deploy** — `bash cicd/deploy.sh <env> "bootstrap"`.

After step 9, subsequent deploys are one command: `bash expense-tracker/cicd/deploy.sh`.

## Frontend hosting

`app/config.js` is committed. On load, it picks the backend `/exec` URL based on `location.hostname` — no per-deploy file mutation, no build step.

| Where the page is loaded | URL chosen |
|---|---|
| `file://app/index.html` | dev URL selected, but ES modules require serving the app over HTTP |
| `http://localhost:*` | dev |
| `https://*.github.io/...` | prod |

To host on GitHub Pages: push `main` to GitHub, enable Pages from the main branch. Hosted = prod automatically. Local = dev automatically.

## Alternative — manual backend push, no script

When you want to push without involving the deploy script:

```bash
# 1. Hand-edit api/.clasp.json so scriptId = the target env's value from envs.json
cd api/
clasp push --force
clasp deploy --deploymentId "<paste from envs.json>" --description "your description"
# 2. Restore the placeholder in .clasp.json — by hand, OR by running deploy.sh once
#    (which flips to env's scriptId, then trap restores placeholder on exit).
```

## Loading local CSV files into the Sheet

Loading `../../_do-not-touch` into an environment's Sheet (sheet-rebuild or sheet-sync) is the [ledger-sheet-load](../../data-synchronization/ledger-sheet-load/README.md) data-synchronization job: `make data-sync` → `ledger-sheet-load`. It only calls the deployed GAS web app, so deploy the current backend first.

## Credentials (`MERIDIAN_FULCRUM_PIN` and `MERIDIAN_FULCRUM_SECRET`)

One pair of names everywhere:

| Where | Holds | Read by |
|---|---|---|
| Script Properties of each env's Apps Script project | `MERIDIAN_FULCRUM_PIN`, `MERIDIAN_FULCRUM_SECRET` | `checkPin`, `verifyTotp` |
| `infrastructure/.env.<env>` (gitignored) | the same names and values | ledger-sheet-load and the consolidated pipeline: when both are set they sign in without asking, generating the current authenticator code from the secret |

Leave them empty in an env file to be asked for the PIN and code instead. Anyone who can read a file holding both can sign in to that environment.

**Renaming from `PIN_SECRET` / `TOTP_SECRET`:** in each Apps Script project, add `MERIDIAN_FULCRUM_PIN` and `MERIDIAN_FULCRUM_SECRET` with the old values **before** deploying this backend, then deploy, then delete the old two. Deployed first, every sign-in fails (`auth`) until the new properties exist.

## Safety notes

- `clasp push --force` overwrites the GAS draft with local files. If you edited code in the GAS browser editor since the last push, run `clasp pull` first.
- Re-run `clasp login` if deployment reports expired or invalid credentials.
- The PIN + TOTP gate is what protects your data, not the URL. Both URLs are publicly committed.

## Schema compatibility before deployment

Compare existing tab headers, in order, with the current schema getters and `IMPORT_REGISTRY`. Missing trailing columns can be appended automatically. Renamed or reordered columns return `sheet_header_mismatch` before any data write; migrate those headers and corresponding data explicitly first. In particular, older account currency/date names and subscription layouts must not simply have duplicate new headers appended.

The local regression suite does not inspect live sheet layouts. Run `node --test expense-tracker/tests/*.cjs` from the repository root, then validate the intended environment separately.

For an existing spreadsheet with plural master tab names, deploy this version and run `migrateMasterSheetNames()` before resuming extraction. See [master Sheet naming](../_docs/master-sheet-names.md) for collision checks and the rollout order.

### Account Types configuration

Deploy the updated `account-type-*.gs` implementation and frontend; there is no catalog seed file. Then use Configure → Account Types → Import with the complete `../../_do-not-touch`. The 13-column file preserves the existing 16 UUIDs and adds `detail_sheet` before metadata. If the live `account_types` tab still has the retired `is_loan` column, delete it first. Classification keys use hyphens. An absent/empty catalog stays empty until this explicit import; an established catalog cannot accept additional identities.

For an existing 12-column Sheet, the same full CSV import validates identities, key equivalence, policy values and dependent account/category references before writing. It upgrades the catalog and dependent keys/hints, marking changed rows pending. The explicit Apps Script alternative is `migrateAccountTypeKeys(catalogRows)` with the parsed full CSV objects. Multi-tab updates are not atomic; retry the same full CSV after an interrupted migration. Apply the current ledger migrations, through `0023`, before extraction. See the [Account Types guide](../_docs/account-types.md) for the full rollout and dependency rules.
