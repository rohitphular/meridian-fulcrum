# Expense Tracker — Backend

Apps Script backend, edited locally via [clasp](https://github.com/google/clasp). No browser editor required.

## Folder contents

Source is split into per-domain `.gs` modules. GAS flattens them all into one namespace at runtime.

| Group | Files | Purpose |
|---|---|---|
| App | `app-auth.gs`, `app-config.gs`, `app-router.gs`, `app-utils.gs` | Auth, config, HTTP routing, shared helpers |
| Accounts | `account-core.gs`, `account-schema.gs`, `account-utils.gs`, `account-validation.gs` | Account CRUD, schema, validation |
| Transactions | `transaction-core.gs`, `transaction-schema.gs`, `transaction-utils.gs`, `transaction-validation.gs` | Transaction CRUD, schema, validation |
| Categories | `category-core.gs`, `category-schema.gs`, `category-seed.gs`, `category-utils.gs`, `category-validation.gs` | Category CRUD, schema, seed data, validation |
| Rates | `rate-core.gs`, `rate-schema.gs`, `rate-validation.gs` | FX rate CRUD, schema, validation |
| Advisor | `advisor-core.gs` | LLM advisor endpoint |
| Manifest | `appsscript.json` | GAS runtime config — timezone, V8 engine, web app access |
| clasp link | `.clasp.json` | Links this directory to a GAS project. Committed with `"scriptId": "${SCRIPT_ID_PLACEHOLDER}"`; the real `scriptId` is written by `cicd/script-deployment.sh` at deploy time and reverted on exit. |

`.clasp.json` holds the Script ID — a public identifier, not a secret. OAuth tokens live in `~/.clasprc.json` and are gitignored.

## Where the IDs live

Each environment's Script ID, Deployment ID, and `/exec` URL live in `cicd/envs.json`. See `cicd/README.md` for the env model.

## One-time setup

```bash
npm install -g @google/clasp
clasp login                # opens browser; tokens cached in ~/.clasprc.json
```

## Daily commands

Run from inside `api/`:

```bash
clasp push --force         # sync local → GAS draft (does NOT affect live /exec)
clasp open                 # open the GAS editor in browser
clasp pull                 # pull GAS state back to local
clasp logs                 # tail recent execution logs
```

`clasp` reads `scriptId` from `.clasp.json` — at rest that's the placeholder. To run any of these against a real GAS project, hand-edit `.clasp.json` first to set `scriptId` to the env's value (from `cicd/envs.json`). Restore the placeholder when you're done.

### Push vs deploy — the key distinction

| Action | Effect |
|---|---|
| `clasp push` | Updates the **draft only**. The `/dev` URL reflects it immediately. The live `/exec` URL is unchanged. |
| `clasp deploy` | Snapshots the draft as a new version on the live endpoint. The `/exec` URL (used by `app/config.js`) now serves the new code. |

A push without a deploy means users still see the previous version.

## Shipping a change

The canonical deploy path is:

```bash
bash forge/deploy.sh        # pick expense-tracker, pick env
```

This dispatches to `cicd/script-deployment.sh` which handles env-scoped `scriptId` writing, clasp push, clasp deploy, and placeholder revert.

The deploy is **backend-only** — git operations are NOT performed. Commit and push manually when you're ready to record state in git.

See `cicd/README.md` for the full pipeline detail.

## Testing on /dev before deploying

Each GAS project has a `/dev` URL that always serves the latest draft (whatever was last `clasp push`'d). Useful for fast iteration without burning a new deployment version.

1. Hand-edit `api/.clasp.json` to the env's `scriptId` (from `cicd/envs.json`)
2. `cd backend && clasp push --force`
3. In the GAS editor → **Deploy → Test deployments** → copy the `/dev` URL
4. Temporarily edit the env's URL constant in `app/config.js` to point at the `/dev` URL
5. Test in the browser (must be signed into the same Google account)
6. When done, restore `.clasp.json` to `${SCRIPT_ID_PLACEHOLDER}` and revert `config.js`
