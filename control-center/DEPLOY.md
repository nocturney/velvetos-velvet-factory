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

## Optional signed IAP assertion verification (M2 source hardening, not activated)

The Node host can provide **defense in depth** against accidental IAP bypass. By
**default** `VELVETOS_REQUIRE_IAP` is unset (equivalent to `0`), preserving the
current staging routing. This source addition does **not** change IAM, Cloud Run,
traffic, DNS or the deployed revision, and **does not replace IAP**.

Enable only after verifying the exact staging IAP-signed JWT audience and proving
an owner can access a 0%-traffic canary/revision through the authenticated front
door, with a reversible rollout. Do not invent the project number, backend ID,
service name, user email, or a new audience. Use only an audience observed in
an authorized IAP assertion for the intended service:

```text
VELVETOS_REQUIRE_IAP=1
VELVETOS_IAP_AUDIENCE=/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME
# Optional strict allowlist when that signed claim is present:
VELVETOS_IAP_ALLOWED_EMAILS=verified-owner@example.com
```

A Google Cloud Load Balancer backend-service IAP audience instead uses
`/projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID`.
These values are **placeholders**, not deployment instructions or verified
settings. The `VELVETOS_IAP_AUDIENCE` value must be exact. Any setting other
than `0` or `1`, any missing/malformed enabled audience, or a malformed email
allowlist prevents the server from starting.

With the guard enabled, **every route** (`/`, assets, `/health`, `/api/*`) first
requires `x-goog-iap-jwt-assertion` with Google's `ES256` signature and key ID,
issuer `https://cloud.google.com/iap`, exact audience, nonexpired claims and
(optional) exact allowlisted email. No assertion or a key-network failure yields
`401` **before** any credentialed upstream requests or static content. Google's
public JWKS is fetched only from the pinned
`https://www.gstatic.com/iap/verify/public_key-jwk` URL with bounded payload,
short timeout and five-minute in-memory key cache. An unsigned
`x-goog-authenticated-user-email` header is **not trusted**.

The canary should prove both owner Safari signed request flow and unauthenticated
401 for static/API content, inspect error/rollback and freshness on real
Core/Fleet read-only data, then require the separate deployment/traffic gate.
If IAP does not forward the expected signed assertion to the current service,
**do not enable this option on staging/production**; preserve the current private
front door, record the exact blocker and fix the header/audience configuration in
a separately reviewed rollout. Never deploy with `--allow-unauthenticated`.

Official reference: https://cloud.google.com/iap/docs/signed-headers-howto
