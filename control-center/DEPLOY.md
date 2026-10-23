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
# Required owner identity allowlist; do not enable a canary without it:
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
**required** exact allowlisted owner email. An enabled guard without a nonempty
email allowlist refuses startup rather than accepting any other valid IAP principal. No assertion or a key-network failure yields
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

### Enablement safety (follow-up to #51)

- **Probes.** Keep Cloud Run's default **TCP startup probe**. It needs no HTTP path and
  is unaffected by the guard. Cloud Run liveness probes are HTTP/gRPC only and do not
  pass through IAP, so if a liveness probe is wanted use `httpGet.path: /liveness`.
  The server answers exactly `GET /liveness` (no query, no trailing slash, no
  encoding variants) **before** the guard with the constant body `{"ok":true}`: no
  data, no upstream call, no file read. **`/health` stays guarded**, so never point a
  probe at `/health` once `VELVETOS_REQUIRE_IAP=1`. `/healthz` is deliberately not
  used, because Cloud Run reserves some paths ending in `z`. External requests to
  `/liveness` still go through the IAP front door like every other path.
- **`VELVETOS_REQUIRE_IAP` values:**
  - unset or `0`: disabled. A warning is logged if an audience or email allowlist
    is configured anyway.
  - `""` (set but empty): disabled with a warning, **only if** no
    `VELVETOS_IAP_AUDIENCE` and no `VELVETOS_IAP_ALLOWED_EMAILS` is set. With either
    present the intent to enable is clear, so the server **refuses to start**
    rather than run unguarded.
  - `1`: enabled. A missing or invalid audience, or an absent, empty or malformed
    `VELVETOS_IAP_ALLOWED_EMAILS`, refuses to start.
  - any other value (`true`, `yes`, `" "`, `01`): refuses to start.

  On Cloud Run a refused start leaves the new revision not-ready, so traffic stays on
  the previous ready revision and the platform rate-limits restarts. Deploy guard
  changes to a 0%-traffic revision first.
- **JWKS outage.** Keys are cached for 5 minutes. If a refresh fails (network,
  non-JSON, invalid key set), keys from the **last successful, fully validated**
  fetch stay usable for at most **1 hour** after that fetch, and a single
  `iap_jwks_refresh_failed_using_last_validated_keys` warning is logged. After that
  the guard fails closed (401). A successful refresh fully replaces the key set, so
  rotated-out keys stop working.
- **`crit`.** Any JWT with a `crit` header is rejected, because no critical extensions
  are supported.

Official reference: https://cloud.google.com/iap/docs/signed-headers-howto

## IAP guard canary (0% traffic, staging)

`scripts/iap-guard-canary.sh` is the runbook for turning the guard on for
`velvetos-control-center-staging` (`instamcp`, `me-west1`). It is **dry-run by default**
and **never changes traffic percentages**. Every deploy it builds uses `--no-traffic
--tag iapcanary`. Promotion and full rollback are printed as manual commands for a
separately reviewed gate.

Prerequisites:
- the `/liveness` + enablement-safety change is merged, and CI is green on that exact
  `main` SHA
- an image built from that SHA, referenced **by digest**
- the audience read from `preflight` (`/projects/<projectNumber>/locations/me-west1/services/velvetos-control-center-staging`)
  and cross-checked against the console "Signed Header JWT Audience" or an authorized
  assertion

```sh
scripts/iap-guard-canary.sh preflight                       # read-only facts, env names only
scripts/iap-guard-canary.sh deploy --image REF@sha256:... --audience /projects/N/locations/me-west1/services/velvetos-control-center-staging --allowed-emails verified-owner@example.com
CANARY_CONFIRM=deploy-no-traffic scripts/iap-guard-canary.sh deploy ... --apply
scripts/iap-guard-canary.sh verify                          # anonymous denial + revision Ready + owner steps
CANARY_CONFIRM=remove-tag scripts/iap-guard-canary.sh rollback --apply
```

Pass criteria, all required before any promotion discussion:
1. Traffic percentages are identical before and after the deploy. The canary revision
   is at 0% with tag `iapcanary`.
2. The canary revision is Ready with the HTTP liveness probe on `/liveness`, and its
   logs show no `iap_guard_disabled`, startup errors or liveness failures.
3. Anonymous `/`, `/health`, `/liveness` and `/api/control/v1/snapshot` on the tag URL
   all get 302 to Google sign-in, or 401/403. IAP sits in front of every path, so the
   anonymous 200 on `/liveness` exists only for Cloud Run's internal probe.
4. **Owner Safari (iPhone and iPad, off-LAN):** after IAP sign-in on the tag URL the
   portal loads, data renders, and `/health` returns JSON 200. A private window gets
   Google sign-in. A 401 `{"error":"unauthorized"}` after sign-in means the audience or
   assertion path is wrong: roll back, do not promote.

Rollback: `gcloud run services update-traffic velvetos-control-center-staging --project
instamcp --region me-west1 --remove-tags iapcanary`. The 0% revision then serves nothing.
If traffic was ever moved by a separate action:
`gcloud run services update-traffic velvetos-control-center-staging --project instamcp
--region me-west1 --to-revisions=PREVIOUS_REVISION=100`, with the revision taken from the
`preflight` output.
