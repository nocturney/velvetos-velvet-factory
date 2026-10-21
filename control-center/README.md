# VelvetOS Control Center

Milestone 1 browser frontend for the Velvet Factory instance.

- V12 Aurora Premium is the visual baseline.
- UI modules are declared in `src/registry.ts`; the board does not hard-code module identities.
- Layout preferences use versioned browser-local presentation state only.
- Business data comes from `velvetos.control.v1`; demo KPIs are intentionally absent.
- Search uses the Control API search endpoint.
- No mutation/action execution is enabled in this milestone.

## Local development

```
npm install
npm run dev
npm run build
```

The browser always calls the same-origin `/api/control` adapter. A build-time control URL is not accepted, because Vite would inline it into the bundle.
The browser must never receive the Cloud Run bearer secret directly; production auth belongs in a server-side/site adapter.

## Verification

```
npm test
npm run build
npm run smoke:host
node scripts/capture-qa.mjs
```

The visual QA script uses the locally installed Chrome through `playwright-core`; it does not download or pin a browser build.

On Windows, `scripts/iap-guard-canary.node.mjs` needs Git for Windows (`C:\Program Files\Git\bin\bash.exe`); it uses that bash and its `usr/bin` explicitly, never WSL's `bash.exe`, and fails with an explicit error if Git Bash is missing. The fake gcloud is the only gcloud it runs.

Production hosting and the fail-closed authentication boundary are documented in `DEPLOY.md`.

## Unified VelvetOS portal — Fleet vertical slice (2026-10-14)

Fleet Console is the canonical workstation data/operations owner. The
existing Control Center now offers a `Fleet` tab backed by the local-only,
read-only projection at `GET /api/fleet/v1/machines`. This **does not**
deploy a second management service or change Fleet's production code.

The browser reader (`src/fleet-api.ts`) re-validates every machine record.
Unrecognised platform/status/freshness values become `unknown`; a machine is
shown as reported online only when it is `live` with a valid `lastSeen`,
otherwise its status is `unknown` and `stale`/`unknown` freshness is kept.
A record without a valid `id` and `name`, a duplicate ID, or a count mismatch
rejects the whole snapshot.

For an on-host, non-persistent integration smoke on Chris Windows,
the running existing Fleet service must be accessible on
`http://127.0.0.1:4173`. Set `FLEET_VIEWER_TOKEN_FILE` to the existing
owner-private **read-only remote viewer token file**, then:

```sh
node scripts/smoke-fleet-live.mjs
```

Set `FLEET_BROWSER_SMOKE=1` for an optional headless Chrome UI check.
Neither test copies or prints any token, ID, or private machine payload;
both stop the locally launched Control Center after validation.

A manual local portal process requires explicit
`HOST=127.0.0.1`, `VELVETOS_FLEET_LOCAL_READONLY=1`,
`VELVETOS_FLEET_API_URL=http://127.0.0.1:4173` and
`VELVETOS_FLEET_READONLY_TOKEN` in the server environment.
Do **not** make this gateway publicly accessible or reuse its viewer role
for writes. iPhone/iPad remote access needs a separate authenticated
production gateway acceptance milestone.

See [unified portal integration boundaries](../docs/UNIFIED-PORTAL-INTEGRATION.md).
