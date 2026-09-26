#!/usr/bin/env bash
# Attach VelvetOS Core into vendor/velvetos-core (subtree or clone) and verify it.
# Online attach (update/clone) runs scripts/verify-core.sh focused and fails closed.
# Offline-stable: if network fails but vendor already has packs, keep going
# (stale/offline/local copies are NOT verified; the WARN says so).
#
# Env:
#   VELVETOS_CORE_REMOTE   git URL (default: https://github.com/nocturney/velvetos-core.git)
#   VELVETOS_CORE_REF      branch/tag (default: main)
#   VELVETOS_CORE_PATH     local core checkout to copy when offline / preferred
#   VELVETOS_CORE_OFFLINE=1  never hit the network; require PATH or existing vendor
#
# Flags:
#   --offline   same as VELVETOS_CORE_OFFLINE=1
#   --help
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_REMOTE="${VELVETOS_CORE_REMOTE:-https://github.com/nocturney/velvetos-core.git}"
CORE_REF="${VELVETOS_CORE_REF:-main}"
CORE_PATH="${VELVETOS_CORE_PATH:-}"
DEST="$ROOT/vendor/velvetos-core"
STAMP="$ROOT/vendor/.attach-stamp"
OFFLINE="${VELVETOS_CORE_OFFLINE:-0}"

for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --help|-h)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

mkdir -p "$ROOT/vendor"

stamp() {
  local status="$1"
  local detail="${2:-}"
  {
    echo "status=$status"
    echo "ref=$CORE_REF"
    echo "remote=$CORE_REMOTE"
    echo "dest=$DEST"
    echo "offline=$OFFLINE"
    echo "detail=$detail"
    echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"
  } >"$STAMP"
}

verify_attached() {
  # Fail-closed runtime verification after a fresh online attach.
  bash "$ROOT/scripts/verify-core.sh" focused
}

warn_unverified() {
  echo "WARN attached Core not runtime-verified ($1); run scripts/verify-core.sh when online" >&2
}

vendor_usable() {
  [[ -d "$DEST/packages" ]] && [[ -f "$DEST/AGENTS.md" || -f "$DEST/packages/velvetos/CORE.json" ]]
}

copy_from_path() {
  local src="$1"
  if [[ ! -d "$src/packages" ]]; then
    echo "FAIL VELVETOS_CORE_PATH=$src missing packages/" >&2
    return 1
  fi
  mkdir -p "$DEST"
  # Prefer rsync when present; fall back to tar to avoid partial wipe on failure.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git' \
      --exclude 'packages/vfmem/semantic_index.pkl' \
      "$src"/ "$DEST"/
  else
    local staging="$ROOT/vendor/.core-staging.$$"
    rm -rf "$staging"
    mkdir -p "$staging"
    tar -C "$src" --exclude='.git' --exclude='packages/vfmem/semantic_index.pkl' -cf - . \
      | tar -C "$staging" -xf -
    rm -rf "$DEST"
    mv "$staging" "$DEST"
  fi
  echo "OK attached local core → $DEST (from $src)"
  stamp "ok-local" "$src"
  warn_unverified "local copy from $src"
  return 0
}

attach_offline() {
  if [[ -n "$CORE_PATH" ]]; then
    copy_from_path "$CORE_PATH" && return 0
    return 1
  fi
  if vendor_usable; then
    echo "OK offline — using existing vendor $DEST (stale OK)"
    stamp "ok-stale-offline" "existing vendor"
    warn_unverified "offline"
    return 0
  fi
  echo "FAIL offline: no VELVETOS_CORE_PATH and no usable vendor at $DEST" >&2
  echo "  Set VELVETOS_CORE_PATH=/path/to/velvetos-core or run online once." >&2
  stamp "fail-offline" "missing vendor"
  return 1
}

if [[ "$OFFLINE" == "1" ]]; then
  attach_offline
  exit $?
fi

# Prefer explicit local path even when online (dev / Cloud mirror).
if [[ -n "$CORE_PATH" && -d "$CORE_PATH/packages" ]]; then
  copy_from_path "$CORE_PATH"
  exit $?
fi

if [[ -d "$DEST/.git" ]]; then
  if git -C "$DEST" fetch origin 2>/dev/null \
    && git -C "$DEST" checkout "$CORE_REF" 2>/dev/null; then
    git -C "$DEST" pull --ff-only origin "$CORE_REF" 2>/dev/null || true
    if vendor_usable; then
      echo "OK updated $DEST @ $CORE_REF"
      stamp "ok-updated" "$CORE_REF"
      verify_attached
      exit $?
    fi
  fi
  if vendor_usable; then
    echo "WARN fetch/checkout failed — keeping existing vendor $DEST" >&2
    stamp "ok-stale-network" "fetch failed"
    warn_unverified "fetch failed"
    exit 0
  fi
  echo "FAIL existing vendor unusable after network error" >&2
  stamp "fail-network" "unusable after fetch"
  exit 1
fi

if git clone --depth 1 --branch "$CORE_REF" "$CORE_REMOTE" "$DEST" 2>/dev/null; then
  echo "OK cloned VelvetOS Core → $DEST"
  echo "Next: point Cursor skills/desk pack paths at vendor/velvetos-core/packages/"
  stamp "ok-cloned" "$CORE_REF"
  verify_attached
  exit $?
fi

# Clone failed — last resorts
if [[ -n "$CORE_PATH" ]]; then
  copy_from_path "$CORE_PATH"
  exit $?
fi
if vendor_usable; then
  echo "WARN clone failed — keeping existing vendor $DEST" >&2
  stamp "ok-stale-network" "clone failed"
  warn_unverified "clone failed"
  exit 0
fi

echo "FAIL could not attach VelvetOS Core (network down, no local path, no vendor)" >&2
echo "  Retry online, or: VELVETOS_CORE_OFFLINE=1 VELVETOS_CORE_PATH=/path/to/core $0" >&2
stamp "fail-attach" "no clone no path no vendor"
exit 1
