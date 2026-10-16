# Portal P0 — Cloud Run anonymous-auth boundary smoke (NOT owner acceptance)

**2026-10-16 | #30 | read-only / no secrets / no deploy / release gate still BLOCKED**

The new `control-center/scripts/staging-auth-posture.mjs` is an intentionally narrow, explicitly invoked independent HTTP probe for the two **existing** fixed Cloud Run services in project `instamcp` / `me-west1`. It sends exactly three anonymous GETs and reports only status codes / Google-login redirect classification; it **never** sends a cookie, app bearer, API key or identity token, never follows a redirect, never reads a response payload, and never mutates IAP, IAM, Cloud Run, Fleet or DNS.

```bash
cd control-center
node scripts/staging-auth-posture.mjs --live \
  --staging "https://velvetos-control-center-staging-3sz7smh74a-zf.a.run.app" \
  --api "https://velvetos-control-api-3sz7smh74a-zf.a.run.app"
```

An input must be exactly one of the two pinned HTTPS root origins (`velvetos-control-center-staging-3sz7smh74a-zf.a.run.app` or `velvetos-control-api-3sz7smh74a-zf.a.run.app`); even a same-prefix Cloud Run service with another hash is rejected. No arbitrary host/port/route/query allowed. It checks: anonymous staging `/health` is refused (302 to Google sign-in, or 401/403 for a non-browser client); Control API anonymous `/health` is 200; unauthenticated Control API `/v1/snapshot` is 401/403. The latter is intentionally a **public invocation / app bearer** design, not proof of private Cloud Run ingress.

**Observed independently, no credentials:**
- Chris Windows: `curl` GET staging `/health` returned HTTP **302**, redirect host `accounts.google.com` (TLS verification succeeded); Control API `/health` **200**, anonymous `/v1/snapshot` **401**.
- MacMiniOffice Node `fetch` default non-browser request: same staging `/health` returned **401** (no sign-in redirect), API `/health` **200**, API `/v1/snapshot` **401**. This is still anonymous denial, not a failed IAP configuration or a verified user session.
- Read-only Cloud Run metadata: staging IAP enabled, public Invoker principals absent, revision `00006-dgz` remains at 100% and `00007-may` at 0%; Control API public Invoker is intentional and its app-token env binding uses Secret Manager. Staging `VELVETOS_USE_GCP_IDENTITY=0` in the current public-invoker Control API topology.

**The strongest result this probe can return is `PASS_ANONYMOUS_DENIAL_ONLY`, with `releaseGate=BLOCKED_OWNER_SAFARI_AND_PRIVATE_BACKHAUL_UNVERIFIED`.** The protected site could still be unusable for a real owner. This probe cannot establish an authenticated iPhone/iPad Safari session, MFA/session revocation, user authorization scope, private Fleet transport, server-to-server tokens' effectiveness, or rollout/rollback readiness. Never count it as an owner IAP E2E pass or permission to merge/deploy.

Run `node --test scripts/staging-auth-posture.node.mjs` offline for malformed targets, redirect spoofing, public snapshot regression, non-browser 401/403 variants, network failures and the never-send-credentials invariant. These negative tests are wired into existing `npm test`; the live probe is deliberately **not** in CI and needs explicit invocation.

**Follow-up action:** a real authorized owner must complete Safari iPhone + iPad (off-LAN) staging authentication and private Fleet read-only connectivity gate under #30; otherwise retain Draft/blocked and current Cloud Run traffic.
