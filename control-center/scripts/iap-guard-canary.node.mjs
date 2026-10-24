// Offline contract for scripts/iap-guard-canary.sh: dry-run by default, never a
// traffic change, strict inputs. A fake gcloud records every invocation.
// Runs on macOS/Linux with system bash and on Windows with Git for Windows' bash
// (never WSL's bash.exe). Windows paths are converted to POSIX form for the shell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const SCRIPT = fileURLToPath(new URL("./iap-guard-canary.sh", import.meta.url));
const IMAGE = "gcr.io/instamcp/velvetos-control-center@sha256:" + "a".repeat(64);
const AUD = "/projects/123456789012/locations/me-west1/services/velvetos-control-center-staging";
const OWNER = "owner@example.test";

// Converts a Windows drive path (C:\Users\me or C:/Users/me) to Git Bash form (/c/Users/me).
// POSIX paths pass through unchanged.
export function toPosixPath(p) {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (!m) return p;
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

// Git for Windows only: the bash that ships with Git, never WSL's System32 bash.exe.
export function resolveGitBash() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"];
  const tried = [];
  for (const root of roots.filter(Boolean)) {
    const bash = win32.join(root, "Git", "bin", "bash.exe");
    tried.push(bash);
    if (existsSync(bash)) return bash;
  }
  throw new Error("Git Bash not found (tried " + tried.join(", ") + "). Install Git for Windows; WSL bash is intentionally not used.");
}

// Shell, PATH and script for one invocation. The POSIX PATH stays the mock path
// (bin:/usr/bin:/bin); on Windows it is the fake bin plus Git's usr/bin for the
// coreutils the script needs.
function shellLaunch(binDir) {
  if (!IS_WIN) return { shell: "bash", path: `${binDir}:/usr/bin:/bin` };
  const bash = resolveGitBash();
  const usrBin = win32.resolve(bash, "..", "..", "usr", "bin");
  if (!existsSync(usrBin)) throw new Error("Git usr/bin not found at " + usrBin);
  return { shell: bash, path: [toPosixPath(binDir), toPosixPath(usrBin)].join(":") };
}

function childEnv(path, extra, env) {
  // Git Bash on Windows needs only OS/temp paths; never inherit unrelated host
  // credentials, user tokens, CANARY_CONFIRM or the real gcloud PATH.
  const base = {};
  if (IS_WIN) for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "COMSPEC"]) {
    if (process.env[key]) base[key] = process.env[key];
  }
  return { ...base, PATH: path, ...extra, ...env };
}

function run(args, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "fake-gcloud-"));
  try {
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "gcloud"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"\necho '{}'\n`);
    chmodSync(join(bin, "gcloud"), 0o755);
    const { shell, path } = shellLaunch(bin);
    // Git for Windows with core.autocrlf=true checks the .sh out with CRLF, which bash
    // rejects (`pipefail\r`). Only then run an LF copy of the same bytes from the temp dir.
    let script = SCRIPT;
    const src = readFileSync(SCRIPT, "utf8");
    if (src.includes("\r\n")) {
      script = join(bin, "iap-guard-canary.lf.sh");
      writeFileSync(script, src.replace(/\r\n/g, "\n"));
    }
    const r = spawnSync(shell, [toPosixPath(script), ...args], {
      encoding: "utf8",
      env: childEnv(path, { FAKE_GCLOUD_LOG: toPosixPath(log) }, env),
      timeout: 30_000,
    });
    if (r.error) throw new Error("failed to start " + shell + ": " + r.error.message);
    if (r.status === null) throw new Error(`${shell} ended without an exit status (signal ${r.signal}): ${r.stdout}${r.stderr}`);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { status: r.status, out: r.stdout + r.stderr, calls };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("path conversion maps drive paths to Git Bash form and leaves POSIX paths alone", () => {
  assert.equal(toPosixPath("C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\fake-gcloud-1"),
    "/c/Users/Ada Lovelace/AppData/Local/Temp/fake-gcloud-1");
  assert.equal(toPosixPath("D:/a/b"), "/d/a/b");
  assert.equal(toPosixPath("/tmp/fake-gcloud-1"), "/tmp/fake-gcloud-1");
});

test("plan and deploy are dry-run by default and never call gcloud", () => {
  const plan = run(["plan", "--image", IMAGE, "--audience", AUD, "--allowed-emails", OWNER]);
  assert.equal(plan.status, 0, plan.out);
  assert.deepEqual(plan.calls, []);
  const dry = run(["deploy", "--image", IMAGE, "--audience", AUD, "--allowed-emails", "owner@example.test"]);
  assert.equal(dry.status, 0, dry.out);
  assert.deepEqual(dry.calls, []);
  assert.match(dry.out, /DRY-RUN/);
  for (const piece of ["--no-traffic", "--tag iapcanary", "VELVETOS_REQUIRE_IAP=1", AUD,
    "httpGet.path=/liveness", "velvetos-control-center-staging", "me-west1", "instamcp"])
    assert.ok(dry.out.includes(piece), "missing " + piece);
  const rb = run(["rollback"]);
  assert.equal(rb.status, 0);
  assert.deepEqual(rb.calls, []);
  assert.match(rb.out, /--remove-tags iapcanary/);
});

test("apply requires explicit confirmation and only ever deploys with --no-traffic", () => {
  const noConfirm = run(["deploy", "--image", IMAGE, "--audience", AUD, "--allowed-emails", OWNER, "--apply"]);
  assert.notEqual(noConfirm.status, 0);
  assert.deepEqual(noConfirm.calls, []);
  const applied = run(["deploy", "--image", IMAGE, "--audience", AUD, "--allowed-emails", OWNER, "--apply"], { CANARY_CONFIRM: "deploy-no-traffic" });
  assert.equal(applied.status, 0, applied.out);
  const deploys = applied.calls.filter((c) => c.startsWith("run deploy"));
  assert.equal(deploys.length, 1);
  assert.match(deploys[0], /--no-traffic/);
  for (const call of applied.calls) {
    assert.doesNotMatch(call, /--to-latest|--to-revisions|--to-tags|--allow-unauthenticated|--no-iap|update-traffic/,
      "traffic or exposure change: " + call);
  }
  const rbNoConfirm = run(["rollback", "--apply"]);
  assert.notEqual(rbNoConfirm.status, 0);
  const rb = run(["rollback", "--apply"], { CANARY_CONFIRM: "remove-tag" });
  assert.equal(rb.status, 0);
  assert.deepEqual(rb.calls.map((c) => c.replace(/ --quiet$/, "")),
    ["run services update-traffic velvetos-control-center-staging --project instamcp --region me-west1 --remove-tags iapcanary"]);
});

test("inputs are strict: digest-pinned image, exact audience, valid emails and tag", () => {
  const bad = [
    ["--image", "gcr.io/instamcp/velvetos-control-center:latest", "--audience", AUD],
    ["--image", IMAGE, "--audience", "/projects/123/locations/me-west1/services/other-service"],
    ["--image", IMAGE, "--audience", "/projects/123/global/backendServices/9"],
    ["--image", IMAGE],
    ["--image", IMAGE, "--audience", AUD], // no owner is unsafe even at 0% traffic
    ["--image", IMAGE, "--audience", AUD, "--allowed-emails", "not-an-email"],
    ["--image", IMAGE, "--audience", AUD, "--allowed-emails", "owner@example.test,"],
    ["--image", IMAGE, "--audience", AUD, "--allowed-emails", ",owner@example.test"],
    ["--image", IMAGE, "--audience", AUD, "--tag", "latest"],
    ["--image", IMAGE, "--audience", AUD, "--region", "me-west1;rm"],
  ];
  for (const args of bad) {
    const r = run(["deploy", ...args, "--apply"], { CANARY_CONFIRM: "deploy-no-traffic" });
    assert.notEqual(r.status, 0, "accepted: " + args.join(" "));
    assert.deepEqual(r.calls, [], "gcloud called for invalid input: " + args.join(" "));
  }
  assert.notEqual(run(["promote"]).status, 0, "unknown command accepted");
  console.log("CANARY_SCRIPT_PASS dry_run_default_no_traffic_strict_inputs");
});

// Regression harness, independent of run() above: a fake gcloud answers `run services
// describe` and `run revisions describe` with the synthetic JSON given by the test, and a fake
// curl prints a fixed "<http_code> <redirect_url>". Nothing real runs: no gcloud, no curl, no network.
const TAG_URL = "https://iapcanary---velvetos-control-center-staging-123456.me-west1.run.app";
const VERIFY_ARGS = ["verify", "--tag-url", TAG_URL, "--audience", AUD, "--allowed-emails", OWNER];

function runCanary(args, { env = {}, serviceJson = "{}", curlOut = "", revisionJson = canaryRevisionJson(), revisionFail = false } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "fake-canary-"));
  try {
    const log = join(bin, "calls.log");
    const svc = join(bin, "service.json");
    const rev = join(bin, "revision.json");
    writeFileSync(svc, serviceJson);
    writeFileSync(rev, revisionJson);
    writeFileSync(join(bin, "gcloud"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"`,
      'if [[ "$*" == *"services describe"* ]]; then cat "$FAKE_SERVICE_JSON"; exit 0; fi',
      'if [[ "$*" == *"revisions describe"* ]]; then',
      '  if [[ "$FAKE_REVISION_FAIL" == 1 ]]; then echo "ERROR: revision lookup failed" >&2; exit 1; fi',
      '  cat "$FAKE_REVISION_JSON"; exit 0',
      "fi",
      "echo '{}'",
      "",
    ].join("\n"));
    writeFileSync(join(bin, "curl"), [
      "#!/usr/bin/env bash",
      `printf 'curl %s\\n' "$*" >> "$FAKE_GCLOUD_LOG"`,
      'printf \'%s\' "$FAKE_CURL_OUT"',
      "",
    ].join("\n"));
    chmodSync(join(bin, "gcloud"), 0o755);
    chmodSync(join(bin, "curl"), 0o755);
    const { shell, path } = shellLaunch(bin);
    let script = SCRIPT;
    const src = readFileSync(SCRIPT, "utf8");
    if (src.includes("\r\n")) {
      script = join(bin, "iap-guard-canary.lf.sh");
      writeFileSync(script, src.replace(/\r\n/g, "\n"));
    }
    const r = spawnSync(shell, [toPosixPath(script), ...args], {
      encoding: "utf8",
      env: childEnv(path, {
        FAKE_GCLOUD_LOG: toPosixPath(log),
        FAKE_SERVICE_JSON: toPosixPath(svc),
        FAKE_REVISION_JSON: toPosixPath(rev),
        FAKE_REVISION_FAIL: revisionFail ? "1" : "0",
        FAKE_CURL_OUT: curlOut,
      }, env),
      timeout: 30_000,
    });
    if (r.error) throw new Error("failed to start " + shell + ": " + r.error.message);
    if (r.status === null) throw new Error(`${shell} ended without an exit status (signal ${r.signal}): ${r.stdout}${r.stderr}`);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { status: r.status, out: r.stdout + r.stderr, calls };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

const STABLE = "velvetos-control-center-staging-00001-stable";
const CANARY = "velvetos-control-center-staging-00002-canary";

const IAP_ON = { "run.googleapis.com/iap-enabled": "true" };

// Synthetic Cloud Run service JSON with an explicit status.traffic list (null = absent).
function serviceJsonWithTraffic(traffic, annotations = IAP_ON) {
  return JSON.stringify({
    metadata: { annotations },
    spec: { template: { spec: { containers: [{ image: IMAGE, env: [{ name: "VELVETOS_REQUIRE_IAP" }] }] } } },
    status: {
      url: "https://velvetos-control-center-staging-123456.me-west1.run.app",
      latestReadyRevisionName: CANARY,
      latestCreatedRevisionName: CANARY,
      traffic,
    },
  });
}

// Synthetic Cloud Run service JSON: the tagged canary holds `percent` of traffic.
function serviceJson(percent) {
  return serviceJsonWithTraffic([
    { percent: 100 - percent, revisionName: STABLE },
    { percent, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
  ]);
}

// Synthetic env of the tagged canary revision. An override set to undefined drops that name.
function guardEnv(overrides = {}) {
  const base = { VELVETOS_REQUIRE_IAP: "1", VELVETOS_IAP_AUDIENCE: AUD, VELVETOS_IAP_ALLOWED_EMAILS: OWNER };
  return Object.entries({ ...base, ...overrides })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value }));
}

// Synthetic Knative-style revision JSON, as `gcloud run revisions describe --format=json` shapes it.
function canaryRevisionJson({ env = guardEnv(), ready = "True", containers } = {}) {
  return JSON.stringify({
    metadata: { name: CANARY },
    spec: { containers: containers ?? [{ image: IMAGE, env }] },
    status: { conditions: [{ type: "Ready", status: ready }] },
  });
}

const DENIED_GOOGLE = "302 https://accounts.google.com/o/oauth2/v2/auth?client_id=test";

test("plan --apply is always a dry-run and never calls gcloud deploy or rollback", () => {
  for (const confirm of ["deploy-no-traffic", "remove-tag"]) {
    const r = runCanary(["plan", "--image", IMAGE, "--audience", AUD, "--allowed-emails", OWNER, "--apply"],
      { env: { CANARY_CONFIRM: confirm } });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, [], "gcloud called by plan --apply with CANARY_CONFIRM=" + confirm + ": " + r.calls.join(" | "));
    assert.match(r.out, /DRY-RUN/);
  }
});

test("verify fails when the tagged canary receives traffic, even with denied anonymous endpoints", () => {
  const r = runCanary(VERIFY_ARGS,{ serviceJson: serviceJson(20), curlOut: DENIED_GOOGLE });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /TRAFFIC_NOT_ZERO/);
  assert.match(r.out, /FAIL canary must hold 0% traffic/);
  assert.match(r.out, /PASS anonymous \/ -> 302 Google sign-in/);
});

test("verify passes with 0% canary traffic and denied anonymous endpoints", () => {
  const r = runCanary(VERIFY_ARGS,{ serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /TRAFFIC_NOT_ZERO|FAIL/);
  assert.match(r.out, /PASS anonymous \/liveness -> 302 Google sign-in/);
});

test("verify fails with 0% canary traffic when an anonymous endpoint is answered", () => {
  const r = runCanary(VERIFY_ARGS,{ serviceJson: serviceJson(0), curlOut: "200 " });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /FAIL anonymous \/ -> 200/);
});

test("verify fails when the canary revision gets traffic through an untagged entry, though the tagged entry shows 0%", () => {
  const r = runCanary(VERIFY_ARGS,{
    serviceJson: serviceJsonWithTraffic([
      { percent: 80, revisionName: STABLE },
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
      { percent: 20, revisionName: CANARY },
    ]),
    curlOut: DENIED_GOOGLE,
  });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /TRAFFIC_NOT_ZERO 20 /);
  assert.match(r.out, /FAIL canary must hold 0% traffic/);
  assert.ok(!r.calls.some((c) => c.includes("revisions describe")), "canary logs read after a failed traffic check");
});

test("verify passes only when every entry for the canary revision is 0% (true zero-traffic control)", () => {
  const r = runCanary(VERIFY_ARGS,{
    serviceJson: serviceJsonWithTraffic([
      { percent: 100, revisionName: STABLE },
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
      { percent: 0, revisionName: CANARY },
    ]),
    curlOut: DENIED_GOOGLE,
  });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /TRAFFIC_NOT_ZERO|TRAFFIC_UNVERIFIABLE|FAIL/);
  assert.ok(r.calls.some((c) => c.includes("revisions describe " + CANARY)), "canary revision not read: " + r.calls.join(" | "));
});

test("verify fails closed on missing, ambiguous or malformed canary traffic", () => {
  const cases = {
    "traffic absent": null,
    "traffic empty": [],
    "no tagged entry": [{ percent: 100, revisionName: STABLE }],
    "two tagged entries": [
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
      { percent: 0, revisionName: STABLE, tag: "iapcanary", url: TAG_URL },
    ],
    "tagged entry without revisionName": [
      { percent: 100, revisionName: STABLE },
      { percent: 0, latestRevision: true, tag: "iapcanary", url: TAG_URL },
    ],
    "untagged latestRevision at positive percent": [
      { percent: 80, revisionName: STABLE },
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
      { percent: 20, latestRevision: true },
    ],
    "percent as string": [
      { percent: 100, revisionName: STABLE },
      { percent: "0", revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
    ],
  };
  for (const [name, traffic] of Object.entries(cases)) {
    const r = runCanary(VERIFY_ARGS,{ serviceJson: serviceJsonWithTraffic(traffic), curlOut: DENIED_GOOGLE });
    assert.notEqual(r.status, 0, name + " accepted:\n" + r.out);
    assert.match(r.out, /FAIL canary must hold 0% traffic/, name);
    assert.ok(!r.calls.some((c) => c.includes("revisions describe")), name + ": canary logs read after failure");
  }
});

const TWO_ENTRY_TRAFFIC = [
  { percent: 100, revisionName: STABLE },
  { percent: 0, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
];

test("verify fails when IAP is not enabled on the service, even with a synthetic 401 on every path", () => {
  const cases = {
    "annotation absent": { metadata: {} },
    "annotation false": { metadata: { annotations: { "run.googleapis.com/iap-enabled": "false" } } },
    "annotation boolean true": { metadata: { annotations: { "run.googleapis.com/iap-enabled": true } } },
    "metadata absent": {},
  };
  for (const [name, doc] of Object.entries(cases)) {
    const r = runCanary(VERIFY_ARGS, {
      serviceJson: JSON.stringify({ ...doc, status: { traffic: TWO_ENTRY_TRAFFIC } }),
      curlOut: "401 ",
    });
    assert.notEqual(r.status, 0, name + " accepted:\n" + r.out);
    assert.match(r.out, /IAP_NOT_PROVEN/, name);
    assert.match(r.out, /FAIL service IAP annotation not proven/, name);
    assert.match(r.out, /PASS anonymous \/ -> 401/, name); // the synthetic 401 is printed, but it is not accepted as IAP proof
    assert.ok(!r.calls.some((c) => c.includes("revisions describe")), name + ": canary revision read after failed IAP check");
    assert.ok(!r.calls.some((c) => c.startsWith("logging read")), name + ": logs read after failed IAP check");
  }
});

test("verify fails closed when the tagged canary revision does not prove the owner-only guard", () => {
  const cases = {
    "guard 0": canaryRevisionJson({ env: guardEnv({ VELVETOS_REQUIRE_IAP: "0" }) }),
    "guard missing": canaryRevisionJson({ env: guardEnv({ VELVETOS_REQUIRE_IAP: undefined }) }),
    "audience mismatch": canaryRevisionJson({ env: guardEnv({ VELVETOS_IAP_AUDIENCE: AUD.replace("123456789012", "999999999999") }) }),
    "allowlist mismatch": canaryRevisionJson({ env: guardEnv({ VELVETOS_IAP_ALLOWED_EMAILS: "other@example.test" }) }),
    "allowlist missing": canaryRevisionJson({ env: guardEnv({ VELVETOS_IAP_ALLOWED_EMAILS: undefined }) }),
    "duplicate guard name": canaryRevisionJson({ env: [...guardEnv(), { name: "VELVETOS_REQUIRE_IAP", value: "1" }] }),
    "audience from secret ref": canaryRevisionJson({
      env: [...guardEnv({ VELVETOS_IAP_AUDIENCE: undefined }), { name: "VELVETOS_IAP_AUDIENCE", valueFrom: { secretKeyRef: { name: "aud", key: "latest" } } }],
    }),
    "revision not Ready": canaryRevisionJson({ ready: "False" }),
    "two containers": JSON.stringify({
      spec: { containers: [{ env: guardEnv() }, { env: [] }] },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    }),
    "revision without containers": JSON.stringify({ spec: {}, status: { conditions: [{ type: "Ready", status: "True" }] } }),
    "empty revision object": "{}",
  };
  for (const [name, revision] of Object.entries(cases)) {
    const r = runCanary(VERIFY_ARGS, { serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE, revisionJson: revision });
    assert.notEqual(r.status, 0, name + " accepted:\n" + r.out);
    assert.match(r.out, /FAIL canary revision IAP guard not proven/, name);
    assert.doesNotMatch(r.out, /PASS canary revision/, name);
    assert.ok(!r.out.includes(OWNER) && !r.out.includes("other@example.test") && !r.out.includes("999999999999"),
      name + ": a configured value leaked into output");
    assert.ok(!r.calls.some((c) => c.startsWith("logging read")), name + ": logs read after failed revision guard");
  }
});

test("verify fails closed when the canary revision cannot be read", () => {
  const r = runCanary(VERIFY_ARGS, { serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE, revisionFail: true });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /FAIL canary revision unreadable/);
  assert.ok(!r.calls.some((c) => c.startsWith("logging read")), "logs read after revision lookup failed");
});

test("verify passes only with IAP on, an exact guard on the tagged revision, and 0% traffic", () => {
  const r = runCanary(VERIFY_ARGS, { serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS canary revision /);
  assert.doesNotMatch(r.out, /FAIL|NOT_PROVEN|UNVERIFIABLE|NOT_ZERO/);
  assert.ok(r.calls.some((c) => c.includes("revisions describe " + CANARY) && c.includes("--format=json")), "canary revision not described as JSON");
  assert.ok(r.calls.some((c) => c.startsWith("logging read")), "logs not read after the guard passed");
  assert.ok(!r.out.includes(AUD) && !r.out.includes(OWNER), "audience or owner leaked into output");
  assert.match(r.out, /CONTROL PLANE/);
  assert.match(r.out, /SYNTHETIC HTTP/);
});

test("verify refuses an explicit --tag-url that is a different valid run.app URL, before any curl or revision read", () => {
  const OTHER_TAG_URL = "https://iapcanary---other-service-999999.me-west1.run.app";
  const r = runCanary(["verify", "--tag-url", OTHER_TAG_URL, "--audience", AUD, "--allowed-emails", OWNER],
    { serviceJson: serviceJson(0), curlOut: "401 " });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /FAIL --tag-url does not match the service's tagged canary URL/);
  assert.doesNotMatch(r.out, /PASS/);
  assert.ok(!r.calls.some((c) => c.startsWith("curl ")), "curl ran against a URL the service does not own: " + r.calls.join(" | "));
  assert.ok(!r.calls.some((c) => c.includes("revisions describe")), "canary revision read after URL mismatch");
  assert.ok(!r.calls.some((c) => c.startsWith("logging read")), "logs read after URL mismatch");
});

test("verify fails closed before any curl when the service's tagged URL is missing, malformed or duplicated", () => {
  const cases = {
    "tagged entry without url": [
      { percent: 100, revisionName: STABLE },
      { percent: 0, revisionName: CANARY, tag: "iapcanary" },
    ],
    "tagged url on another tag": [
      { percent: 100, revisionName: STABLE },
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: "https://other---velvetos-control-center-staging-123456.me-west1.run.app" },
    ],
    "tagged url not run.app": [
      { percent: 100, revisionName: STABLE },
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: "https://example.test" },
    ],
    "two tagged entries": [
      { percent: 0, revisionName: CANARY, tag: "iapcanary", url: TAG_URL },
      { percent: 0, revisionName: STABLE, tag: "iapcanary", url: TAG_URL },
    ],
  };
  const argSets = [
    ["--audience", AUD, "--allowed-emails", OWNER],
    ["--tag-url", TAG_URL, "--audience", AUD, "--allowed-emails", OWNER],
  ];
  for (const [name, traffic] of Object.entries(cases)) {
    for (const extra of argSets) {
      const r = runCanary(["verify", ...extra], { serviceJson: serviceJsonWithTraffic(traffic), curlOut: DENIED_GOOGLE });
      const label = name + " with " + extra.join(" ");
      assert.notEqual(r.status, 0, label + " accepted:\n" + r.out);
      assert.match(r.out, /FAIL tagged canary URL not found/, label);
      assert.ok(!r.calls.some((c) => c.startsWith("curl ")), label + ": curl ran: " + r.calls.join(" | "));
      assert.ok(!r.calls.some((c) => c.includes("revisions describe")), label + ": canary revision read");
      assert.ok(!r.calls.some((c) => c.startsWith("logging read")), label + ": logs read");
    }
  }
});

test("verify uses only the service's tagged URL when the explicit --tag-url matches it byte-for-byte", () => {
  const r = runCanary(VERIFY_ARGS, { serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE });
  assert.equal(r.status, 0, r.out);
  const curls = r.calls.filter((c) => c.startsWith("curl "));
  assert.equal(curls.length, 4, "expected four anonymous checks: " + curls.join(" | "));
  for (const path of ["/", "/health", "/liveness", "/api/control/v1/snapshot"]) {
    assert.ok(curls.some((c) => c.endsWith(TAG_URL + path)), "missing anonymous check for " + path);
  }
  assert.ok(curls.every((c) => c.includes(TAG_URL)), "anonymous check used another URL: " + curls.join(" | "));
});

test("verify requires an exact audience and owner allowlist before any gcloud call", () => {
  const cases = [
    ["--tag-url", TAG_URL],
    ["--tag-url", TAG_URL, "--audience", AUD],
    ["--tag-url", TAG_URL, "--allowed-emails", OWNER],
    ["--tag-url", TAG_URL, "--audience", "/projects/123/locations/me-west1/services/other", "--allowed-emails", OWNER],
    ["--tag-url", TAG_URL, "--audience", AUD, "--allowed-emails", "not-an-email"],
    ["--tag-url", "https://example.test", "--audience", AUD, "--allowed-emails", OWNER],
  ];
  for (const args of cases) {
    const r = runCanary(["verify", ...args], { serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE });
    assert.notEqual(r.status, 0, "accepted: " + args.join(" "));
    assert.deepEqual(r.calls, [], "gcloud called for invalid verify input: " + args.join(" "));
  }
});
