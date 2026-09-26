# CI access to VelvetOS Core (private)

`nocturney/velvetos-core` is **private**, and this repo's built-in `GITHUB_TOKEN` can't read it. `Core Runtime Smoke` (`.github/workflows/core-runtime-smoke.yml`) therefore needs one repository secret:

| | |
|---|---|
| Secret name | `VELVETOS_CORE_READ_TOKEN` |
| Type | Fine-grained personal access token (or GitHub App token) |
| Resource owner | `nocturney` |
| Repository access | **Only select repositories → `nocturney/velvetos-core`** |
| Permissions | **Contents: Read-only** (Metadata: Read-only is added automatically). Nothing else. |
| Where | This repo → Settings → Secrets and variables → Actions → New repository secret |

How it's used: the workflow first checks that the secret exists and otherwise fails with `Missing secret VELVETOS_CORE_READ_TOKEN`. It then runs `actions/checkout` on `nocturney/velvetos-core@main` into `vendor/velvetos-core` with that token (masked in logs), which is the layout `scripts/attach-core.sh` expects. After that come `attach-core.sh` (plus `verify-core.sh focused`) and `verify-core.sh --full`.

The token never goes into git or into `core.lock.yml`. Rotate it before it expires; an expired token shows up as a checkout failure in this workflow.

Locally (Cursor / a developer machine), `attach-core.sh` uses your own git credentials. No secret is needed.
