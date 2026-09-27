# VelvetOS Control Center

Milestone 1 browser frontend for the Velvet Factory instance.

- V12 Aurora Premium is the visual baseline.
- UI modules are declared in `src/registry.ts`; the board does not hard-code module identities.
- Layout preferences use versioned browser-local presentation state only.
- Business data comes from `velvetos.control.v1`; demo KPIs are intentionally absent.
- Search uses the Control API search endpoint.
- No mutation/action execution is enabled in this milestone.

## Local development

```
npm install
npm run dev
npm run build
```

Set `VITE_CONTROL_API_BASE` only when the host does not expose the default same-origin `/api/control` adapter.
The browser must never receive the Cloud Run bearer secret directly; production auth belongs in a server-side/site adapter.

## Verification

```
npm test
npm run build
npm run smoke:host
node scripts/capture-qa.mjs
```

The visual QA script uses the locally installed Chrome through `playwright-core`; it does not download or pin a browser build.

Production hosting and the fail-closed authentication boundary are documented in `DEPLOY.md`.
