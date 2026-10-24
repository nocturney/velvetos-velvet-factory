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
// describe` with the synthetic service JSON given by the test, and a fake curl prints a
// fixed "<http_code> <redirect_url>". Nothing real runs: no gcloud, no curl, no network.
const TAG_URL = "https://iapcanary---velvetos-control-center-staging-123456.me-west1.run.app";

function runCanary(args, { env = {}, serviceJson = "{}", curlOut = "" } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "fake-canary-"));
  try {
    const log = join(bin, "calls.log");
    const svc = join(bin, "service.json");
    writeFileSync(svc, serviceJson);
    writeFileSync(join(bin, "gcloud"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"`,
      'if [[ "$*" == *"services describe"* ]]; then cat "$FAKE_SERVICE_JSON"; exit 0; fi',
      'if [[ "$*" == *"revisions describe"* ]]; then echo "Ready=True"; exit 0; fi',
      "echo '{}'",
      "",
    ].join("\n"));
    writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\nprintf '%s' \"$FAKE_CURL_OUT\"\n");
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

// Synthetic Cloud Run service JSON with an explicit status.traffic list (null = absent).
function serviceJsonWithTraffic(traffic) {
  return JSON.stringify({
    metadata: { annotations: { "run.googleapis.com/iap-enabled": "true" } },
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
  const r = runCanary(["verify", "--tag-url", TAG_URL], { serviceJson: serviceJson(20), curlOut: DENIED_GOOGLE });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /TRAFFIC_NOT_ZERO/);
  assert.match(r.out, /FAIL canary must hold 0% traffic/);
  assert.match(r.out, /PASS anonymous \/ -> 302 Google sign-in/);
});

test("verify passes with 0% canary traffic and denied anonymous endpoints", () => {
  const r = runCanary(["verify", "--tag-url", TAG_URL], { serviceJson: serviceJson(0), curlOut: DENIED_GOOGLE });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /TRAFFIC_NOT_ZERO|FAIL/);
  assert.match(r.out, /PASS anonymous \/liveness -> 302 Google sign-in/);
});

test("verify fails with 0% canary traffic when an anonymous endpoint is answered", () => {
  const r = runCanary(["verify", "--tag-url", TAG_URL], { serviceJson: serviceJson(0), curlOut: "200 " });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /FAIL anonymous \/ -> 200/);
});

test("verify fails when the canary revision gets traffic through an untagged entry, though the tagged entry shows 0%", () => {
  const r = runCanary(["verify", "--tag-url", TAG_URL], {
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
  const r = runCanary(["verify", "--tag-url", TAG_URL], {
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
    const r = runCanary(["verify", "--tag-url", TAG_URL], { serviceJson: serviceJsonWithTraffic(traffic), curlOut: DENIED_GOOGLE });
    assert.notEqual(r.status, 0, name + " accepted:\n" + r.out);
    assert.match(r.out, /FAIL canary must hold 0% traffic/, name);
    assert.ok(!r.calls.some((c) => c.includes("revisions describe")), name + ": canary logs read after failure");
  }
});
