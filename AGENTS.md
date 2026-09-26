# AGENTS.md — VelvetOS — Velvet Factory (frontend instance)

## VF_PUBLICATION_ROUTE_V1 - current publication scope

Run `scripts/vf_publication_evidence.py --phase production` before production and `--phase delivery` before review delivery, with the exact manifest/content ID. A file-path or static wiring pass is not creative approval. Preserve source pixels, purposeful editorial richness and independent source/reference/copy/brand/final review evidence.

PRODUCT: VelvetOS
ROLE: instance (frontend office)
INSTANCE: VelvetOS — Velvet Factory
CORE: vendor/velvetos-core → nocturney/velvetos-core
FORMULA: Agent = Model + Harness (from Core)

This file is the **guide for this business office**. Core laws still win for send / ₪ / Insights / rights.

## RULES (instance)

- Pull packs and modules from **VelvetOS Core** (`vendor/velvetos-core`). Do not duplicate the pack tree.
- Studio facts: `constitution/STUDIO.md` + `instance/velvet-factory.json`.
- HQ sends Gmail via the connected mail path. Scheduled Instagram publication uses the Cloudflare Instagram Publisher; organic publication targets Meta Instagram Graph API; live status requires Graph/MCP read-back (`vendor/velvetos-core/packages/vfigos/SEND.md`). Never claim a send/publish without receipt/evidence. OpenPost is frozen; executable tool status is `vendor/velvetos-core/packages/velvetos/TOOL-STATUS.json`.
- Christian surface: decisions / hard blockers / live publish needing him only. Preflight (`vfgrowth/PREFLIGHT.md`) fail-closes schedule. Never «רמה נמוכה» upward.
- Never invent ₪ or Insights. No auto-DM, Boost/Ads without lead, customer WhatsApp send, or Print from HQ.
- **PUBLIC_CURRENT_CTA** = Instagram message to `@velvets_cloud` / איסוף שדרות — not bare «שלחו DM», not WhatsApp phone in public copy. BUSINESS_CONTACT_RECORD WhatsApp `050-2517000` stays in desk only.
- Pipeline: פנייה → שיחה → הצעה → הדפסה → איסוף.
- After catalog edits in core: run core `python3 scripts/check-all.py` from the core checkout / vendor.

## OWNER-APPROVED VISUAL STANDARD — COLD-START, mandatory

IDs named in this section are reference identity or hard-reject entries only, never a provider route. The cold-start standard stays fail-closed (Core `scripts/check-visual-standard-bootstrap.py`).

For every Instagram/feed visual workflow, read and obey Core:

- `vendor/velvetos-core/packages/vfom/OWNER-APPROVED-GRID-STANDARD-2026-09-14.md`
- `vendor/velvetos-core/packages/vfom/VISUAL-OS.md`
- `vendor/velvetos-core/packages/vfom/VISUAL-DNA.json`
- `vendor/velvetos-core/.cursor/skills/velvet-brand-guardian/SKILL.md`

Canonical approved visual reference (`Velvet Factory · APPROVED GRID VISUAL STANDARD · 2026-09-14`): artifact SHA-256 `df41281b44e2c1ac99a1cb0c9f084ec926c30774f61468fc8988f59c5a136897`. Public reference: `https://raw.githubusercontent.com/nocturney/velvetos-core/main/packages/vfom/reference/velvet-approved-grid-2026-09-14.jpg`. Portable cross-system prompt: `packages/vfom/VELVET-VISUAL-SYSTEM-PROMPT.md`.

The approved grid standard is the required visual-language and quality floor for feed posts, Reel covers, carousel pages, Story stills, service/editorial tiles and grid planning. It is **not** permission to alter real products: Product Truth, real source evidence, constitution and rights always win.

Required direction: product-first, real photography as truth anchor, `Retouch the photo, not the product`, minimal Hebrew typography, premium/non-template editorial finish, photo-first service communication, curated recipe diversity (hero / UGC-human / macro-detail / minimal-studio / bundle-flatlay / service-editorial / proof-process), coherent feed treatment and exact-final QA.

Hard rejects include placeholders presented as finals, generic icons replacing product photography, synthetic replacement/drift of a real product, fake customer/shelf scenes, stock filler, text-heavy generic template cards and rejected G004 design `DAHUaelaug0` (legacy Canva design ID) as source/style/layout/canonical edit/publish asset.

Any tool or agent that selects media, retouches, designs, builds covers/carousels/stories, plans the grid, runs Brand Guardian/QA or prepares publish preflight must apply this standard before output can PASS. This is a cold-start invariant: a fresh conversation with no previous chat context must still load and verify the standard before creative work without relying on chat history; missing or mismatched binding stops the creative branch as `visual_standard_unavailable` instead of falling back to generic/default model aesthetics. Real product source media remains Product Truth.

## CREATIVE AUTOPILOT

This instance enables `creativeAutonomy.mode=exception-only` with standing authorization for routine organic Instagram publishing.

Use Core:

- `packages/vfom/CREATIVE-AUTOPILOT.md`
- `packages/vfom/VISUAL-OS.md`
- `packages/vfom/EDIT-DIRECTOR.md`
- `.cursor/skills/vf-content-sprint/SKILL.md`

Routine concept/Hook/shot ordering/edit/caption/cover/QA/slot choices are autonomous. Ordinary quality failures are repaired internally.

Escalate only: physical footage/staging, unclear rights/privacy/private CAD, unsupported high-stakes claim, ₪/spend/Boost, customer WhatsApp/commercial commitment, Print from HQ, irreversible destructive action, or hard blocker after failover.

Routine publish is allowed only when all configured gates pass and a real Instagram publish tool is available; receipt + live verification are mandatory.

## MEMORY (from Core)

Shared owner memory lives in Core, not duplicated in the frontend repo:

- `vendor/velvetos-core/packages/vfops/data/owner-memory.md`
- `vendor/velvetos-core/packages/vfops/data/ARTIFACT-INDEX.md` — how outputs aggregate
- Checkpoints: `vendor/velvetos-core/packages/vfharness/state/`

Morning brief reads block `05a` from owner-memory after `attach-core.sh`.

Revenue loop: `vendor/velvetos-core/.cursor/skills/vf-revenue-loop/SKILL.md` · weekly `WEEKLY-REVENUE-PULSE.md`.

## ATTACH CORE

```bash
./scripts/attach-core.sh
```

**Cloud Agent:** `.cursor/environment.json` runs `install` → attach-core on every boot. No manual step. An online attach runs `scripts/verify-core.sh focused` (fail-closed); offline/stale attach keeps the existing vendor and says so — run `scripts/verify-core.sh` once back online.

## MODULES

Enabled set is in `instance/velvet-factory.json` → `modulesEnabled` (preset `maker-print`).

## Publication-prep execution gate

For Velvet Factory requests that mean prepare/treat/edit content for a potential publication, `packages/vfom/PUBLICATION-PREP-EXECUTION.md` is mandatory. This is an execution task: when usable images and an editing capability exist, selection/caption/planning alone is incomplete. Produce at least one real edited visual artifact, preserve Product Truth, run exact-final visual QA, and only then package copy for owner review. If visual execution is unavailable, fail closed as `visual_execution_unavailable`; never claim ready from raw photos plus copy. Resolve public CTA from current authority; never hardcode the business WhatsApp number into public content from memory.

## BRAND ASSET + PUBLIC CTA LOCK — ALWAYS REQUIRED

For every Velvet Factory public creative, load `vendor/velvetos-core/packages/vfom/BRAND-ASSET-LOCK.md`. Never invent, redraw, approximate or ask a generative model to render a Velvet Factory logo/wordmark/emblem or logo-like brand lockup. Generative base frames/prompts must explicitly contain **NO LOGO · NO WORDMARK · NO PHONE NUMBER · NO WHATSAPP · NO CONTACT BAR**. If no exact owner-approved logo asset is available to the job, use no logo; if one is available, composite that exact asset deterministically after generation/editing. Public CTA must resolve from `constitution/PUBLIC_CTA.md`. `050-2517000` remains BUSINESS_CONTACT_RECORD only and is forbidden in public creative/caption unless Christian explicitly requests that exact public use in the current task. Missing brand lock fails closed.

## CREATIVE TRANSFORMATION LOCK — ALWAYS REQUIRED

For publication-prep, load `vendor/velvetos-core/packages/vfom/CREATIVE-TRANSFORMATION-LOCK.md`. Preserve the real product but materially transform its presentation; do not pass through raw/source photos as the finished creative. At least one review visual — normally the hero/first slide — must show a meaningful approved Velvet treatment around the source-locked product. Default to editing the real source image/reference, not recreating the product from text. Raw-photo/resize-only/crop+exposure-only carousel fallback is forbidden. Multiple source photos do not imply a carousel. If a carousel is chosen, slide 1 must be a fully treated hero at the approved Velvet quality bar. `raw_passthrough=true`, an essentially untouched source carousel, or crop/exposure-only work presented as publication-grade is FAIL. Require `creative_delta_gate=PASS`, `raw_passthrough=false`, source-grounded edit mode and concrete hero transformation evidence. Generative edits must explicitly contain NO LOGO, NO WORDMARK, NO PHONE NUMBER, NO WHATSAPP, NO CONTACT BAR, NO GENERATED HEBREW TEXT.

## UNIVERSAL PROJECT REQUEST GATE — ALWAYS REQUIRED

Before substantive work on **any** Velvet Factory request, load `packages/velvetos/PROJECT-REQUEST-GATE.md` and resolve `packages/velvetos/PROJECT-AUTHORITY-MANIFEST.json` from attached Core (`vendor/velvetos-core/packages/velvetos/PROJECT-REQUEST-GATE.md`, `vendor/velvetos-core/packages/velvetos/PROJECT-AUTHORITY-MANIFEST.json`). Classify the request, load only the routed Constitution/domain authorities, relevant skills and Sources of Truth, resolve hard gates and require `project_preflight: PASS` before execution. Missing/stale/conflicting mandatory authority fails closed; never use generic model defaults or an older chat as a substitute. After execution, run the routed domain postflight on the exact final artifact/provider result; exact-final/action postflight is required before any done/ready/published/synced claim.

## OFFERING SHAPE — ALWAYS REQUIRED

Public offering authority: `vendor/velvetos-core/packages/vfbiz/OFFERING.md`. Velvet Factory exposes two clear tracks only: ready products and custom 3D print/model work. Customer type and quantity are job attributes, never a standalone service category. Missing offering authority fails closed.


## TOOL AUTHORITY

Executable tool status is governed by `vendor/velvetos-core/packages/velvetos/TOOL-STATUS.json`. Historical provider references do not reactivate frozen/forbidden tools.
