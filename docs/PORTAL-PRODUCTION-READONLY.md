# Portal P1 — production source projection, no second authority

This isolated React Control Center enhancement introduces a **Production** tab with two source-backed, read-only modules.

## Authority
- `collections.production`: Core `packages/velvetos_control_api/contributions/operational.py#project_production` from the instance Fleet source, printer metadata, `packages/vfprod/data/print-events.jsonl` and maintenance snapshot. Values are **reported configuration/history**, NOT authenticated live Watchtower/3D printer status or guaranteed active orders.
- `collections.models`: Core `project_models` from `packages/vfsku/SHELF.json`; slot status and license checks are source fields, NOT proof a print is executing.
- Missing, degraded, needs_sync or unavailable collections are shown as unknown/unavailable; no invented 0 printers/models, fake prices, shipping options, machine connectivity or SKU inventory.
- All module `actions: []`; no printing, deployment, file access or write actions.

## Tests
- `npm test`: existing projection tests plus eight source-truth tests.
- `npm run build`: TypeScript + Vite 8.
- `npm run smoke:production`: temporary local loopback Vite preview with three Chromium fixture cases (source ready, source unavailable/needs_sync, HTTP 503).
- Live source compatibility/readback to Core requires authenticated staging and the global M2 gateway before production. No customer or secret data in fixtures.

## Merge
A Draft only. Integrate into the current single-portal release branch after review; avoid UI redesign, new DB and another printer-console authority. One revert removes this tab cleanly.

Source: https://github.com/nocturney/velvetos-core/blob/main/packages/velvetos_control_api/contributions/operational.py
