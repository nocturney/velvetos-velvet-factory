import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishFleetSnapshotOnce } from "../fleet-publisher.mjs";
import { verifySignedFleetSnapshot } from "../fleet-signed-snapshot.mjs";

// Explicit ONE-SHOT offline exercise against Chris canonical Fleet.
// It never connects to GCS, writes a live object or creates a production key.
// It may not run on hosts other than Chris Windows under the opt-in test flag.
if (process.platform !== "win32" ||
    process.env.VF_FLEET_PUBLISHER_LOCAL_DRYRUN !== "1") {
  throw Error("local_fleet_publisher_dryrun_requires_explicit_windows_opt_in");
}
const viewerFile = "D:\\Velvet\\State\\CreativeControlCenter\\remote-access-token.txt";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-fleet-publisher-local-"));
try {
  const keys = crypto.generateKeyPairSync("ed25519");
  let uploadObserved = false, remoteGeneration = "0", lastBody = null;
  const identity = {
    bucket: "vf-synthetic-no-cloud",
    objectName: "portal/fleet/status.json",
    keyId: "ephemeral_dryrun_key",
  };
  const receipt = await publishFleetSnapshotOnce({
    stateFile: path.join(root, "publisher-state.json"),
    identity, allowInitialize: true,
    transport: {
      bucket:identity.bucket, objectName:identity.objectName,
      inspect:async()=>remoteGeneration,
      readSignedAtGeneration:async(generation)=>{
        assert.equal(generation,remoteGeneration);
        assert(lastBody);
        return {
          signed:JSON.parse(lastBody),
          sha256:crypto.createHash("sha256").update(lastBody).digest("hex"),
        };
      },
      uploadIfGeneration:async(body, expected)=>{
        assert.equal(expected,"0");
        const parsed=JSON.parse(body);
        const verified=verifySignedFleetSnapshot(parsed, {
          publicKey:keys.publicKey,
          keyId:identity.keyId,
          now:Date.now(),
        });
        assert(verified.count>0);
        uploadObserved=true;
        lastBody=body;
        remoteGeneration="1";
        // This is an in-memory simulation only. No real network upload.
        return remoteGeneration;
      },
    },
    getViewerToken:async()=>(await fs.readFile(viewerFile,"utf8")).trim(),
    getSigningKey:async()=>keys.privateKey,
  });
  assert(uploadObserved);
  assert.equal(receipt.sequence,1);
  assert.equal(receipt.generation,"1");
  console.log("FLEET_PUBLISHER_REAL_SOURCE_DRYRUN_PASS count="+receipt.count+
    " signed_and_verified=true private_key_persisted=false"+
    " cloud_upload=false production_state_changes=false");
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
