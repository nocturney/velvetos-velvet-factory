#!/usr/bin/env bash
# Verify that the attached VelvetOS Core is fresh and the creative system is runnable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/velvetos-core"
CORE_REF="${VELVETOS_CORE_REF:-main}"
MODE="${1:-focused}"

fail() {
  echo "FAIL core verification: $*" >&2
  exit 1
}

[[ -d "$DEST/.git" ]] || fail "missing $DEST/.git; run scripts/attach-core.sh first"

# Refresh remote tracking so freshness is evidence-based, not assumed.
git -C "$DEST" fetch origin "$CORE_REF"
LOCAL_SHA="$(git -C "$DEST" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$DEST" rev-parse "origin/$CORE_REF")"

[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || fail "stale Core: local=$LOCAL_SHA origin/$CORE_REF=$REMOTE_SHA"

required=(
  ".cursor/skills/velvet-creative-director/SKILL.md"
  ".cursor/skills/velvet-brand-guardian/SKILL.md"
  ".cursor/skills/velvet-media-librarian/SKILL.md"
  "packages/vfom/CREATIVE-MANIFEST.schema.json"
  "packages/vfom/FORMAT-GENOMES.md"
  "packages/vfom/MOTION-PRESETS.md"
  "scripts/check-creative-system.py"
  "scripts/check-creative-autopilot.py"
)

for rel in "${required[@]}"; do
  [[ -f "$DEST/$rel" ]] || fail "missing required Core file: $rel"
done

python3 "$DEST/scripts/check-creative-system.py"
python3 "$DEST/scripts/check-creative-autopilot.py"

if [[ "$MODE" == "--full" || "$MODE" == "full" ]]; then
  python3 "$DEST/scripts/check-all.py"
elif [[ "$MODE" != "focused" && "$MODE" != "--focused" ]]; then
  fail "unknown mode '$MODE' (use focused or --full)"
fi

echo "OK Core runtime verified ref=$CORE_REF sha=$LOCAL_SHA mode=$MODE"
