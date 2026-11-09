// Atomic, fail-closed writer for one candidate dataset version.
//
// - Refuses a candidate whose build gates are not all configured and passed
//   (report.acceptance.status !== "BUILD_GATES_PASSED"), before creating
//   anything.
// - Refuses output inside the repository (lib/output-guard.mjs) and an
//   existing version directory (versions are immutable).
// - Writes every file into a fresh staging directory next to the target,
//   reads each one back and compares its SHA-256, and only then renames the
//   staging directory to <out>/<datasetVersionId>. A version directory
//   therefore either exists completely or not at all.
// - On any handled failure the staging directory is removed, and so is the
//   output root when this call created it. A process that is killed (for
//   example out of memory) cannot clean up; it may leave a ".staging-*"
//   directory, never a version directory. Consumers must ignore ".staging-*".
//
// `fsApi` exists for fault-injection tests; production uses node:fs.

import fs from "node:fs";
import path from "node:path";
import {DatasetBuildError} from "./errors.mjs";
import {assertOutsideRepository} from "./output-guard.mjs";
import {sha256Hex} from "./canonical-json.mjs";

export const STAGING_PREFIX = ".staging-";

export function assertAccepted(result){
  const acceptance = result && result.report && result.report.acceptance;
  if(!acceptance || acceptance.status !== "BUILD_GATES_PASSED"){
    const notConfigured = acceptance && Array.isArray(acceptance.notConfigured) ? acceptance.notConfigured : [];
    if(notConfigured.length){
      throw new DatasetBuildError("REQUIRED_GATE_NOT_CONFIGURED",
        `required build gate(s) not configured: ${notConfigured.join(", ")}; the candidate is not accepted and nothing was written (pass --quality-gates)`,
        {notConfigured});
    }
    throw new DatasetBuildError("CANDIDATE_NOT_ACCEPTED", "the candidate did not pass its build gates; nothing was written");
  }
}

export function staleStagingDirectories(outRoot, fsApi = fs){
  try{
    return fsApi.readdirSync(outRoot).filter((name) => name.startsWith(STAGING_PREFIX)).sort();
  }catch(error){
    return [];
  }
}

export function writeDatasetVersion(result, outRoot, repositoryRoot, fsApi = fs){
  assertAccepted(result);
  const resolvedOut = path.resolve(outRoot);
  assertOutsideRepository(resolvedOut, repositoryRoot);
  const target = path.join(resolvedOut, result.datasetVersionId);
  assertOutsideRepository(target, repositoryRoot);
  if(fsApi.existsSync(target)){
    throw new DatasetBuildError("OUTPUT_EXISTS", `${result.datasetVersionId} already exists; versions are immutable`);
  }
  const firstCreated = fsApi.mkdirSync(resolvedOut, {recursive: true});
  let staging = null;
  try{
    // Re-check on the now-existing directory (narrows a race with a
    // concurrently replaced ancestor).
    assertOutsideRepository(resolvedOut, repositoryRoot);
    staging = fsApi.mkdtempSync(path.join(resolvedOut, `${STAGING_PREFIX}${result.datasetVersionId}-`));
    for(const file of result.files){
      const destination = path.join(staging, ...file.path.split("/"));
      fsApi.mkdirSync(path.dirname(destination), {recursive: true});
      fsApi.writeFileSync(destination, file.bytes, {flag: "wx"});
    }
    for(const file of result.files){
      const written = fsApi.readFileSync(path.join(staging, ...file.path.split("/")));
      if(sha256Hex(written) !== file.sha256){
        throw new DatasetBuildError("OUTPUT_VERIFY_FAILED", `${file.path} does not match its SHA-256 after writing`);
      }
    }
    fsApi.renameSync(staging, target);
    staging = null;
  }catch(error){
    if(staging) fsApi.rmSync(staging, {recursive: true, force: true});
    if(firstCreated) fsApi.rmSync(firstCreated, {recursive: true, force: true});
    throw error;
  }
  return target;
}
