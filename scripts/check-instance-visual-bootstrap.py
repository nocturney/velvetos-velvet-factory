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
REF = "packages/vfom/reference/velvet-approved-grid-2026-09-14.jpg"
PUBLIC = "https://raw.githubusercontent.com/nocturney/velvetos-core/main/packages/vfom/reference/velvet-approved-grid-2026-09-14.jpg"
ASSET = "MAHVJjCCKQA"
SHA = "707edde3f4d43cffea090bf90ed2418c160db2f8d90d104e4920b44697a014c0"

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
    for needle in ("alwaysApply: true", "OWNER-APPROVED-GRID-STANDARD-2026-09-14.md", ASSET, SHA, "cold-start"):
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
    for rel in (STD, PROMPT, REF, "scripts/check-visual-standard-bootstrap.py"):
        if not (CORE / rel).is_file():
            fail(f"attached Core missing {rel}")
    print("OK instance cold-start visual standard bootstrap bound + Core assets present")

if __name__ == "__main__":
    main()
