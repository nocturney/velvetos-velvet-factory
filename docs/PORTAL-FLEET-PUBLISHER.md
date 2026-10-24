# VelvetOS Portal P0 / M2 · Outbound Fleet Publisher — Isolated implementation

**Work status (2026-10-15): CODE / FIXTURE QA ONLY. No cloud publish, no automatic Windows task, no signing identity provisioned, no real DPAPI production key, no bucket/IAM writes, no portal promotion.**

This branch extends Draft PR #36 (strict signed, short-TTL read replica). It contains a **publisher core** and a guarded one-shot **Chris-only dry-run** executable. The running Velvet Fleet Console remains canonical; no separate inventory database, operator scheduler, authentication or command channel is introduced.

## Security and data contract

- The source is **only** `http://127.0.0.1:4173/api/machines` on Chris. The bearer comes from the protected **Fleet viewer token** file. The publisher first fetches `/api/settings` with that same credential and checks `accessRole === "viewer"` — even if someone mistakenly supplies the administrator bearer, it is rejected before reading machine records. The publisher does **not** access the admin token file or store owner credentials.
- Signing goes through main's source-only `makeSnapshotPublisher` (`fleet-signed-publisher.mjs`, #72), which signs only the allowlisted Fleet projection and self-verifies with the reader's own verifier. IP addresses, machine network inventory, raw app lists, hardware secrets, bearer and passwords are not copied. Ed25519, versioned key ID, at-most-90s TTL and 512KiB max signed response still apply; publisher produces 60s snapshots. Sequences stay strictly above the durable state floor and never below issuance ms.
- `fleet-publisher-state.mjs` stores **only** the monotonically increasing sequence, GCS generation receipt, previous source timestamps and a pending marker in `publisher-state.json`. It never persists machine rows, private signing keys or OAuth/viewer tokens. State writes use same-directory temporary files with create-new semantics, fsync and atomic rename. A separate exclusive file lock rejects concurrent writers and does **not** auto-break a stale crash lock.
- Before upload, the publisher requires the live remote object generation to match its stored generation and reserves sequence in a durable `pending` record. The GCS upload uses a JSON API media POST with **`ifGenerationMatch`**. If the network fails after a possible commit, or a 412/precondition occurs, it **leaves pending** and refuses subsequent automatic uploads; a human must verify object generation and signed receipts before reconciliation. No silent retry, replay or overwrite is permitted.
- GCS writer URI is statically constructed under `https://storage.googleapis.com` with exactly one allowlisted private bucket and object path `portal/fleet/*.json`. The writer's access token comes from an injected narrowly scoped identity provider, never the browser, shell argument, source URL or object. Metadata uses JSON GET, upload uses CAS media POST; both reject redirects, unexpected responses and large bodies. **The default code does not supply a live provider or call GCS.**
- Windows DPAPI CurrentUser signer helper encrypts the Ed25519 PKCS8 signing private key to an explicitly requested `fleet-signing-key.dpapi` file with restrictive access rights. Key generation is an **explicit function call**, never on import, host boot or test startup. The temporary DPAPI test key (Windows only) must be created under OS temp and destroyed at test end. A production key must be created only under an owner-approved identity/ACL and be loadable by the exact intended Windows user task account.

## Modules and responsibility

- `fleet-publisher.mjs`: one-shot bounded canonical GET, actual viewer role check, signed upload with local sequence reservation and receipt only
- `fleet-publisher-state.mjs`: atomic state/lock, identity binding, generation + pending-marker recovery gate
- `fleet-publisher-gcs.mjs`: pinned HTTPS GCS metadata/conditional media-upload transport, injected token provider
- `fleet-publisher-key.windows.ps1` and `fleet-publisher-key.windows.mjs`: optional Windows user-bound DPAPI signer provisioning/loading without private data in process arguments
- `scripts/fleet-publisher.node.mjs`: synthetic concurrency/network/CAS/secret-exclusion source tests
- `scripts/fleet-publisher-key.node.mjs`: skip on non-Windows; Windows DPAPI roundtrip with temporary fixture
- `scripts/fleet-publisher-real-source-dryrun.mjs`: guarded Windows/Chris-only viewer-source to locally signed envelope, entirely ephemeral and with **in-memory fake upload**. Requires `VF_FLEET_PUBLISHER_LOCAL_DRYRUN=1`; no real GCS hostname is contacted. This test is NOT an installer or publisher daemon.

CI `npm test` now runs publisher tests without altering `.github/workflows`; `npm run build` continues to compile only the portal and run its security smoke. Publisher modules and Windows key scripts are **not copied into the Cloud Run runtime image**.

## Explicit activation and rollback gates

1. Get owner-reviewed identity/service account for the uploader with exact bucket/object scope, preferably via managed-folder IAM/conditions and separate from Cloud Run read identity. For overwriting existing objects, GCS requires **both** `storage.objects.create` and `storage.objects.delete`, plus `storage.objects.get` for generation read. Do not grant Storage Admin project-wide. Verify GCS retention/7-day soft delete costs, region/residency, object versioning, IAM/PAP enforcement and who can write/read.
2. Decide approved source host identity and DPAPI CurrentUser key location. Verify ACL, key expiry/rotation procedure, outage/recovery and rollback. Do not store protected private key in repo, Drive or Portal env.
3. Confirm remote empty-object initial bootstrap under `ifGenerationMatch=0` and no competing uploader before creating the actual `publisher-state.json`. Reserve state and verify receipt hash with private storage object after publish. Define a human-in-the-loop recovery procedure for pending/stale lock.
4. Prove real service-account-scoped OAuth token issuance and GCS signed upload/read before adding exactly one existing Windows scheduled-task cadence; monitor expired source and 503 semantics. Browser stays behind IAP, machine control/write operations remain prohibited.
5. Explicit review before any Cloud Run `VELVETOS_FLEET_SNAPSHOT_MODE=gcs`, IAM writes, token rotation or staging traffic promotion; never expose Chris Fleet `4173` or use Quick Tunnel as production access.

Official references:
- https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert
- https://docs.cloud.google.com/storage/docs/request-preconditions
- https://docs.cloud.google.com/storage/docs/access-control/iam-permissions

Parent Issue #37: https://github.com/nocturney/velvetos-velvet-factory/issues/37
Signed reader Draft: https://github.com/nocturney/velvetos-velvet-factory/pull/36
