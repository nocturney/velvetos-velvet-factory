# Portal P0 — Staging candidate release & rollback contract

## Status
P0 branch only. Keep `main`, production and the currently serving staging revision unchanged unless an explicit traffic-promotion gate passes. Never print app tokens, owner emails or raw Fleet machine IDs into build logs. The staging release is **read-only** and should not enroll Windows nodes or add private Fleet ingress.

## Shipping invariant
The portal builds from `control-center/Dockerfile`. Runtime `server.mjs` statically imports both `fleet-projection.mjs` and `control-proxy-boundary.mjs`: all 3 ESM files MUST ship in the final image. The intermediate build stage also needs scripts for `npm run build` security tests. `npm test` invokes a Dockerfile module-closure test; CI must be GREEN at the exact candidate commit. Node major is pinned to 24-alpine instead of a floating current tag.

## Candidate with no user-facing traffic
1. Record the verified previous Cloud Run ready revision, its traffic percentage, image digest, IAP annotation, ingress, service account, env KEY NAMES and Secret Manager references, IAM anonymous-invoker state; retain the rollback record in private local state, never publish secrets.
2. Build from `git archive` of the exact green commit's tracked `control-center` tree only, not a working tree that can include private untracked files. Use the existing Artifact Registry repository; no external CI worker account changes or new subscription.
3. Use **one tagged Cloud Run revision with `--no-traffic --tag`**. Do not change DNS, IAM, IAP, firewall, tokens, backend services, capacity defaults or Cloud Run main URL traffic. Verify default route stays 100% on old revision and candidate 0%.
4. Anonymous GET tagged URL should redirect or deny under IAP; if it returns portal contents, STOP and remove the tag (no traffic promotion).
5. Test owner browser on new tag (actual iPhone and iPad Safari) plus GET `/api/control/v1/snapshot` through authenticated IAP. Check canonical schema and source timestamps; missing Core/Fleet should be UNKNOWN/DISCONNECTED, never invented ready.
6. Validate static security headers, server-only tokens, no write path, authorized user vs unauthorized user, and rollback instructions before any traffic movement.
7. Promote staging traffic only in a **separate reviewed action**. Original revision must remain identifiable for immediate `gcloud run services update-traffic --to-revisions=PREVIOUS_REVISION=100` recovery if needed; do not execute rollback unless a deployment occurred.

## Gaps
The existing Fleet is on Chris `127.0.0.1:4173`, not Cloud Run. Cloud Run must never be pointed at its own loopback as a pretend way to reach Chris. A true authenticated private backhaul or validated short-TTL outbound read replica is a separate decision. Live remote-control/write workflows have further authority gates. Owner signed in to existing staging URL; that does not prove the **new candidate** or data API succeeds.
