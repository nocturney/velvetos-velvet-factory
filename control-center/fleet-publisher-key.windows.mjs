import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const script = fileURLToPath(new URL("./fleet-publisher-key.windows.ps1", import.meta.url));
const allowedKeyName = "fleet-signing-key.dpapi";

function validPath(filename) {
  if (process.platform !== "win32" || !path.win32.isAbsolute(filename || "") ||
      path.win32.basename(filename) !== allowedKeyName) {
    throw new Error("windows_dpapi_signing_key_path_invalid");
  }
  return filename;
}

async function dpapiPipe(operation, filename, privateBase64 = "") {
  validPath(filename);
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", script,
    "-Operation", operation, "-ProtectedFile", filename,
  ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderrBytes = 0;
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    child.stdout.on("data", bytes => {
      stdout += bytes.toString("utf8");
      if (stdout.length > 4096) child.kill();
    });
    // Discard stderr; Powershell can echo tool diagnostic context.
    child.stderr.on("data", bytes => {
      stderrBytes += bytes.length;
      if (stderrBytes > 4096) child.kill();
    });
    child.stdin.end(privateBase64);
    if (await completion !== 0) throw new Error("windows_dpapi_key_operation_failed");
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function initializeWindowsSigningKey(filename) {
  // Intentionally an explicit administrative action, never invoked on startup.
  validPath(filename);
  try {
    await fs.lstat(filename);
    throw new Error("protected_signing_key_already_exists");
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const pair = crypto.generateKeyPairSync("ed25519");
  const raw = pair.privateKey.export({ format: "der", type: "pkcs8" });
  try {
    const receipt = await dpapiPipe("Protect", filename, raw.toString("base64"));
    if (receipt !== "PROTECTED_KEY_SAVED")
      throw new Error("protected_signing_key_receipt_missing");
    return {
      publicSpkiBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      keyType: "ed25519",
      protection: "windows-dpapi-current-user",
    };
  } finally {
    raw.fill(0);
  }
}

export async function loadWindowsSigningKey(filename) {
  validPath(filename);
  const encoded = await dpapiPipe("Unprotect", filename);
  if (!/^[A-Za-z0-9+/=]{48,2048}$/.test(encoded))
    throw new Error("invalid_decrypted_private_key");
  const raw = Buffer.from(encoded, "base64");
  try {
    const privateKey = crypto.createPrivateKey({
      key: raw, format: "der", type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("decrypted_signer_not_ed25519");
    return privateKey;
  } finally {
    raw.fill(0);
  }
}
