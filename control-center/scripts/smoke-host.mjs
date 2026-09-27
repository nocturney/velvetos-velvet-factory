import { spawn } from "node:child_process";

const port = 8091;
const env = {
  ...process.env,
  PORT: String(port),
  VELVETOS_CONTROL_API_URL: process.env.VELVETOS_CONTROL_API_URL || "http://127.0.0.1:8080",
  VELVETOS_CONTROL_API_TOKEN: process.env.VELVETOS_CONTROL_API_TOKEN || "local-control-dev-token",
};

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expectStatus = async (url, status, init) => {
  const response = await fetch(url, init);
  if (response.status !== status) throw new Error(`${url}: expected ${status}, got ${response.status}`);
  return response;
};

try {
  await wait(250);
  const base = `http://127.0.0.1:${port}`;
  const health = await expectStatus(base + "/health", 200);
  const healthJson = await health.json();
  if (!healthJson.ready || !healthJson.controlApiConfigured) throw new Error("host health contract failed");

  const snapshot = await expectStatus(base + "/api/control/v1/snapshot", 200);
  const snapshotJson = await snapshot.json();
  if (snapshotJson.schema !== "velvetos.control.v1") throw new Error("snapshot schema mismatch");

  await expectStatus(base + "/api/control/v1/snapshot", 405, { method: "POST" });
  await expectStatus(base + "/api/control/v1/actions", 404);
  const home = await expectStatus(base + "/", 200);
  if (!(await home.text()).includes("VelvetOS Control Center")) throw new Error("SPA shell missing");

  console.log("OK control-center host smoke: static+snapshot+read-only boundaries");
} finally {
  child.kill();
}
