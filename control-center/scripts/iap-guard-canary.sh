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
#   iap-guard-canary.sh verify    --audience AUD --allowed-emails L [options]   # read-only gcloud proof + anonymous checks
#   iap-guard-canary.sh rollback  [options] [--apply]
#
# Options:
#   --project ID        (default instamcp)
#   --region REGION     (default me-west1)
#   --service NAME      (default velvetos-control-center-staging)
#   --tag TAG           (default iapcanary)
#   --image REF         image pinned by digest, e.g. gcr.io/instamcp/velvetos-control-center@sha256:<64 hex>
#   --audience AUD      exact IAP audience: /projects/<NUMBER>/locations/<REGION>/services/<SERVICE>
#   --allowed-emails L  required nonempty owner allowlist (lowercase emails)
#   --tag-url URL       optional explicit tag URL for verify; must equal the service's tagged URL byte-for-byte
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
TAG_URL_RE="^https://${TAG}---[a-z0-9.-]+\.run\.app\$"

check_owner_inputs() {
  [[ -n "$AUDIENCE" ]] || die "--audience is required (observed or read from preflight, never invented)"
  [[ "$AUDIENCE" =~ $AUD_RE ]] || die "--audience must be /projects/<NUMBER>/locations/${REGION}/services/${SERVICE}"
  [[ -n "$ALLOWED_EMAILS" ]] || die "--allowed-emails is required for owner-only IAP"
  [[ "$ALLOWED_EMAILS" != ","* && "$ALLOWED_EMAILS" != *"," && "$ALLOWED_EMAILS" != *",,"* ]] || die "empty email in --allowed-emails"
  local e
  IFS=',' read -r -a _emails <<< "$ALLOWED_EMAILS"
  for e in "${_emails[@]}"; do [[ "$e" =~ $EMAIL_RE ]] || die "invalid email in --allowed-emails"; done
}

check_inputs() {
  [[ -n "$IMAGE" ]] || die "--image is required (pinned by digest)"
  [[ "$IMAGE" =~ $IMG_RE ]] || die "--image must be pinned by @sha256 digest"
  check_owner_inputs
}

need_gcloud() { command -v gcloud >/dev/null 2>&1 || die "gcloud not found"; }

GC=(--project "$PROJECT" --region "$REGION")

deploy_cmd() {
  local env="^;^VELVETOS_REQUIRE_IAP=1;VELVETOS_IAP_AUDIENCE=${AUDIENCE}"
  env="${env};VELVETOS_IAP_ALLOWED_EMAILS=${ALLOWED_EMAILS}"
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
  # Verify proves the guard from control-plane facts against explicit expectations, so the
  # audience and owner allowlist are required here too; nothing is inferred from the template.
  check_owner_inputs
  if [[ -n "$TAG_URL" ]]; then
    [[ "$TAG_URL" =~ $TAG_URL_RE ]] || die "--tag-url is not a ${TAG}--- run.app URL"
  fi
  need_gcloud
  local svc tr rev="" tag_url="" rjson fail=0 control_ok=1 url_ok=0
  if ! svc="$(gcloud run services describe "$SERVICE" "${GC[@]}" --format=json)"; then
    echo "FAIL service metadata unreadable"; return 1
  fi
  # Provider-side IAP: the service annotation must be exactly the string "true". Absent,
  # disabled or unreadable metadata fails even when anonymous requests are refused, because
  # a 401 from the app or a stale route says nothing about IAP.
  if ! printf '%s' "$svc" | python3 -c '
import json, sys
def bad(why):
    print("IAP_NOT_PROVEN " + why, file=sys.stderr)
    sys.exit(1)
try:
    s = json.load(sys.stdin)
except ValueError:
    bad("service JSON unreadable")
meta = s.get("metadata") if isinstance(s, dict) else None
ann = meta.get("annotations") if isinstance(meta, dict) else None
if not isinstance(ann, dict):
    bad("metadata.annotations missing")
if ann.get("run.googleapis.com/iap-enabled") != "true":
    bad("run.googleapis.com/iap-enabled is absent, disabled or not the string true")
'; then
    echo "FAIL service IAP annotation not proven"; fail=1; control_ok=0
  fi
  # Traffic is judged per canary REVISION, not per tagged entry: the same revision can be
  # served through an untagged entry. Missing, ambiguous or malformed traffic fails closed.
  if ! tr="$(printf '%s' "$svc" | python3 -c '
import json, sys
tag = sys.argv[1]
def unverifiable(why):
    print("TRAFFIC_UNVERIFIABLE " + why, file=sys.stderr)
    sys.exit(1)
try:
    s = json.load(sys.stdin)
except ValueError:
    unverifiable("service JSON unreadable")
st = s.get("status") if isinstance(s, dict) else None
traffic = st.get("traffic") if isinstance(st, dict) else None
if not isinstance(traffic, list) or not traffic:
    unverifiable("traffic list missing or empty")
for x in traffic:
    p = x.get("percent", 0) if isinstance(x, dict) else None
    if not isinstance(p, int) or isinstance(p, bool) or not 0 <= p <= 100:
        unverifiable("malformed percent")
tagged = [x for x in traffic if x.get("tag") == tag]
if len(tagged) != 1:
    unverifiable("expected one entry tagged " + tag + ", found " + str(len(tagged)))
rev = tagged[0].get("revisionName")
if not isinstance(rev, str) or not rev:
    unverifiable("tagged entry has no revisionName")
# Any positive share on the canary revision fails, tagged or not. An entry with no
# revisionName (latestRevision) cannot be shown to avoid the canary, so it fails too.
hot = [x for x in traffic if x.get("percent", 0) > 0 and x.get("revisionName") in (rev, None, "")]
for x in hot:
    print("TRAFFIC_NOT_ZERO", x.get("percent", 0), x.get("revisionName") or "(unresolved latest)", file=sys.stderr)
if hot:
    sys.exit(1)
print(rev)
' "$TAG")"; then
    echo "FAIL canary must hold 0% traffic (or traffic lookup failed)"; fail=1; control_ok=0
  else
    rev="$tr"
  fi
  # The service's own unique tagged entry URL is the only URL the anonymous checks may use. It must
  # match the TAG_URL shape and any explicit --tag-url byte-for-byte. A missing, duplicate, malformed
  # or mismatched URL fails closed before any curl or revision/log read.
  tag_url="$(printf '%s' "$svc" | python3 -c '
import json, sys
tag = sys.argv[1]
try:
    s = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
st = s.get("status") if isinstance(s, dict) else None
traffic = st.get("traffic") if isinstance(st, dict) else None
if not isinstance(traffic, list):
    sys.exit(0)
tagged = [x for x in traffic if isinstance(x, dict) and x.get("tag") == tag]
if len(tagged) == 1 and isinstance(tagged[0].get("url"), str):
    print(tagged[0]["url"])
' "$TAG")"
  if [[ "$tag_url" =~ $TAG_URL_RE ]]; then
    if [[ -n "$TAG_URL" && "$TAG_URL" != "$tag_url" ]]; then
      echo "FAIL --tag-url does not match the service's tagged canary URL"; fail=1; control_ok=0
    else
      TAG_URL="$tag_url"; url_ok=1
    fi
  else
    echo "FAIL tagged canary URL not found or not a ${TAG}--- run.app URL"; fail=1; control_ok=0
  fi
  if [[ "$url_ok" -eq 1 ]]; then
    for p in / /health /liveness /api/control/v1/snapshot; do expect_denied "$p" || fail=1; done
  fi
  # The ACTUAL tagged revision must carry the guard: exactly one container, Ready, one plain
  # VELVETOS_REQUIRE_IAP=1, and exact audience and allowlist. Values are compared, never printed.
  if [[ "$control_ok" -eq 1 ]]; then
    if ! rjson="$(gcloud run revisions describe "$rev" "${GC[@]}" --format=json)"; then
      echo "FAIL canary revision unreadable"; fail=1; control_ok=0
    elif ! printf '%s' "$rjson" | python3 -c '
import json, sys
aud, emails = sys.argv[1], sys.argv[2]
def bad(why):
    print("REVISION_GUARD_NOT_PROVEN " + why, file=sys.stderr)
    sys.exit(1)
try:
    r = json.load(sys.stdin)
except ValueError:
    bad("revision JSON unreadable")
st = r.get("status") if isinstance(r, dict) else None
conds = st.get("conditions") if isinstance(st, dict) else None
if not isinstance(conds, list) or not any(isinstance(c, dict) and c.get("type") == "Ready" and c.get("status") == "True" for c in conds):
    bad("Ready condition is not True")
spec = r.get("spec") if isinstance(r, dict) else None
containers = spec.get("containers") if isinstance(spec, dict) else None
if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
    bad("revision must have exactly one container")
envs = containers[0].get("env", [])
if not isinstance(envs, list) or not all(isinstance(e, dict) and isinstance(e.get("name"), str) for e in envs):
    bad("env list malformed")
names = [e["name"] for e in envs]
if len(names) != len(set(names)):
    bad("duplicate env names")
def plain(name):
    hits = [e for e in envs if e["name"] == name]
    if len(hits) != 1:
        bad(name + " missing")
    e = hits[0]
    if "valueFrom" in e or not isinstance(e.get("value"), str):
        bad(name + " is not a plain value")
    return e["value"]
if plain("VELVETOS_REQUIRE_IAP") != "1":
    bad("VELVETOS_REQUIRE_IAP is not 1")
if plain("VELVETOS_IAP_AUDIENCE") != aud:
    bad("VELVETOS_IAP_AUDIENCE does not match --audience")
if plain("VELVETOS_IAP_ALLOWED_EMAILS") != emails:
    bad("VELVETOS_IAP_ALLOWED_EMAILS does not match --allowed-emails")
' "$AUDIENCE" "$ALLOWED_EMAILS"; then
      echo "FAIL canary revision IAP guard not proven"; fail=1; control_ok=0
    else
      echo "PASS canary revision ${rev}: Ready, guard=1, audience and owner allowlist exact (values not printed)"
    fi
  fi
  # Logs are read only after every control-plane check has passed for this revision.
  if [[ "$control_ok" -eq 1 ]]; then
    note "recent canary logs mentioning the guard (no request bodies):"
    gcloud logging read "resource.type=cloud_run_revision AND resource.labels.revision_name=${rev} AND (textPayload:iap_ OR severity>=ERROR)" \
      --project "$PROJECT" --limit 20 --freshness 1h --format='value(timestamp,severity,textPayload)' || true
  fi
  cat <<TXT
# Evidence classes (report them separately):
#   CONTROL PLANE (read-only gcloud; values never printed): service IAP annotation is true,
#     canary revision Ready, VELVETOS_REQUIRE_IAP=1, exact audience and owner allowlist, 0% traffic.
#   SYNTHETIC HTTP (anonymous curl): a 401/403/302 only shows the tag URL refused an anonymous
#     request. It does not prove provider IAP by itself and it is not owner acceptance.
#   OWNER E2E (not run by this script): the Safari steps below.
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
  APPLY=0 # plan is always a dry-run, even when --apply is passed
  cat <<TXT
# IAP guard canary runbook: project=${PROJECT} region=${REGION} service=${SERVICE} tag=${TAG}
# Prerequisites: #62 merged (/liveness + enablement safety) and CI green on that main SHA;
#   image built from that SHA and referenced by digest; audience confirmed (preflight + console).
# 1. Read-only facts:   $0 preflight
# 2. Dry-run deploy:    $0 deploy --image <REF@sha256:...> --audience /projects/<NUMBER>/locations/${REGION}/services/${SERVICE} --allowed-emails <verified-owner-email>
# 3. Apply (0% only):   CANARY_CONFIRM=deploy-no-traffic $0 deploy ... --apply
# 4. Verify:            $0 verify --audience <AUDIENCE> --allowed-emails <verified-owner-email>
#                         (IAP annotation + canary revision guard + 0% traffic + anonymous denial; owner Safari steps)
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
