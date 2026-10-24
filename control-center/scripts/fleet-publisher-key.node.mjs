import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import {
  initializeWindowsSigningKey, loadWindowsSigningKey,
} from "../fleet-publisher-key.windows.mjs";

test("Windows publisher signing key stays DPAPI-protected at rest", {
  skip: process.platform !== "win32" ? "DPAPI is Windows-only" : false,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-dpapi-publisher-"));
  const file = path.join(dir, "fleet-signing-key.dpapi");
  try {
    const created = await initializeWindowsSigningKey(file);
    assert.equal(created.protection, "windows-dpapi-current-user");
    assert.equal(created.keyType, "ed25519");
    const sealed = await fs.readFile(file);
    assert(sealed.length > 48);
    const raw = await loadWindowsSigningKey(file);
    assert.equal(raw.asymmetricKeyType, "ed25519");
    const msg = Buffer.from("synthetic signature fixture");
    const sig = crypto.sign(null, msg, raw);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(created.publicSpkiBase64, "base64"),
      format: "der", type: "spki",
    });
    assert(crypto.verify(null, msg, publicKey, sig));
    assert(!sealed.includes(raw.export({format:"der",type:"pkcs8"})));
    await assert.rejects(initializeWindowsSigningKey(file),
      /protected_signing_key_already_exists/);
    await assert.rejects(loadWindowsSigningKey(path.join(dir,"wrong-key.bin")),
      /windows_dpapi_signing_key_path_invalid/);
    console.log("FLEET_PUBLISHER_KEY_PASS Windows_DPAPI_CurrentUser_sealed_signer");
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});
