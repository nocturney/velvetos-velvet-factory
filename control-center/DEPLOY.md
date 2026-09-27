# Control Center deployment contract

This frontend is safe to deploy only behind an authenticated owner-only front door.

## Security boundary

The browser never receives `VELVETOS_CONTROL_API_TOKEN`.
The Node host proxies only read endpoints:

- `GET /v1/snapshot`
- `GET /v1/search?q=...`
- `GET /v1/capabilities`

`POST` is rejected and `/v1/actions` is not exposed.

The current `velvetos-control-api` Cloud Run service is publicly invokable at the platform layer, but protected by the application token. Therefore the Control Center proxy itself MUST NOT be deployed as an unauthenticated public service: doing so would turn its server-side credential into a public read gateway.

## Required production shape

1. Build the container from `control-center/Dockerfile`.
2. Run it with a dedicated service identity.
3. Mount `velvetos-control-api-token` from Secret Manager as `VELVETOS_CONTROL_API_TOKEN`.
4. Set `VELVETOS_CONTROL_API_URL` to the canonical Control API URL.
5. Keep the Control Center service private until an authenticated owner-only Site/front-door adapter is verified end to end.
6. Do not put bearer tokens in `VITE_*`, HTML, JS bundles, query strings, or browser storage.

## Current verified target

- project: `instamcp`
- region: `me-west1`
- Control API service: `velvetos-control-api`
- current Control API URL: `https://velvetos-control-api-3sz7smh74a-zf.a.run.app`
- secret exists: `velvetos-control-api-token`

These values were inspected, not mutated, during the 2026-09-27 implementation pass.

## Build

From the frontend repository root:

```sh
gcloud builds submit . \
  --project instamcp \
  --config control-center/cloudbuild.json
```

Do not deploy with `--allow-unauthenticated`.

A private staging deployment can use `min-instances=0` and `max-instances=1`, but creating or changing cloud resources remains a separate deployment action and should be performed only after the authenticated front-door route is known.

## Acceptance gates

Before any production cutover:

1. `npm test`
2. `npm run build`
3. `npm run smoke:host` against a live Control API
4. `node scripts/capture-qa.mjs`
5. browser bundle scan contains zero Control API secret values
6. snapshot returns `schema=velvetos.control.v1`
7. unavailable/needs_sync/conflict remain visually distinct from ready
8. direct POST is 405
9. `/api/control/v1/actions` is 404
10. authenticated Site/front-door roundtrip is verified from the actual deployed UI
