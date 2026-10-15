# Portal P0 — Office read-only canonical projection

## Scope
Expose a dedicated **Office** view within the existing Control Center React shell. Only existing `velvetos.control.v1` snapshot fields are consumed; no new Office backend, state authority, approval action or executor.

- Owner Attention is a second view of the existing canonical attention projection and shows no fabricated `0` when the source is unavailable.
- Specialist Roster projects `collections.agents` from the instance tool desk; entries are **registered definitions**, not proof of running workers, execution results or leases.
- Office Policy & Source Map projects `flags.system` and allowlisted policy booleans/counts from the canonical control plane only when `system.state=ready`; missing flags -> UNKNOWN. `dontBotherChristian` is configuration visibility, not an enforcement guarantee.
- All modules have `actions:[]`. No writes, fabricated approval queue, separate scheduler, API routes, or token handling.

## Verification
- `npm test` (10 existing + 8 Office source-truth unit cases).
- `npm run build` (Vite 8).
- `npm run smoke:office`: headless Chromium with three synthetic canonical situations: ready Office roster/policy/attention, unavailable/missing source, and HTTP 503. Tests require safe placeholders instead of stale source data.
- Following combination with Fleet/mobile/source-truth Draft #31, rerun cross-module QA and authenticated Core staging reads before any owner-approved merge. Browser QA on mobile/Safari remains M2 gate.

Source: Core `packages/velvetos_control_api/contributions/{attention,operational,control_plane}.py`, no new authority.

**Not part of this PR:** durable Office tasks/approvals, actionable agent workers, Core #604/#612 authority/lease/QA gates, write intents and production staging.
