// Offline contract for scripts/iap-guard-canary.sh: dry-run by default, never a
// traffic change, strict inputs. A fake gcloud records every invocation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./iap-guard-canary.sh", import.meta.url));
const IMAGE = "gcr.io/instamcp/velvetos-control-center@sha256:" + "a".repeat(64);
const AUD = "/projects/123456789012/locations/me-west1/services/velvetos-control-center-staging";

function run(args, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "fake-gcloud-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "gcloud"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho '{}'\n`);
  chmodSync(join(bin, "gcloud"), 0o755);
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8", env: { PATH: bin + ":/usr/bin:/bin", ...env }, timeout: 10_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  rmSync(bin, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

test("plan and deploy are dry-run by default and never call gcloud", () => {
  const plan = run(["plan", "--image", IMAGE, "--audience", AUD]);
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
  const noConfirm = run(["deploy", "--image", IMAGE, "--audience", AUD, "--apply"]);
  assert.notEqual(noConfirm.status, 0);
  assert.deepEqual(noConfirm.calls, []);
  const applied = run(["deploy", "--image", IMAGE, "--audience", AUD, "--apply"], { CANARY_CONFIRM: "deploy-no-traffic" });
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
    ["--image", IMAGE, "--audience", AUD, "--allowed-emails", "not-an-email"],
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
