#!/usr/bin/env python3
"""Verify Velvet Factory frontend cold-start visual-standard bootstrap."""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULE = ROOT / ".cursor" / "rules" / "velvetos-instance-desk.mdc"
DESK = ROOT / ".cursor" / "vf-desk.json"
INSTANCE = ROOT / "instance" / "velvet-factory.json"
CORE = ROOT / "vendor" / "velvetos-core"
STD = "packages/vfom/OWNER-APPROVED-GRID-STANDARD-2026-09-14.md"
PROMPT = "packages/vfom/VELVET-VISUAL-SYSTEM-PROMPT.md"
BRAND = "packages/vfom/BRAND-ASSET-LOCK.md"
TRANSFORM = "packages/vfom/CREATIVE-TRANSFORMATION-LOCK.md"
PROJECT_GATE = "packages/velvetos/PROJECT-REQUEST-GATE.md"
PROJECT_MANIFEST = "packages/velvetos/PROJECT-AUTHORITY-MANIFEST.json"
REF = "packages/vfom/reference/velvet-approved-grid-2026-09-14.jpg"
PUBLIC = "https://raw.githubusercontent.com/nocturney/velvetos-core/main/packages/vfom/reference/velvet-approved-grid-2026-09-14.jpg"
ASSET = "MAHVL7PKpvE"
SHA = "df41281b44e2c1ac99a1cb0c9f084ec926c30774f61468fc8988f59c5a136897"

def fail(message: str) -> None:
    print(f"FAIL instance visual bootstrap: {message}", file=sys.stderr)
    raise SystemExit(1)
def load(path: Path) -> dict:
    if not path.is_file():
        fail(f"missing {path.relative_to(ROOT)}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON {path.relative_to(ROOT)}: {exc}")
    if not isinstance(data, dict):
        fail(f"{path.relative_to(ROOT)} must be a JSON object")
    return data

def main() -> None:
    if not RULE.is_file():
        fail("missing always-on rule")
    rule = RULE.read_text(encoding="utf-8")
    for needle in ("alwaysApply: true", "OWNER-APPROVED-GRID-STANDARD-2026-09-14.md", "BRAND-ASSET-LOCK.md", "CREATIVE-TRANSFORMATION-LOCK.md", "PROJECT-REQUEST-GATE.md", "PROJECT-AUTHORITY-MANIFEST.json", ASSET, SHA, "cold-start"):
        if needle.lower() not in rule.lower():
            fail(f"always-on rule missing {needle}")
    desk = load(DESK)
    if desk.get("alwaysOnRule") != ".cursor/rules/velvetos-instance-desk.mdc":
        fail("vf-desk alwaysOnRule does not point to canonical rule")
    desk_std = desk.get("ownerApprovedVisualStandard") or {}
    expected_desk = {
        "required": True,
        "document": f"vendor/velvetos-core/{STD}",
        "portablePrompt": f"vendor/velvetos-core/{PROMPT}",
        "referenceAsset": f"vendor/velvetos-core/{REF}",
        "publicReferenceUrl": PUBLIC,
        "canvaAssetId": ASSET,
        "artifactSha256": SHA,
        "coldStartGate": "fail_closed",
    }
    for key, expected in expected_desk.items():
        if desk_std.get(key) != expected:
            fail(f"vf-desk ownerApprovedVisualStandard.{key} mismatch")
    instance = load(INSTANCE)
    autonomy = instance.get("creativeAutonomy") or {}
    inst_std = autonomy.get("ownerApprovedVisualStandard") or {}
    expected_instance = {
        "required": True, "status": "approved", "document": STD,
        "portablePrompt": PROMPT, "referenceAsset": REF,
        "publicReferenceUrl": PUBLIC, "canvaAssetId": ASSET,
        "artifactSha256": SHA, "coldStartGate": "fail_closed",
    }
    for key, expected in expected_instance.items():
        if inst_std.get(key) != expected:
            fail(f"instance ownerApprovedVisualStandard.{key} mismatch")
    if (autonomy.get("publish") or {}).get("requireOwnerApprovedVisualStandard") is not True:
        fail("instance publish gate does not require owner visual standard")
    brand = desk.get("brandAssetLock") or {}
    if brand.get("required") is not True or brand.get("document") != f"vendor/velvetos-core/{BRAND}" or brand.get("mode") != "fail_closed":
        fail("vf-desk brandAssetLock mismatch")
    inst_brand = autonomy.get("brandAssetLock") or {}
    if inst_brand.get("required") is not True or inst_brand.get("document") != BRAND or inst_brand.get("mode") != "fail_closed":
        fail("instance brandAssetLock mismatch")
    if inst_brand.get("generatedBrandMark") != "forbidden" or inst_brand.get("publicPhoneForbidden") is not True:
        fail("instance brand asset/public-phone lock not strict")
    if (autonomy.get("publish") or {}).get("requireBrandAssetLock") is not True:
        fail("instance publish gate does not require brand asset lock")
    transform = desk.get("creativeTransformationLock") or {}
    if transform.get("required") is not True or transform.get("document") != f"vendor/velvetos-core/{TRANSFORM}" or transform.get("mode") != "fail_closed":
        fail("vf-desk creativeTransformationLock mismatch")
    if transform.get("rawPassthrough") is not False or transform.get("defaultEditMode") != "SOURCE_IMAGE_EDIT" or transform.get("heroTreatmentRequired") is not True:
        fail("vf-desk creative transformation lock not strict")
    inst_transform = autonomy.get("creativeTransformationLock") or {}
    if inst_transform.get("required") is not True or inst_transform.get("document") != TRANSFORM or inst_transform.get("mode") != "fail_closed":
        fail("instance creativeTransformationLock mismatch")
    if inst_transform.get("rawPassthrough") is not False or inst_transform.get("defaultEditMode") != "SOURCE_IMAGE_EDIT" or inst_transform.get("heroTreatmentRequired") is not True:
        fail("instance creative transformation lock not strict")
    if (autonomy.get("publish") or {}).get("requireCreativeTransformationLock") is not True:
        fail("instance publish gate does not require creative transformation lock")
    project_gate = desk.get("projectRequestGate") or {}
    if project_gate.get("required") is not True or project_gate.get("document") != f"vendor/velvetos-core/{PROJECT_GATE}" or project_gate.get("manifest") != f"vendor/velvetos-core/{PROJECT_MANIFEST}" or project_gate.get("mode") != "fail_closed" or project_gate.get("requirePreflightPass") is not True:
        fail("vf-desk projectRequestGate mismatch")
    inst_gate = autonomy.get("projectRequestGate") or {}
    if inst_gate.get("required") is not True or inst_gate.get("document") != PROJECT_GATE or inst_gate.get("manifest") != PROJECT_MANIFEST or inst_gate.get("mode") != "fail_closed":
        fail("instance projectRequestGate mismatch")
    if (autonomy.get("publish") or {}).get("requireProjectRequestGate") is not True:
        fail("instance publish gate does not require project request gate")
    for rel in (STD, PROMPT, BRAND, TRANSFORM, PROJECT_GATE, PROJECT_MANIFEST, REF, "scripts/check-visual-standard-bootstrap.py", "scripts/check-brand-asset-cta-lock.py", "scripts/check-creative-transformation-lock.py", "scripts/check-project-request-gate.py"):
        if not (CORE / rel).is_file():
            fail(f"attached Core missing {rel}")
    print("OK instance cold-start visual standard bootstrap bound + Core assets present")

if __name__ == "__main__":
    main()
