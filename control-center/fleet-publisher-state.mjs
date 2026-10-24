import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const PUBLISHER_STATE_SCHEMA = "velvetos.portal.fleet-publisher-state.v1";
const GENERATION = /^(0|[1-9][0-9]{0,24})$/;
const isText = x => typeof x === "string";
const isSha256 = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const hasExactKeys = (v, keys) =>
  v && typeof v === "object" && !Array.isArray(v) &&
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify(keys.slice().sort());

export function validatePublisherState(state, { bucket, objectName, keyId }) {
  const keys = ["bucket", "generation", "keyId", "lastCommittedAt", "lastIssuedAt",
    "lastSequence", "objectName", "pending", "schema"];
  if (!hasExactKeys(state, keys) ||
      state.schema !== PUBLISHER_STATE_SCHEMA ||
      state.bucket !== bucket || state.objectName !== objectName ||
      state.keyId !== keyId ||
      !isText(state.generation) || !GENERATION.test(state.generation) ||
      !Number.isSafeInteger(state.lastSequence) || state.lastSequence < 0 ||
      !(state.lastCommittedAt === null || (isText(state.lastCommittedAt) &&
        !Number.isNaN(Date.parse(state.lastCommittedAt)))) ||
      !(state.lastIssuedAt === null || (isText(state.lastIssuedAt) &&
        !Number.isNaN(Date.parse(state.lastIssuedAt)))) ||
      !(state.pending === null ||
        ((hasExactKeys(state.pending, ["expectedGeneration", "sequence"]) ||
          hasExactKeys(state.pending, ["expectedGeneration", "sequence", "sha256"])) &&
         isText(state.pending.expectedGeneration) &&
         GENERATION.test(state.pending.expectedGeneration) &&
         state.pending.expectedGeneration === state.generation &&
         state.pending.sequence === state.lastSequence &&
         (state.pending.sha256 === undefined || isSha256(state.pending.sha256))))) {
    throw new Error("invalid_or_mismatched_publisher_state");
  }
  return state;
}

function freshState({ bucket, objectName, keyId }) {
  return {
    schema: PUBLISHER_STATE_SCHEMA,
    bucket, objectName, keyId, generation: "0",
    lastSequence: 0, lastIssuedAt: null, lastCommittedAt: null,
    pending: null,
  };
}

// Writes always use a same-directory temp file, fsync, and atomic rename.
// A crash before upload preserves a reserved sequence. A crash after upload
// but before commit leaves pending=true; never auto-retry an unknown outcome.
export async function savePublisherState(filename, state, identity) {
  validatePublisherState(state, identity);
  const temporary = filename + "." + crypto.randomBytes(8).toString("hex") + ".pending-write";
  let fd;
  try {
    fd = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await fd.writeFile(JSON.stringify(state) + "\n", "utf8");
    await fd.sync();
    await fd.close();
    fd = null;
    await fs.rename(temporary, filename);
    if (process.platform !== "win32") {
      try {
        const directoryFd = await fs.open(path.dirname(filename), "r");
        try { await directoryFd.sync(); } finally { await directoryFd.close(); }
      } catch { /* platform-dependent directory durability; never omit file fsync */ }
    }
  } finally {
    if (fd) await fd.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function withPublisherStateLock({
  stateFile, identity, allowInitialize = false,
}, action) {
  if (!path.isAbsolute(stateFile) ||
      path.basename(stateFile) !== "publisher-state.json") {
    throw new Error("invalid_publisher_state_path");
  }
  const parent = await fs.lstat(path.dirname(stateFile));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("publisher_state_parent_invalid");
  const lock = stateFile + ".lock";
  let lockHandle;
  try {
    lockHandle = await fs.open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("publisher_already_running_or_stale_lock");
    throw error;
  }
  try {
    let state;
    try {
      const stat = await fs.lstat(stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
        throw new Error("publisher_state_file_invalid");
      state = validatePublisherState(
        JSON.parse(await fs.readFile(stateFile, "utf8")), identity);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!allowInitialize) throw new Error("publisher_state_missing_requires_initialization");
      state = freshState(identity);
      // Initialization can proceed only after the caller verifies the remote
      // object does not exist; caller will persist before any upload.
    }
    return await action({ state, save: next => savePublisherState(stateFile, next, identity),
      initializing: !(await fs.access(stateFile).then(() => true).catch(() => false)) });
  } finally {
    try { await lockHandle?.close(); } finally {
      await fs.unlink(lock).catch(() => {});
    }
  }
}
