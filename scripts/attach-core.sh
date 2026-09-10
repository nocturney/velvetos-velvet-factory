#!/usr/bin/env bash
# Attach VelvetOS Core into vendor/velvetos-core and verify the attached runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_REMOTE="${VELVETOS_CORE_REMOTE:-https://github.com/nocturney/velvetos-core.git}"
CORE_REF="${VELVETOS_CORE_REF:-main}"
DEST="$ROOT/vendor/velvetos-core"

mkdir -p "$ROOT/vendor"

if [[ -d "$DEST/.git" ]]; then
  git -C "$DEST" fetch origin "$CORE_REF"
  git -C "$DEST" checkout "$CORE_REF"
  git -C "$DEST" pull --ff-only origin "$CORE_REF"
  echo "OK updated $DEST @ $CORE_REF"
else
  git clone --depth 1 --branch "$CORE_REF" "$CORE_REMOTE" "$DEST"
  echo "OK cloned VelvetOS Core -> $DEST"
fi

bash "$ROOT/scripts/verify-core.sh" focused
