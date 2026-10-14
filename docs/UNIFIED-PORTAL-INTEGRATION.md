# VelvetOS Unified Portal — Fleet integration slice (2026-10-14)

**Project decision:** VelvetOS is the ONE user-facing entry point for the
workstation fleet, office and studio. Consolidate login, navigation and
trusted API access; **do not consolidate all backend runtimes or create a
second workstation source of truth**. Ignore visual redesign for now.

## Existing service boundaries

| Component | Responsibility and contract |
|---|---|
| VelvetOS Control Center | One portal / browser shell and owner-only authenticated ingress; current milestone is read-only. |
| Velvet Fleet Console 0.8.3 | Existing canonical workstation registry, status, inventory, software and verified fleet deployments. Control host Windows port 4173. |
| Fleet workstation nodes | Actual OS data, heartbeats, collection time, provenance. Do not fabricate CPU usage from inventory hardware descriptions. |
| VelvetOS Core / Office 2.0 | Business and agent task orchestration, protected authority and workflow semantics. Consumes references from Fleet adapters, never replaces Fleet machine records. |
| RustDesk / CortenDesk | Screen/session transport provider, not a new fleet registry. Existing RustDesk identity-to-name mapping is separate and private. |
| Beszel (later) | Optional telemetry provider only if necessary, preserving metric sources, collection times and stale states. |
| Printer/studio modules | Own their domain records, linked in the portal without duplicating ownership. |

## Implemented — narrow, safe vertical slice

This branch extends the *existing* Control Center, without changing its
visual system, with a `Fleet` view and exact one-origin API:

- Browser: `GET /api/fleet/v1/machines` (same origin as Control Center).
- Server: `fleet-projection.mjs` calls ONLY the current Fleet
  `GET /api/machines` using its **existing remote read-only token**, held
  in the server's process environment. No browser Fleet token, no proxy
  pass-through endpoints, no admin token.
- Data contract: `velvetos.portal.fleet-machines.v1` explicitly copies
  node ID/name, platform, claimed status and freshness, source collection
  dates, OS details, CPU model and memory capacity from the existing
  Fleet response. It never fabricates missing values and deliberately
  strips network addresses, installed-software inventories, credentials,
  internal configurations and deployment controls.
- UI: displays the current Fleet list and explicit per-node freshness.
  A failed refresh clears the previous read rather than presenting
  stale data as live.
- Versioned source boundary: Fleet remains canonical; no records
  are copied into VelvetOS Core or written back to Fleet.

**Important first-stage limitation:** The gateway requires
`HOST=127.0.0.1`, `VELVETOS_FLEET_LOCAL_READONLY=1`,
`VELVETOS_FLEET_API_URL=http://127.0.0.1:4173`, and
`VELVETOS_FLEET_READONLY_TOKEN` set securely in the **server process**.
The endpoint also checks that the request originates from loopback.
It rejects other upstream origins, unknown paths and ALL non-GET methods.
An unconfigured gateway fails closed. No remote deployment was opened,
and no control action can be executed from this new integration.

The existing Control Center's general API/shell still REQUIRES a verified
owner-only front door before any wider exposure; the original server
must NOT be started on a public interface and described as secure merely
because the new Fleet integration is guarded.

## Actual observed result on the existing fleet

On Chris Windows, the Fleet backend 0.8.3 returned **5** registered
machine records on `/api/machines`: **4 freshness=live**, **1 unknown**.
This is *not* the same as the **6** RustDesk IDs confirmed earlier.
**No implicit inventory reconciliation:** reconcile the records via a
private, reviewed crosswalk before declaring six machines enrolled,
or treating a RustDesk session ID as a Fleet node ID.

Integration smoke launched Control Center as a **short-lived local-only
process**, authenticated server-to-Fleet with the existing viewer role,
read the versioned projection and then stopped the local test process.
The original Fleet server and RustDesk production services were untouched.

Acceptance evidence:

- `npm run build`: PASS
- `npm test`: 5 existing Vitest + 5 gateway Node tests PASS
- `FLEET_VIEWER_TOKEN_FILE=<owner-private-viewer-token-file> node scripts/smoke-fleet-live.mjs`: PASS, 5 real node projections, 4 live, 1 unknown, no tokens printed, POST denied, unsupported paths 404
- same smoke with `FLEET_BROWSER_SMOKE=1`: Playwright Chromium PASS for one-origin Fleet tab and all five machine rows
- `git diff --check`: PASS

Neither real machine IDs nor access tokens nor an HTML report containing
RustDesk IDs were committed.

## Remaining merge gates (not implemented, not claimed)

1. **Single secure remote entry point:** stable authenticated HTTPS domain,
   owner MFA/passkeys, session management, role-scoped gateways for both
   read and write, trusted device/session logs; do not elevate the existing
   viewer token or expose raw 4173. Support authenticated `wss://` relay
   only after browser acceptance.
2. **Canonical host reconciliation:** correctly match Fleet's five records
   to the six verified RustDesk registrations without guessing by row order;
   enroll missing or correct stale registrations only after approval.
3. **Browser remote desktop:** adapt CortenDesk/stock RustDesk session
   services behind Fleet's Provider contracts; retain fail-closed launch
   restriction and isolated runtime staging until authorized.
4. **Metrics:** actual CPU/RAM/disk/network samples, storage and GPU when
   genuinely supported, with sampling time, explicit stale/unknown.
   Avoid conflating inventoried CPU models with instantaneous load.
5. **Ops:** file upload/download and clipboard; user-authorized terminal,
   basic background services and verified software installation using
   Fleet's already-existing provider/deployment/evidence contracts.
6. **Mobile acceptance:** real Safari iPhone and iPad outside LAN;
   no dependency on a dedicated phone app; touch, keyboard, file picker,
   clipboard, reconnection and login expiry must be verified.
7. **Maintain one portal:** retire only genuinely duplicated frontends once
   equivalent functions are tested, while keeping backend engines
   independent. Avoid a rushed monorepo migration or UI restyling.
8. **Scope exclusions:** OS updates, OS reinstall, boot imaging, recovery
   media, firmware and BIOS/KVM are not requested.

No new provider, production Fleet node, access token, Git secret, hostname,
routing port, firewall rule or cloud service was created/changed in this
implementation.
