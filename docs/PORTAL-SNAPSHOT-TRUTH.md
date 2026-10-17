# Portal P0 — source truth and reconnect behavior

## Problem addressed
Current Control Center fetches the canonical Control API snapshot once at startup and labels any non-null result "LIVE SNAPSHOT" indefinitely. A source can become stale or disconnected after the first fetch. This creates an unacceptable misleading operator signal.

## Implementation
- The portal remains a read-only projection; there is no second data owner, database or scheduler.
- Type-guard the canonical `velvetos.control.v1` envelope.
- Honor `connection`, upstream `freshness.state`, `freshness.verifiedAt` and source `generatedAt` without using the local browser fetch moment as a fabricated upstream observation.
- Distinguish live, fresh, stale (90s max observation age), unknown and disconnected.
- Poll `/api/control/v1/snapshot` every 30s while mounted; use AbortController and bounded 8s request timeout, cancel on cleanup and guard overlapping responses with request generation numbers.
- On a failed refresh, clear stale data and show DISCONNECTED, not a permanently green indicator. Do not repeat any side-effecting request.
- Preserve existing source-specific collection states and module selectors.

## Acceptance
`npm ci --offline --ignore-scripts`, `npm test`, `npm run build`.
`npm run smoke:truth` uses ephemeral loopback-only Vite preview + synthetic server fixtures in headless Chromium, checking live/fresh/old/unknown/503/invalid-schema and a failed follow-up refresh. No credentials or live customer data enter fixtures.
Real authenticated Cloud Run staging, historical long-lived Safari sessions and third-party upstream disconnects remain separate M2 acceptance gates.

This PR changes only the existing frontend snapshot client, status presentation, local QA and tests; no Production deployment, backend changes, auth changes or mutable actions. Rollback is one PR revert.
