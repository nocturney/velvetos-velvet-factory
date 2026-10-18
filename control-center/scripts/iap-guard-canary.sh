#!/usr/bin/env bash
# IAP guard canary for Portal staging: a tagged, 0%-traffic revision with
# VELVETOS_REQUIRE_IAP=1, the exact IAP audience and an HTTP liveness probe on /liveness.
#
# Safety contract:
#   * Default is DRY-RUN: commands are printed, nothing is changed.
#   * Only `deploy --apply` and `rollback --apply` change anything, and only with
#     CANARY_CONFIRM=deploy-no-traffic / CANARY_CONFIRM=remove-tag in the environment.
#   * This script NEVER changes traffic percentages. Every deploy uses --no-traffic;
#     promotion and full rollback are printed as manual, separately reviewed commands.
#   * No secrets are printed: env vars are listed by NAME only; secret refs are not resolved.
#
# Usage:
#   iap-guard-canary.sh plan      [options]   # default: print the full runbook
#   iap-guard-canary.sh preflight [options]   # read-only gcloud facts (names only)
#   iap-guard-canary.sh deploy    [options] [--apply]
#   iap-guard-canary.sh verify    [options]   # anonymous checks against the tag URL
#   iap-guard-canary.sh rollback  [options] [--apply]
#
# Options:
#   --project ID        (default instamcp)
#   --region REGION     (default me-west1)
#   --service NAME      (default velvetos-control-center-staging)
#   --tag TAG           (default iapcanary)
#   --image REF         image pinned by digest, e.g. gcr.io/instamcp/velvetos-control-center@sha256:<64 hex>
#   --audience AUD      exact IAP audience: /projects/<NUMBER>/locations/<REGION>/services/<SERVICE>
#   --allowed-emails L  optional comma-separated allowlist (lowercase emails)
#   --tag-url URL       optional explicit tag URL for verify (otherwise read from gcloud)
#   --apply             actually run (deploy/rollback only)
set -euo pipefail

PROJECT="instamcp"
REGION="me-west1"
SERVICE="velvetos-control-center-staging"
TAG="iapcanary"
IMAGE=""
AUDIENCE=""
ALLOWED_EMAILS=""
TAG_URL=""
APPLY=0
CMD="${1:-plan}"
if [[ $# -gt 0 ]]; then shift; fi
if [[ "$CMD" == "-h" || "$CMD" == "--help" ]]; then awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0; fi

die() { echo "ERROR: $*" >&2; exit 2; }
note() { echo "# $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --audience) AUDIENCE="${2:-}"; shift 2 ;;
    --allowed-emails) ALLOWED_EMAILS="${2:-}"; shift 2 ;;
    --tag-url) TAG_URL="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "invalid --project"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || die "invalid --region"
[[ "$SERVICE" =~ ^[a-z][a-z0-9-]{0,48}[a-z0-9]$ ]] || die "invalid --service"
[[ "$TAG" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || die "invalid --tag"
[[ "$TAG" != "latest" ]] || die "--tag latest is not allowed"

AUD_RE="^/projects/[0-9]+/locations/${REGION}/services/${SERVICE}\$"
IMG_RE='^[a-z0-9.-]+(/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$'
EMAIL_RE='^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'

check_inputs() {
  [[ -n "$IMAGE" ]] || die "--image is required (pinned by digest)"
  [[ "$IMAGE" =~ $IMG_RE ]] || die "--image must be pinned by @sha256 digest"
  [[ -n "$AUDIENCE" ]] || die "--audience is required (observed or read from preflight, never invented)"
  [[ "$AUDIENCE" =~ $AUD_RE ]] || die "--audience must be /projects/<NUMBER>/locations/${REGION}/services/${SERVICE}"
  if [[ -n "$ALLOWED_EMAILS" ]]; then
    local e
    IFS=',' read -r -a _emails <<< "$ALLOWED_EMAILS"
    for e in "${_emails[@]}"; do [[ "$e" =~ $EMAIL_RE ]] || die "invalid email in --allowed-emails"; done
  fi
}

need_gcloud() { command -v gcloud >/dev/null 2>&1 || die "gcloud not found"; }

GC=(--project "$PROJECT" --region "$REGION")

deploy_cmd() {
  local env="^;^VELVETOS_REQUIRE_IAP=1;VELVETOS_IAP_AUDIENCE=${AUDIENCE}"
  [[ -z "$ALLOWED_EMAILS" ]] || env="${env};VELVETOS_IAP_ALLOWED_EMAILS=${ALLOWED_EMAILS}"
  DEPLOY=(gcloud run deploy "$SERVICE" "${GC[@]}"
    --image "$IMAGE"
    --no-traffic
    --tag "$TAG"
    "--update-env-vars=${env}"
    "--liveness-probe=httpGet.path=/liveness,periodSeconds=30,timeoutSeconds=3,failureThreshold=3"
    --quiet)
  # Hard invariants: never route traffic, never open the service.
  local a joined=" ${DEPLOY[*]} "
  [[ "$joined" == *" --no-traffic "* ]] || die "internal: --no-traffic missing"
  for a in "${DEPLOY[@]}"; do
    case "$a" in
      --to-latest|--to-revisions*|--to-tags*|--allow-unauthenticated|--no-iap|--no-invoker-iam-check|--ingress*)
        die "internal: forbidden flag $a" ;;
    esac
  done
}

print_cmd() { printf '  '; printf '%q ' "$@"; printf '\n'; }

rollback_tag_cmd() { ROLLBACK=(gcloud run services update-traffic "$SERVICE" "${GC[@]}" --remove-tags "$TAG" --quiet); }

cmd_preflight() {
  need_gcloud
  note "gcloud accounts (no tokens):"
  gcloud auth list --format="value(account,status)"
  local num
  num="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  note "expected IAP audience (direct Cloud Run IAP): /projects/${num}/locations/${REGION}/services/${SERVICE}"
  note "cross-check it against an authorized IAP assertion or the console 'Signed Header JWT Audience' before use"
  gcloud run services describe "$SERVICE" "${GC[@]}" --format=json | python3 -c '
import json, sys
s = json.load(sys.stdin)
meta, spec, st = s["metadata"], s["spec"], s.get("status", {})
ann = meta.get("annotations", {})
tmpl = spec["template"]
c = tmpl["spec"]["containers"][0]
print("# url:", st.get("url"))
print("# latestReadyRevision:", st.get("latestReadyRevisionName"))
print("# latestCreatedRevision:", st.get("latestCreatedRevisionName"))
print("# iap annotation:", ann.get("run.googleapis.com/iap-enabled", "(absent)"))
print("# ingress:", ann.get("run.googleapis.com/ingress", "(default)"))
print("# image:", c.get("image"))
print("# env names:", sorted(e["name"] + ("(secret)" if "valueFrom" in e else "") for e in c.get("env", [])))
print("# startupProbe:", json.dumps(c.get("startupProbe")))
print("# livenessProbe:", json.dumps(c.get("livenessProbe")))
for t in st.get("traffic", []):
    print("# traffic:", t.get("percent", 0), "%", t.get("revisionName") or ("LATEST" if t.get("latestRevision") else "?"),
          ("tag=" + t["tag"]) if t.get("tag") else "", t.get("url", ""))
'
  note "invoker bindings (principals only):"
  gcloud run services get-iam-policy "$SERVICE" "${GC[@]}" --format=json |
    python3 -c 'import json,sys; p=json.load(sys.stdin); [print("#", b["role"], b.get("members")) for b in p.get("bindings", [])]'
}

cmd_deploy() {
  check_inputs
  deploy_cmd
  if [[ "$APPLY" -ne 1 ]]; then
    note "DRY-RUN (add --apply and CANARY_CONFIRM=deploy-no-traffic to execute):"
    print_cmd "${DEPLOY[@]}"
    return 0
  fi
  [[ "${CANARY_CONFIRM:-}" == "deploy-no-traffic" ]] || die "set CANARY_CONFIRM=deploy-no-traffic to apply"
  need_gcloud
  note "traffic BEFORE:"
  gcloud run services describe "$SERVICE" "${GC[@]}" --format='value(status.traffic)'
  "${DEPLOY[@]}"
  note "traffic AFTER (percentages must be unchanged; new revision 0% with tag ${TAG}):"
  gcloud run services describe "$SERVICE" "${GC[@]}" --format='value(status.traffic)'
}

expect_denied() { # anonymous request must be refused by IAP (302 to Google sign-in, or 401/403)
  local path="$1" out code loc
  out="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code} %{redirect_url}' "${TAG_URL}${path}" || true)"
  code="${out%% *}"; loc="${out#* }"
  if [[ "$code" == "401" || "$code" == "403" ]]; then echo "PASS anonymous ${path} -> ${code}"; return 0; fi
  if [[ "$code" == "302" && "$loc" == https://accounts.google.com/* ]]; then echo "PASS anonymous ${path} -> 302 Google sign-in"; return 0; fi
  echo "FAIL anonymous ${path} -> ${code} ${loc%%\?*}"; return 1
}

cmd_verify() {
  if [[ -z "$TAG_URL" ]]; then
    need_gcloud
    TAG_URL="$(gcloud run services describe "$SERVICE" "${GC[@]}" --format=json |
      python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin)["status"].get("traffic",[]) if x.get("tag")==sys.argv[1]]; print(t[0]["url"] if t else "")' "$TAG")"
  fi
  [[ "$TAG_URL" =~ ^https://${TAG}---[a-z0-9.-]+\.run\.app$ ]] || die "tag URL not found or not a ${TAG}--- run.app URL"
  local fail=0
  for p in / /health /liveness /api/control/v1/snapshot; do expect_denied "$p" || fail=1; done
  if command -v gcloud >/dev/null 2>&1; then
    local rev
    rev="$(gcloud run services describe "$SERVICE" "${GC[@]}" --format=json |
      python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin)["status"].get("traffic",[]) if x.get("tag")==sys.argv[1]]; print(t[0].get("revisionName","") if t else ""); [print("TRAFFIC_NOT_ZERO", file=sys.stderr) for x in t if x.get("percent",0)]' "$TAG")"
    note "canary revision: ${rev}"
    gcloud run revisions describe "$rev" "${GC[@]}" --format='value(status.conditions)'
    note "recent canary logs mentioning the guard (no request bodies):"
    gcloud logging read "resource.type=cloud_run_revision AND resource.labels.revision_name=${rev} AND (textPayload:iap_ OR severity>=ERROR)" \
      --project "$PROJECT" --limit 20 --freshness 1h --format='value(timestamp,severity,textPayload)' || true
  fi
  cat <<TXT
# Anonymous checks above prove IAP refuses the tag URL. They do NOT prove the guard
# accepts the owner. /liveness is answered only to Cloud Run's internal probe; the
# revision being Ready with the liveness probe configured is the evidence for it.
# OWNER STEP (Christian, Safari on iPhone and iPad, off-LAN):
#   1. Open ${TAG_URL}/ and sign in through Google/IAP -> portal loads (200), data panels render.
#   2. Open ${TAG_URL}/health -> JSON {"service":"velvetos-control-center","ready":true,...}.
#   3. In a private window without signing in -> Google sign-in, never portal content.
#   Report pass/fail per step. Any 401 {"error":"unauthorized"} after sign-in means the
#   audience or JWT path is wrong: run rollback, do not promote.
TXT
  return "$fail"
}

cmd_rollback() {
  rollback_tag_cmd
  if [[ "$APPLY" -ne 1 ]]; then
    note "DRY-RUN rollback of the canary (removes the tag URL; traffic percentages untouched):"
    print_cmd "${ROLLBACK[@]}"
  else
    [[ "${CANARY_CONFIRM:-}" == "remove-tag" ]] || die "set CANARY_CONFIRM=remove-tag to apply"
    need_gcloud
    "${ROLLBACK[@]}"
  fi
  cat <<TXT
# The 0% revision stays as history and serves nothing once the tag is removed.
# MANUAL ONLY, never run by this script: if traffic was ever moved by a separate
# reviewed action, restore it with (fill PREVIOUS_REVISION from preflight output):
#   gcloud run services update-traffic ${SERVICE} --project ${PROJECT} --region ${REGION} --to-revisions=PREVIOUS_REVISION=100
TXT
}

cmd_plan() {
  cat <<TXT
# IAP guard canary runbook: project=${PROJECT} region=${REGION} service=${SERVICE} tag=${TAG}
# Prerequisites: #62 merged (/liveness + enablement safety) and CI green on that main SHA;
#   image built from that SHA and referenced by digest; audience confirmed (preflight + console).
# 1. Read-only facts:   $0 preflight
# 2. Dry-run deploy:    $0 deploy --image <REF@sha256:...> --audience /projects/<NUMBER>/locations/${REGION}/services/${SERVICE}
# 3. Apply (0% only):   CANARY_CONFIRM=deploy-no-traffic $0 deploy ... --apply
# 4. Verify:            $0 verify     (anonymous denial + revision Ready + owner Safari steps)
# 5. Rollback:          CANARY_CONFIRM=remove-tag $0 rollback --apply
# Promotion is NOT part of this script and needs a separate reviewed gate.
TXT
  if [[ -n "$IMAGE" && -n "$AUDIENCE" ]]; then cmd_deploy; fi
  cmd_rollback
}

case "$CMD" in
  plan) cmd_plan ;;
  preflight) cmd_preflight ;;
  deploy) cmd_deploy ;;
  verify) cmd_verify ;;
  rollback) cmd_rollback ;;
  *) die "unknown command: $CMD (plan|preflight|deploy|verify|rollback)" ;;
esac
