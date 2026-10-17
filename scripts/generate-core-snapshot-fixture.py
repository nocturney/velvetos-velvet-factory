#!/usr/bin/env python3
"""Generate a deterministic, zero-contribution shape fixture from current Core source.

Never connects to a live backend or serializes studio/customer data.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
DEFAULT_CORE = REPO / "vendor" / "velvetos-core"
FIXTURE = REPO / "control-center" / "fixtures" / "core-snapshot-v1.json"
CLOCK = "2000-01-01T00:00:00Z"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", type=Path, default=DEFAULT_CORE)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    source = args.core.resolve() / "packages" / "velvetos_control_api" / "snapshot.py"
    if not source.is_file():
        parser.error("Core snapshot module not found; attach Core first using --core path")
    sys.path.insert(0, str(source.parents[1]))
    from velvetos_control_api import snapshot as core_snapshot

    # Run the actual Core assembler with no contributions, no producer I/O,
    # and a frozen clock. This tests its envelope and default collection types.
    with tempfile.TemporaryDirectory(prefix="vf-core-contract-") as tmp:
        with patch.object(core_snapshot, "load_contributions", return_value=[]), \
             patch.object(core_snapshot, "now_iso", return_value=CLOCK):
            result = core_snapshot.build_snapshot(root=Path(tmp))
    if result.get("schema") != "velvetos.control.v1":
        raise SystemExit("FAIL unsupported Core snapshot schema")
    encoded = (json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode()
    if args.verify:
        if not FIXTURE.is_file() or FIXTURE.read_bytes() != encoded:
            raise SystemExit("FAIL Core snapshot envelope drift; inspect schema and regenerate deliberately")
        print("PASS Core v1 envelope verified against current Core assembler (zero real contributions)")
    else:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(encoded)
        print("WROTE synthetic Core v1 envelope fixture (no real contributions)")


if __name__ == "__main__":
    main()
