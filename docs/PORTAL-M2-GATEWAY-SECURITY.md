# Portal M2 P0 — bounded owner-only API gateway security

## Why this is needed
The existing Control Center Node host forwards the canonical application bearer token server-side, but previously used an upstream fetch without explicit redirect denial, request deadline or response byte cap, and relayed an unvalidated upstream body/content-type. Those are release-gate weaknesses before authenticated Internet/Safari access. This scoped change is a security hardening of the existing read-only host; it does NOT create new public access or a competing backend.

## Implemented — no new dependency
- Route allowlist: GET /v1/snapshot, /v1/capabilities, /v1/search?q=(one bounded string <=200). Reject unknown paths, extra/duplicate query params and POSTs **before** any upstream call.
- Validate configured upstream origin: HTTPS or explicit loopback HTTP for local tests; no credentialed URLs, arbitrary paths or query fragments.
- Canonical API fetch: reject all redirects (never forward credentials to a second host), hard 8-second timeout, max 2 MiB streamed/declared body, JSON-only success and JSON parse before forwarding.
- Error responses are sanitized; unauthorized 401/403 remain denied, no upstream diagnostics or token leakage.
- Metadata identity-token fetch is bounded to 2.5 seconds and disallows redirect.
- Control JSON gets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Static assets get CSP/frame-ancestors none/X-Frame-Options DENY; React dynamic layout still supports inline styles but script execution stays same-origin only.
- Reject dotfiles, encoded hidden-file paths and unbundled assets; SPA fallback only for valid extensionless routes. Dev/test can bind `HOST=127.0.0.1`; Cloud Run default binds all interfaces unchanged.

## Automated acceptance
- `npm test`: existing Vitest and local fake-upstream Node tests; no staging tokens or real customer payload.
- `npm run build && npm run smoke:security`: also validates actual built SPA CSP and anti-clickjacking headers.
- GitHub Control Center CI now runs the same post-build security smoke and existing browser-secret grep.
- Local negative fixtures: unknown route/POST, query injection, cross-origin upstream redirect (leak endpoint not contacted), oversized chunked response without Content-Length, malformed JSON, HTML response, denied 401 redacted, dotfile/hidden asset and unknown asset.
- Verify integration with Portal Draft #31 and P1 Production #33 using an isolated additional worktree, not by silently editing those Draft PRs.
- Upstream source truth remains Core `velvetos.control.v1`, no office/fleet writes, no new trust authority or Cloud Run deployment.

## Explicit release blockers
This PR does not itself authenticate users. Actual Cloud Run IAP authenticated owner flows, Google credentials/service account/IAP policy, private connectivity to Chris Fleet 4173, CSRF/Origin policy under write features, real off-LAN iPhone/iPad Safari and human production rollback review remain open under issue #30. Do not publish any backend token to browser bundle or remove IAP.

Rollback: one scoped PR revert. No data migration, schema change, user account provisioning, host startup or service restart.
