import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validatePublisherState } from "./fleet-publisher-state.mjs";
import { verifySignedFleetSnapshot } from "./fleet-signed-snapshot.mjs";

export const RECONCILE_REPORT_SCHEMA = "velvetos.portal.fleet-reconciliation-audit.v1";

// Advisory inspector, not a state repair or writer. It intentionally takes no
// lock and writes no files; double-read detects state edits during inspection.
// A result can NEVER clear pending, authorize a retry or advance a generation.
async function readStateSnapshot(stateFile, identity) {
  if (!path.isAbsolute(stateFile) || path.basename(stateFile) !== "publisher-state.json")
    throw new Error("invalid_publisher_state_path");
  const parent = await fs.lstat(path.dirname(stateFile));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("publisher_state_parent_invalid");
  const stat = await fs.lstat(stateFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw new Error("publisher_state_file_invalid");
  const bytes = await fs.readFile(stateFile);
  if (bytes.byteLength > 8192) throw new Error("publisher_state_file_invalid");
  const state = validatePublisherState(JSON.parse(bytes.toString("utf8")), identity);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  return { state, digest };
}

export async function inspectPublisherReconciliation({
  stateFile, identity, transport, publicKey, now = () => Date.now(),
}) {
  if (!identity || !transport || transport.bucket !== identity.bucket ||
      transport.objectName !== identity.objectName ||
      typeof transport.inspect !== "function" ||
      publicKey?.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("reconciliation_dependencies_not_approved");

  const initial = await readStateSnapshot(stateFile, identity);
  const state = initial.state;
  const base = {
    schema: RECONCILE_REPORT_SCHEMA,
    status: "REMOTE_UNAVAILABLE", manualReviewRequired: true,
    localGeneration: state.generation, remoteGeneration: null,
    localSequence: state.lastSequence,
    pendingSequence: state.pending?.sequence ?? null,
    remoteSignedSequence: null, remoteExpired: null, pendingDigestMatched: null,
  };
  try {
    const remoteGeneration = await transport.inspect();
    if (typeof remoteGeneration !== "string" ||
        !/^(0|[1-9][0-9]{0,24})$/.test(remoteGeneration))
      throw new Error("reconciliation_remote_generation_invalid");
    base.remoteGeneration = remoteGeneration;

    if (!state.pending) {
      base.status = remoteGeneration === state.generation ? "CLEAN_MATCH" : "CLEAN_REMOTE_DRIFT";
      base.manualReviewRequired = remoteGeneration !== state.generation;
    } else if (remoteGeneration === state.generation) {
      base.status = "PENDING_REMOTE_UNCHANGED";
    } else if (remoteGeneration === "0") {
      base.status = "PENDING_REMOTE_MISSING";
    } else if (typeof transport.readSignedAtGeneration !== "function") {
      base.status = "PENDING_REMOTE_UNVERIFIED";
    } else {
      // GCS generation is pinned on the media GET; changes fail closed.
      try {
        const remote = await transport.readSignedAtGeneration(remoteGeneration);
        const signed = remote?.signed;
        // Forensics can authenticate an expired object historically, but an
        // authentic signature alone never authorizes a state transition.
        verifySignedFleetSnapshot(signed, {
          publicKey, keyId: identity.keyId,
          now: Date.parse(signed?.issuedAt),
        });
        base.remoteSignedSequence = signed.sequence;
        const t = now();
        if (!Number.isSafeInteger(t) || t < 0) throw Error("reconciliation_clock_invalid");
        base.remoteExpired = Date.parse(signed.expiresAt) <= t;
        if (signed.sequence !== state.pending.sequence ||
            signed.issuedAt !== state.lastIssuedAt) {
          base.status = "PENDING_REMOTE_MISMATCH";
        } else if (state.pending.sha256) {
          // A digest is reserved BEFORE the upload. Compare it to the hash of
          // the exact remote object bytes, not JSON.stringify(parsed media).
          base.pendingDigestMatched = typeof remote.sha256 === "string" &&
            /^[a-f0-9]{64}$/.test(remote.sha256) ?
            remote.sha256 === state.pending.sha256 : null;
          base.status = base.pendingDigestMatched === true ?
            "PENDING_DIGEST_VERIFIED_CANDIDATE" :
            base.pendingDigestMatched === false ?
              "PENDING_REMOTE_DIGEST_MISMATCH" : "PENDING_REMOTE_UNVERIFIED";
        } else {
          // Legacy v1 pending records have no durable expected body hash.
          base.status = "PENDING_SIGNED_CANDIDATE";
        }
      } catch {
        base.status = "PENDING_REMOTE_UNVERIFIED";
      }
    }

    // Even an authentic candidate must be reviewed: the previous state format
    // has no reserved body digest and a valid signature is not a local receipt.
    const remoteAfter = await transport.inspect();
    if (remoteAfter !== remoteGeneration) {
      base.remoteGeneration = null;
      base.remoteSignedSequence = null;
      base.remoteExpired = null;
      base.pendingDigestMatched = null;
      base.status = "REMOTE_GENERATION_RACE";
      base.manualReviewRequired = true;
    }
  } catch {
    base.status = "REMOTE_UNAVAILABLE";
    base.remoteGeneration = null;
    base.remoteSignedSequence = null;
    base.remoteExpired = null;
    base.pendingDigestMatched = null;
    base.manualReviewRequired = true;
  }
  try {
    const final = await readStateSnapshot(stateFile, identity);
    if (final.digest !== initial.digest) {
      base.status = "LOCAL_STATE_RACE";
      base.manualReviewRequired = true;
      base.remoteSignedSequence = null;
      base.remoteExpired = null;
      base.pendingDigestMatched = null;
    }
  } catch {
    base.status = "LOCAL_STATE_RACE";
    base.manualReviewRequired = true;
    base.remoteSignedSequence = null;
    base.remoteExpired = null;
    base.pendingDigestMatched = null;
  }
  return Object.freeze(base);
}
