#!/usr/bin/env node
// Builds a CANDIDATE static facility dataset from an OSM JSON file.
//
//   node scripts/facility-dataset/build-dataset.mjs \
//     --input <osm.json> --region KR --out <directory outside this repository> \
//     [--data-as-of 2026-10-20T00:00:00Z] [--source-label "text"]
//
// Writes <out>/<datasetVersionId>/ and prints a JSON summary. It never
// publishes: the output directory must be outside the repository, because the
// whole repository root is the Netlify publish directory (netlify.toml
// publish = "."). Existing version directories are never overwritten.
// No network access; reads only the input file.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildDataset, DatasetBuildError} from "./lib/generate.mjs";
import {generatorInfo} from "./lib/provenance.mjs";
import {sha256Hex} from "./lib/canonical-json.mjs";
import {assertOutsideRepository, OutputGuardError} from "./lib/output-guard.mjs";
import {REGIONS} from "./regions/kr.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const OPTIONS = new Set(["--input", "--region", "--out", "--data-as-of", "--source-label"]);

function parseArguments(argv){
  const parsed = {};
  for(let index = 0; index < argv.length; index += 2){
    const name = argv[index];
    const value = argv[index + 1];
    if(!OPTIONS.has(name) || value === undefined || value.startsWith("--")){
      throw new DatasetBuildError("INVALID_ARGUMENTS", `unexpected argument ${name}`);
    }
    parsed[name.slice(2)] = value;
  }
  for(const required of ["input", "region", "out"]){
    if(!parsed[required]) throw new DatasetBuildError("INVALID_ARGUMENTS", `--${required} is required`);
  }
  return parsed;
}

function run(argv){
  const args = parseArguments(argv);
  const region = REGIONS[args.region];
  if(!region) throw new DatasetBuildError("UNKNOWN_REGION", `no region definition for ${args.region}`);

  // Checked before anything is read or written; rejected paths cause no writes.
  const outRoot = path.resolve(args.out);
  assertOutsideRepository(outRoot, REPOSITORY_ROOT);

  const inputPath = path.resolve(args.input);
  const stat = fs.statSync(inputPath);
  if(!stat.isFile() || stat.size > MAX_INPUT_BYTES){
    throw new DatasetBuildError("INVALID_INPUT", `input must be a file of at most ${MAX_INPUT_BYTES} bytes`);
  }
  const rawBytes = fs.readFileSync(inputPath);
  let input;
  try{
    input = JSON.parse(rawBytes.toString("utf8"));
  }catch(error){
    throw new DatasetBuildError("INVALID_INPUT", "input is not valid JSON");
  }

  const result = buildDataset(input, {
    region,
    generator: generatorInfo(),
    dataAsOf: args["data-as-of"],
    sourceLabel: args["source-label"] || path.basename(inputPath),
    rawInputSha256: sha256Hex(rawBytes)
  });

  const target = path.join(outRoot, result.datasetVersionId);
  assertOutsideRepository(target, REPOSITORY_ROOT);
  if(fs.existsSync(target)){
    throw new DatasetBuildError("OUTPUT_EXISTS", `${result.datasetVersionId} already exists; versions are immutable`);
  }
  const firstCreated = fs.mkdirSync(outRoot, {recursive: true});
  try{
    // Re-check on the now-existing directory (narrows a race with a
    // concurrently replaced ancestor); undo only what this run created.
    assertOutsideRepository(outRoot, REPOSITORY_ROOT);
  }catch(error){
    if(firstCreated) fs.rmSync(firstCreated, {recursive: true, force: true});
    throw error;
  }
  const staging = fs.mkdtempSync(path.join(outRoot, `.staging-${result.datasetVersionId}-`));
  try{
    for(const file of result.files){
      const destination = path.join(staging, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.writeFileSync(destination, file.bytes, {flag: "wx"});
    }
    fs.renameSync(staging, target);
  }catch(error){
    fs.rmSync(staging, {recursive: true, force: true});
    throw error;
  }

  return {
    ok: true,
    datasetVersionId: result.datasetVersionId,
    status: result.manifest.status,
    outputDirectory: target,
    manifestSha256: result.manifestSha256,
    contentSha256: result.manifest.contentSha256,
    counts: result.manifest.counts,
    rejected: result.report.rejected.total,
    files: result.files.length
  };
}

try{
  const summary = run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}catch(error){
  const code = error instanceof DatasetBuildError || error instanceof OutputGuardError ? error.code : "UNEXPECTED_ERROR";
  process.stderr.write(JSON.stringify({ok: false, code, message: String(error && error.message || error)}) + "\n");
  process.exitCode = 1;
}
