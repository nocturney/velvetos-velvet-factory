# Portal M2 / P0 — Private signed Fleet read-only snapshot (isolated candidate)

**Stage:** CODE + TESTS ONLY, NOT PROVISIONED, NOT DEPLOYED, NOT PUBLISHED. Separate Draft PR, based on the exact portal P0 Release Candidate `31f0a97c3a6aef11f277f44d89e91561f94ba66d`. Production/staging traffic, Cloud Run environment, Fleet host, source of truth, machine accounts and IAM remain unchanged.

## Goal and trust boundary

Chris's canonical Velvet Fleet Console remains the source. The owner portal may later read a **derived private snapshot**, but cannot connect directly to home LAN `4173`, issue deployment commands, or store a competing workstation registry. Only allowlisted identity/platform/source status/timestamps and coarse CPU/memory fields are ever projected; raw app inventory, network interfaces/IPs, passwords and bearer tokens are excluded.

The publisher is **not** enabled in this patch. The `createSignedFleetSnapshot` helper produces a versioned Ed25519 envelope from explicitly supplied raw machine rows for deterministic tests and a future consented publisher. Only a pinned Ed25519 *public* SPKI key is configured on the portal. A real signing private key must remain exclusively on the authorized publishing host and never enter the repository, GitHub Actions, Cloud Run env or a web page.

### Read-only envelope

`velvetos.portal.fleet-signed-envelope.v1` includes a pinned `keyId`, positive integer `sequence`, ISO `issuedAt`/`expiresAt`, complete minimal `velvetos.portal.fleet-machines.v1` projection and Ed25519 signature. The signed domain prefix disambiguates the signature from other documents. Strict unknown-field rejection, duplicate-ID checks, max 300 machines, 512 KiB raw bound and **max 90 second TTL**. The verifier allows <=5s publisher clock lead, denies signatures from other keys, invalid/malformed/future/expired data, old sequence or same sequence with a different signature.

**Important replay limitation:** sequence guard is per Node process/instance, not a globally durable clock. A replay from a previous valid version inside the 90s freshness window after process restart is theoretically possible until publication uses GCS generation preconditions and a durable monotonic publisher counter/receipt. Acceptable only for a **read-only** advisory P0 snapshot; no control-plane action may depend on this state. For stronger guarantees, complete storage generation and publisher monotonic receipt before activation.

### Cloud Run private GCS reader (disabled by default)

Only when `VELVETOS_FLEET_SNAPSHOT_MODE=gcs`, require:

- `VELVETOS_FLEET_SNAPSHOT_BUCKET` — exact private approved bucket (not created)
- `VELVETOS_FLEET_SNAPSHOT_OBJECT` — exact path like `portal/fleet/status.json`
- `VELVETOS_FLEET_SNAPSHOT_KEY_ID` — approved key version, e.g. `fleet_2026_10`
- `VELVETOS_FLEET_SNAPSHOT_PUBLIC_SPKI_B64` — pinned Ed25519 verification *public* key

The reader calls the Google metadata service for a short-lived **OAuth access token** (not an ID token), then GETs only `https://storage.googleapis.com/download/storage/v1/b/<bucket>/o/<encoded-object>?alt=media`, no redirect, 2.5s metadata deadline, 5s GCS deadline, 512 KiB streamed body cap and JSON-only response; always verifies signature/time/sequence before returning browser data. A failure produces `503 fleet_snapshot_unavailable` and **does not fall back** to the legacy local Fleet, nor reuse a stale successful response. Browser sees neither GCS access token nor signing key. Normal Portal IAP remains required.

No public object, anonymous API, signed download URL, new reverse proxy, Cloud Storage resource or permission is created by the code. The final Cloud Run service identity needs narrowly scoped `storage.objects.get`, and the future writer needs separately reviewed least privilege for controlled atomic object replacement. Confirm project/bucket residency, cost, lifecycle, quotas, CSRF/write separation, signing key rotation and readback before any real upload.

Official documents: https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get and https://docs.cloud.google.com/run/docs/securing/service-identity and https://docs.cloud.google.com/storage/docs/request-endpoints .

### Synthetic-only integration gate

`VELVETOS_FLEET_SNAPSHOT_MODE=test-fixture` is accepted **only** when `NODE_ENV=test`, `HOST=127.0.0.1`, `VELVETOS_FLEET_SNAPSHOT_TEST_ALLOW=1` and the fixture path is an absolute JSON file directly beneath the OS temporary tree. Production Cloud Run has `NODE_ENV=production` and cannot enable this mode. Every test creates its own ephemeral key pair and synthetic fleet rows; **no customer machine records, credentials or images leave Chris** during development.

Existing on-Chris loopback-only viewer Fleet adapter remains the default when signed mode is not set. The portal Fleet card now labels **"עותק חתום"**, shows its last sampled time and expiry, and explicitly clarifies that reported online state is not a live control channel. Any refresh error clears the previous displayed data.

### What was verified / release gates

Deterministic tests under `scripts/fleet-signed-snapshot.node.mjs` exercise signature tampering, forbidden extra fields, key mismatch, expired/future issuance, wrong/duplicate machine identity, replay within a process, invalid locator, metadata-token-only request, GCS fetch failures, oversized/body-type changes and actual Portal HTTP returning 200 only for a correctly signed synthetic fixture and 503 for tamper/stale/rollback. Package build and Docker image-dependency closure enforce the extra module copies. Existing Fleet/Office/mobile/source-truth/Control API smoke tests must stay green on macOS and Windows.

**Open before LIVE:** Build a safe outbound publisher using only Fleet viewer token and a locally secured signing key, durable monotonic sequence/GCS generation CAS, hashed receipts and TTL publication cadence with an existing scheduler. Approve private bucket, IAM/service account, retention/cost and data minimization; verify live Cloud Run signed read, IAP owner Safari, unauthorized user denial, failure/TTL clocks and rollback. Do not enable Portal signed mode in Cloud Run yet.

No new dependency, subscription, source database, scheduler, agent install, Fleet token change or Cloud Run IAM/traffic update is included.
