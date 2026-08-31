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

## ATTACH CORE

```bash
./scripts/attach-core.sh
```

## MODULES

Enabled set is in `instance/velvet-factory.json` → `modulesEnabled` (preset `maker-print`).
