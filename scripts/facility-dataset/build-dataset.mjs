#!/usr/bin/env node
// Builds a CANDIDATE static facility dataset from OSM JSON or osmium OPL.
//
//   node scripts/facility-dataset/build-dataset.mjs \
//     --input <file> --region KR --out <directory outside this repository> \
//     --quality-gates <gates.json> \
//     [--input-format json|opl] [--data-as-of 2026-10-20T00:00:00Z] \
//     [--source-label "text"] [--source-url https://...] [--source-sha256 <hex>] \
//     [--max-input-mb N] [--max-elements N]
//
// Order of work (nothing is written unless every step succeeds):
//   1. arguments, region and output path checks (no reads, no writes);
//   2. quality-gates file (thresholds and explicit geometry allowances);
//   3. input read (OPL is streamed) and heap check;
//   4. build (pure; stops on unresolved facility geometry, dropped emergency
//      evidence, failed gates, oversize tiles);
//   5. acceptance check: every build gate configured and passed;
//   6. atomic write (lib/write-output.mjs).
// It never publishes: the output directory must be outside the repository,
// because the whole repository root is the Netlify publish directory
// (netlify.toml publish = "."). Existing version directories are never
// overwritten. No network access; reads only the input and gates files.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildDataset, DatasetBuildError} from "./lib/generate.mjs";
import {generatorInfo} from "./lib/provenance.mjs";
import {sha256Hex} from "./lib/canonical-json.mjs";
import {assertOutsideRepository, OutputGuardError} from "./lib/output-guard.mjs";
import {readOplFile, OplParseError, OPL_DEFAULT_LIMITS, OPL_HARD_LIMITS} from "./lib/opl.mjs";
import {writeDatasetVersion, staleStagingDirectories} from "./lib/write-output.mjs";
import {assertHeapFits} from "./lib/memory.mjs";
import {REGIONS} from "./regions/kr.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_JSON_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_GATES_FILE_BYTES = 1024 * 1024;
const OPTIONS = new Set([
  "--input", "--region", "--out", "--data-as-of", "--source-label", "--input-format",
  "--source-url", "--source-sha256", "--max-input-mb", "--max-elements", "--quality-gates"
]);

function parseArguments(argv){
  const parsed = Object.create(null);
  for(let index = 0; index < argv.length; index += 2){
    const name = argv[index];
    const value = argv[index + 1];
    if(!OPTIONS.has(name) || value === undefined || value.startsWith("--")){
      throw new DatasetBuildError("INVALID_ARGUMENTS", `unexpected argument ${name}`);
    }
    if(Object.prototype.hasOwnProperty.call(parsed, name.slice(2))){
      throw new DatasetBuildError("INVALID_ARGUMENTS", `${name} given twice`);
    }
    parsed[name.slice(2)] = value;
  }
  for(const required of ["input", "region", "out"]){
    if(!parsed[required]) throw new DatasetBuildError("INVALID_ARGUMENTS", `--${required} is required`);
  }
  const format = parsed["input-format"] || "json";
  if(format !== "json" && format !== "opl"){
    throw new DatasetBuildError("INVALID_ARGUMENTS", "--input-format must be json or opl");
  }
  parsed["input-format"] = format;
  if(format === "json" && (parsed["max-input-mb"] !== undefined || parsed["max-elements"] !== undefined)){
    throw new DatasetBuildError("INVALID_ARGUMENTS", "--max-input-mb and --max-elements apply to --input-format opl only");
  }
  if(format === "opl" && !parsed["data-as-of"]){
    // OPL has no header timestamp; the date must come from `osmium fileinfo`.
    throw new DatasetBuildError("MISSING_DATA_AS_OF", "--data-as-of is required with --input-format opl");
  }
  if((parsed["source-url"] === undefined) !== (parsed["source-sha256"] === undefined)){
    throw new DatasetBuildError("INVALID_ARGUMENTS", "--source-url and --source-sha256 must be given together");
  }
  return parsed;
}

function positiveIntegerOption(args, name, hardMaximum){
  if(args[name] === undefined) return undefined;
  const value = Number(args[name]);
  if(!/^\d+$/.test(args[name]) || !Number.isSafeInteger(value) || value <= 0 || value > hardMaximum){
    throw new DatasetBuildError("INVALID_ARGUMENTS", `--${name} must be an integer from 1 to ${hardMaximum}`);
  }
  return value;
}

function oplLimits(args){
  const limits = {...OPL_DEFAULT_LIMITS};
  const megabytes = positiveIntegerOption(args, "max-input-mb", OPL_HARD_LIMITS.maxInputBytes / (1024 * 1024));
  if(megabytes !== undefined) limits.maxInputBytes = megabytes * 1024 * 1024;
  const elements = positiveIntegerOption(args, "max-elements", OPL_HARD_LIMITS.maxElements);
  if(elements !== undefined) limits.maxElements = elements;
  return limits;
}

function readQualityGates(filePath){
  if(filePath === undefined) return undefined;
  const resolved = path.resolve(filePath);
  let stat;
  try{
    stat = fs.statSync(resolved);
  }catch(error){
    throw new DatasetBuildError("INVALID_QUALITY_GATES", "quality gates file cannot be read");
  }
  if(!stat.isFile() || stat.size > MAX_GATES_FILE_BYTES){
    throw new DatasetBuildError("INVALID_QUALITY_GATES", `quality gates must be a file of at most ${MAX_GATES_FILE_BYTES} bytes`);
  }
  try{
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  }catch(error){
    throw new DatasetBuildError("INVALID_QUALITY_GATES", "quality gates file is not valid JSON");
  }
}

function readJsonInput(inputPath){
  const stat = fs.statSync(inputPath);
  if(!stat.isFile() || stat.size > MAX_JSON_INPUT_BYTES){
    throw new DatasetBuildError("INVALID_INPUT", `input must be a file of at most ${MAX_JSON_INPUT_BYTES} bytes`);
  }
  const rawBytes = fs.readFileSync(inputPath);
  try{
    return {input: JSON.parse(rawBytes.toString("utf8")), rawInputSha256: sha256Hex(rawBytes), format: "osm-json"};
  }catch(error){
    throw new DatasetBuildError("INVALID_INPUT", "input is not valid JSON");
  }
}

async function readOplInput(inputPath, args){
  const limits = oplLimits(args);
  const stat = fs.statSync(inputPath);
  if(!stat.isFile()) throw new DatasetBuildError("INVALID_INPUT", "input is not a regular file");
  if(stat.size > limits.maxInputBytes){
    throw new DatasetBuildError("INVALID_INPUT", `input is ${stat.size} bytes (limit ${limits.maxInputBytes}; raise with --max-input-mb up to ${OPL_HARD_LIMITS.maxInputBytes / 1048576})`);
  }
  assertHeapFits(stat.size);
  const {elements, stats} = await readOplFile(inputPath, limits);
  return {input: {elements}, rawInputSha256: stats.sha256, format: "osm-opl", stats, limits};
}

async function run(argv){
  const args = parseArguments(argv);
  const region = REGIONS[args.region];
  if(!region) throw new DatasetBuildError("UNKNOWN_REGION", `no region definition for ${args.region}`);

  // Checked before anything is read or written; rejected paths cause no writes.
  const outRoot = path.resolve(args.out);
  assertOutsideRepository(outRoot, REPOSITORY_ROOT);
  const qualityGates = readQualityGates(args["quality-gates"]);

  const inputPath = path.resolve(args.input);
  const read = args["input-format"] === "opl" ? await readOplInput(inputPath, args) : readJsonInput(inputPath);
  const upstream = args["source-url"] === undefined ? undefined : {url: args["source-url"], sha256: args["source-sha256"]};

  const result = buildDataset(read.input, {
    region,
    generator: generatorInfo(),
    dataAsOf: args["data-as-of"],
    sourceLabel: args["source-label"] || path.basename(inputPath),
    rawInputSha256: read.rawInputSha256,
    sourceFormat: read.format,
    upstream,
    qualityGates
  });

  const target = writeDatasetVersion(result, outRoot, REPOSITORY_ROOT);
  const summary = {
    ok: true,
    datasetVersionId: result.datasetVersionId,
    status: result.manifest.status,
    acceptance: result.report.acceptance.status,
    publishable: false,
    pendingReview: result.report.acceptance.pendingReview,
    inputFormat: args["input-format"],
    outputDirectory: target,
    manifestSha256: result.manifestSha256,
    contentSha256: result.manifest.contentSha256,
    counts: result.manifest.counts,
    rejected: result.report.rejected.total,
    allowedGeometryExclusions: result.report.integrity.allowedExclusionCount,
    files: result.files.length
  };
  if(read.stats) summary.opl = {lines: read.stats.lineCount, objects: read.stats.objectCount, bytes: read.stats.bytes, limits: read.limits};
  const stale = staleStagingDirectories(outRoot);
  if(stale.length) summary.staleStagingDirectories = stale;
  return summary;
}

function errorOutput(error){
  const known = error instanceof DatasetBuildError || error instanceof OutputGuardError || error instanceof OplParseError;
  const output = {ok: false, code: known ? error.code : "UNEXPECTED_ERROR", message: String(error && error.message || error)};
  if(error instanceof OplParseError && error.lineNumber) output.lineNumber = error.lineNumber;
  if(error instanceof DatasetBuildError && error.details && Object.keys(error.details).length) output.details = error.details;
  return output;
}

run(process.argv.slice(2)).then((summary) => {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}, (error) => {
  process.stderr.write(JSON.stringify(errorOutput(error)) + "\n");
  process.exitCode = 1;
});
