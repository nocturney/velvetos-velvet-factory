# AGENTS.md — VelvetOS — Velvet Factory (frontend instance)

PRODUCT: VelvetOS
ROLE: instance (frontend office)
INSTANCE: VelvetOS — Velvet Factory
CORE: vendor/velvetos-core → nocturney/velvetos-core
FORMULA: Agent = Model + Harness (from Core)

This file is the guide for this business office. Core laws still win for send / ₪ / Insights / rights.

## RULES (instance)

- Pull packs and modules from **VelvetOS Core** (`vendor/velvetos-core`). Do not duplicate the pack tree.
- Studio facts: `constitution/STUDIO.md` + `instance/velvet-factory.json`.
- Pipeline: פנייה → שיחה → הצעה → הדפסה → איסוף.
- Public CTA follows Core `PUBLIC_CURRENT_CTA`: Instagram message to `@velvets_cloud` + pickup Sderot. WhatsApp `050-2517000` is BUSINESS_CONTACT_RECORD only, not public CTA.
- Never invent ₪ or Insights. No auto-DM, Boost/Ads without lead, customer WhatsApp send, or Print from HQ.
- HQ sends Gmail and Instagram via real tools (`vendor/velvetos-core/constitution/SEND.md`); never claim a send/publish without receipt/evidence.

## OWNER-APPROVED VISUAL STANDARD

For every Instagram/feed visual workflow, read and obey Core:

- `packages/vfom/OWNER-APPROVED-GRID-STANDARD-2026-09-14.md`
- `packages/vfom/VISUAL-OS.md`
- `packages/vfom/VISUAL-DNA.json`
- `.cursor/skills/velvet-brand-guardian/SKILL.md`

Canonical approved Canva reference asset: `MAHVJjCCKQA` (`Velvet Factory · APPROVED GRID VISUAL STANDARD · 2026-09-14`).

The approved grid standard is the required visual-language and quality floor for feed posts, Reel covers, carousel pages, Story stills, service/editorial tiles and grid planning. It is **not** permission to alter real products: Product Truth, real source evidence, constitution and rights always win.

Required direction: product-first, real photography as truth anchor, `Retouch the photo, not the product`, minimal Hebrew typography, premium/non-template editorial finish, photo-first service communication, curated recipe diversity (hero / UGC-human / macro-detail / minimal-studio / bundle-flatlay / service-editorial / proof-process), coherent feed treatment and exact-final QA.

Hard rejects include placeholders presented as finals, generic icons replacing product photography, synthetic replacement/drift of a real product, fake customer/shelf scenes, stock filler, text-heavy generic template cards and rejected G004 Canva design `DAHUaelaug0` as source/style/layout/canonical edit/publish asset.

Any tool or agent that selects media, retouches, designs in Canva, builds covers/carousels/stories, plans the grid, runs Brand Guardian/QA or prepares publish preflight must apply this standard before output can PASS.

## CREATIVE AUTOPILOT

This instance enables `creativeAutonomy.mode=exception-only` with standing authorization for routine organic Instagram publishing.

Use Core:

- `packages/vfom/CREATIVE-AUTOPILOT.md`
- `packages/vfom/VISUAL-OS.md`
- `packages/vfom/EDIT-DIRECTOR.md`
- `.cursor/skills/vf-content-sprint/SKILL.md`

Routine concept/Hook/shot ordering/edit/caption/cover/QA/slot choices are autonomous. Ordinary quality failures are repaired internally.

Escalate only: physical footage/staging, unclear rights/privacy/private CAD, ₪/spend/Boost, customer WhatsApp/commercial commitment, Print from HQ, irreversible destructive action, or hard blocker after failover.

Routine publish is allowed only when all configured gates pass and a real Instagram publish tool is available; receipt + live verification are mandatory.

## MEMORY (from Core)

Shared owner memory lives in Core, not duplicated here:

- `vendor/velvetos-core/packages/vfops/data/owner-memory.md`
- `vendor/velvetos-core/packages/vfops/data/ARTIFACT-INDEX.md`
- checkpoints: `vendor/velvetos-core/packages/vfharness/state/`

## ATTACH CORE

```bash
./scripts/attach-core.sh
```

Cloud Agent `.cursor/environment.json` runs attach-core on boot. After Core catalog/rule edits run Core `python3 scripts/check-all.py`.
