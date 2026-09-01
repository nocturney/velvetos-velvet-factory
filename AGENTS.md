# AGENTS.md — VelvetOS — Velvet Factory (frontend instance)

PRODUCT: VelvetOS
ROLE: instance (frontend office)
INSTANCE: VelvetOS — Velvet Factory
CORE: vendor/velvetos-core → nocturney/velvetos-core
FORMULA: Agent = Model + Harness (from Core)

This file is the **guide for this business office**. Core laws still win for send / ₪ / Insights.

## RULES (instance)

- Pull packs and modules from **VelvetOS Core** (`vendor/velvetos-core`). Do not duplicate the pack tree.
- Studio facts: `constitution/STUDIO.md` + `instance/velvet-factory.json`.
- HQ sends Gmail and Instagram via tools (`vendor/velvetos-core/constitution/SEND.md`).
- Never invent ₪ or Insights. CTA: WhatsApp `050-2517000` / איסוף שדרות — not «שלחו DM».
- Pipeline: פנייה → שיחה → הצעה → הדפסה → איסוף.
- After catalog edits in core: run core `python3 scripts/check-all.py` from the core checkout / vendor.

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

**Cloud Agent:** `.cursor/environment.json` runs `install` → attach-core on every boot. No manual step.

## MODULES

Enabled set is in `instance/velvet-factory.json` → `modulesEnabled` (preset `maker-print`).
