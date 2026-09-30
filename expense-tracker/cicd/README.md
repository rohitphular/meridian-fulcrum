# Expense Tracker — CI/CD

Backend deploy pipeline. Pushes `.gs` source to a GAS project draft and promotes it to a new live version on the configured deployment. **Backend-only — git is not part of this script.**

## Folder contents

| File | Purpose |
|---|---|
| `envs.json` | Single source of truth for both envs' Script ID + Deployment ID + /exec URL. Edited by hand. |
| `deploy.sh` | Backend deploy pipeline — takes env as required first arg; pure clasp (no git). |
| `../scripts/factory-reset.sh` | Deletes and re-imports the CSV-backed Sheet tabs through the GAS web app. See [Factory reset](#factory-reset-make-factory-reset). |

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
   - `PIN_SECRET` — numeric PIN (different per env)
   - `TOTP_SECRET` — Base32 secret. Generate: `python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode())"`. Add to an authenticator app.
   - `TOTP_ENABLED` — `false` for dev (faster iteration), `true` for prod.
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

## Factory reset (`make factory-reset`)

Rebuilds one environment's spreadsheet from `local/files/*.csv`. Run it from the repository root and pick an environment. The target calls `expense-tracker/scripts/factory-reset.sh <env>`, which only makes HTTP calls to the deployed GAS web app. Deploy the current backend first: the delete endpoint is new and the import endpoints now take raw CSV.

1. **Confirm and sign in.** Type the environment name, then enter your PIN (hidden) and a fresh authenticator code. The script calls `verify`, as the app's login does. Credentials are never passed as command arguments. Like the app, GET calls carry the PIN in the request URL.
2. **Preflight.** Every CSV is sent to its entity's import endpoint with `dry_run: true`, which only parses and validates it without reading or writing any Sheet. Any error stops the run before anything is deleted.
3. **Delete.** `factory_reset_delete_sheets` deletes the 11 CSV-backed tabs: `account_types`, `category_master`, `account_master`, the six account detail tabs, `subscription_master` and `transaction_master`. It requires `confirm: "factory-reset"` and the environment's `spreadsheet_id` from `envs.json`, so a script pointed at the wrong spreadsheet deletes nothing. Every other tab is kept, including `dummy`, `rates`, `audit_access`, `advisor_chat` and `computed_insights`.
4. **Recreate.** The existing `list_transactions`, `list_categories`, `list_accounts` and `list_subscriptions` calls recreate those tabs with current headers. `account_types` and the detail tabs are created by their own imports; no endpoint creates them empty.
5. **Import.** Each file goes, in dependency order, to the same import endpoint the app uses: `create_account_types_bulk`, `create_categories_bulk`, `import_account_data` (with `file_type`) for the account master and six detail tabs, `create_subscriptions_bulk`, then `create_transactions_bulk` for every `transaction_master_*.csv`. One request per file.

The run stops at the first response that is not `ok` or that reports failed rows, and prints that response. It never retries: repeated wrong PINs lock the caller. `rates` must already hold every account currency. Optional overrides: `FACTORY_RESET_DATA_DIR` (CSV folder) and `FACTORY_RESET_ENVS_FILE` (environment registry).

## Safety notes

- `clasp push --force` overwrites the GAS draft with local files. If you edited code in the GAS browser editor since the last push, run `clasp pull` first.
- Re-run `clasp login` if deployment reports expired or invalid credentials.
- The PIN + TOTP gate is what protects your data, not the URL. Both URLs are publicly committed.

## Schema compatibility before deployment

Compare existing tab headers, in order, with the current schema getters and `IMPORT_REGISTRY`. Missing trailing columns can be appended automatically. Renamed or reordered columns return `sheet_header_mismatch` before any data write; migrate those headers and corresponding data explicitly first. In particular, older account currency/date names and subscription layouts must not simply have duplicate new headers appended.

The local regression suite does not inspect live sheet layouts. Run `node --test expense-tracker/tests/*.cjs` from the repository root, then validate the intended environment separately.

For an existing spreadsheet with plural master tab names, deploy this version and run `migrateMasterSheetNames()` before resuming extraction. See [master Sheet naming](../_docs/master-sheet-names.md) for collision checks and the rollout order.

### Account Types configuration

Deploy the updated `account-type-*.gs` implementation and frontend; there is no catalog seed file. Then use Configure → Account Types → Import with the complete `local/files/account_types.csv`. The 13-column file preserves the existing 16 UUIDs and adds `detail_sheet` before metadata. If the live `account_types` tab still has the retired `is_loan` column, delete it first. Classification keys use hyphens. An absent/empty catalog stays empty until this explicit import; an established catalog cannot accept additional identities.

For an existing 12-column Sheet, the same full CSV import validates identities, key equivalence, policy values and dependent account/category references before writing. It upgrades the catalog and dependent keys/hints, marking changed rows pending. The explicit Apps Script alternative is `migrateAccountTypeKeys(catalogRows)` with the parsed full CSV objects. Multi-tab updates are not atomic; retry the same full CSV after an interrupted migration. Apply the current ledger migrations, through `0022`, before extraction. See the [Account Types guide](../_docs/account-types.md) for the full rollout and dependency rules.
