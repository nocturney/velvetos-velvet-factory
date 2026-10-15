# Portal P0 — responsive shell acceptance (2026-10-15)

This change is a focused accessibility/layout correction to the **existing** React+Vite VelvetOS Control Center. No redesign, new pages, API controllers, state databases, external hosting or Runtime writes.

## Observed baseline

On current main `src/styles.css` had `body{min-width:1180px}` with a 16-column fixed-span board. This creates a document-wide horizontal scroll on phone/tablet viewports and prevents normal in-viewport use.

## Implemented behavior

- Preserve approved desktop typography/layout at desktop widths.
- At tablet sizes, let cards stack within viewport; navigation scrolls independently instead of stretching the page.
- At phone sizes, place search on its own line, stack the existing cards and source/tool collections, and increase small text to readable sizes.
- Preserve all real source-state and fail-closed behavior; no replacement data or demo payload shipped.

## Reproducible local checks

- `npm ci --offline --ignore-scripts --no-audit --no-fund` (worktree only).
- `npm test`: expected 10/10 existing Vitest.
- `npm run build`: Vite 8 TypeScript production build.
- `npm run smoke:mobile`: Chrome headless responsive test using a temporary localhost-only `vite preview` with **disconnected synthetic API fixture**. Asserts no document-wide overflow at selected widths, preserved Tools/Integration and System views, zero uncaught browser exceptions.
- This QA does **not** prove real iOS Safari. Real iPhone/iPad Safari over trusted authenticated HTTPS remains M2 acceptance.

Rollback is reverting this one scoped CSS/QA change. No service restart, Cloud Run deployment, unreviewed merge or mobile app installation.
