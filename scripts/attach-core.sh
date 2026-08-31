#!/usr/bin/env bash
# Attach VelvetOS Core into vendor/velvetos-core (subtree or clone).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_REMOTE="${VELVETOS_CORE_REMOTE:-https://github.com/nocturney/velvet-factory-headquarters-os.git}"
CORE_REF="${VELVETOS_CORE_REF:-main}"
DEST="$ROOT/vendor/velvetos-core"

mkdir -p "$ROOT/vendor"
if [[ -d "$DEST/.git" ]]; then
  git -C "$DEST" fetch origin
  git -C "$DEST" checkout "$CORE_REF"
  git -C "$DEST" pull --ff-only origin "$CORE_REF" || true
  echo "OK updated $DEST @ $CORE_REF"
  exit 0
fi

git clone --depth 1 --branch "$CORE_REF" "$CORE_REMOTE" "$DEST"
echo "OK cloned VelvetOS Core → $DEST"
echo "Next: point Cursor skills/desk pack paths at vendor/velvetos-core/packages/"
