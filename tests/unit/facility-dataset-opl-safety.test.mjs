// S2-a v3: restored and added regression coverage requested by the
// independent comparison of S2-a and S2-a v2 (REQUEST CHANGES, minor):
//  1. OPL path through the REAL client pipeline (src/app/legacy-app.js) and
//     the REAL netlify/functions/nearby-facilities.js (stub provider).
//  2. readOplFile size limits with an injected file system: stat before
//     reading and the byte count while reading, each on its own (M19, M12).
//  3. An over-limit line without a trailing newline stops early (M11).
//  4. The CLI heap pre-check in a child process with a small heap (M8).
//  5. The geometry point budget (M16).
//  6. OPL-specific CLI output safety, CRLF and unchanged JSON behaviour.
//  7. Emergency-evidence hospitals outside the data bounds (review risk A)
//     and oversized emergency geometry (review risk B).
// Synthetic data only; no network.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import test from "node:test";
import {buildDataset, DatasetBuildError} from "../../scripts/facility-dataset/lib/generate.mjs";
import {parseOplText, readOplFile, OPL_DEFAULT_LIMITS} from "../../scripts/facility-dataset/lib/opl.mjs";
import {MAX_GEOMETRY_POINTS} from "../../scripts/facility-dataset/lib/integrity.mjs";
import {ESTIMATED_HEAP_BYTES_PER_OPL_BYTE} from "../../scripts/facility-dataset/lib/memory.mjs";
import {writeDatasetVersion} from "../../scripts/facility-dataset/lib/write-output.mjs";
import {preservedTags} from "../../scripts/facility-dataset/lib/selectors.mjs";
import {sha256Hex} from "../../scripts/facility-dataset/lib/canonical-json.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {
  ROOT, GENERATOR_DIR, FIXTURE_PATH, FIXTURE_QUALITY_GATES_PATH, fileMap,
  loadClientPipeline, loadLiveFunction, staticCandidates
} from "./facility-dataset-helpers.mjs";
import {encodeOplString, encodeCoordinate} from "./facility-dataset-opl-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const CLI = path.join(GENERATOR_DIR, "build-dataset.mjs");
const OPL_FIXTURE = path.join(ROOT, "tests", "fixtures", "facility-dataset", "kr-synthetic.osm.opl");
const DATA_AS_OF = "2026-10-20T00:00:00Z";
const S1_GOLDEN_CONTENT_SHA256 = "f50b7d279b628e6e0a06e06073c9afcf6455de8996df27f486d6ea1327887016";
const GATES = {schemaVersion: "1", regionCode: "KR", maxRejectedRatio: 0.5};
const EMERGENCY = {emergencyContext: true};

function build(elements, gates = GATES){
  return buildDataset({elements}, {region: KR_REGION, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "opl-safety", qualityGates: gates});
}

function tempDir(t, prefix){
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function runCli(args, {cwd = os.tmpdir(), nodeFlags = []} = {}){
  return spawnSync(process.execPath, [...nodeFlags, CLI, ...args], {cwd, encoding: "utf8"});
}

function cliError(result){
  assert.equal(result.status, 1, result.stdout);
  return JSON.parse(result.stderr);
}

function writeJson(directory, name, value){
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function expectBuildError(code, fn, check){
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DatasetBuildError, String(error));
    assert.equal(error.code, code);
    if(check) check(error.details);
    return true;
  });
}

function listTree(directory){
  const entries = [];
  const walk = (current, prefix) => {
    for(const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))){
      if(entry.name === ".git" || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      entries.push(relative);
      if(entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(current, entry.name), relative);
    }
  };
  walk(directory, "");
  return entries;
}

// Square closed way with its four corner nodes; the bounding-box center is (lat, lon).
function squareLines(wayId, firstNodeId, latitude, longitude, tagText){
  const nodes = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([a, b], index) =>
    `n${firstNodeId + index} T x${encodeCoordinate(longitude + b * 0.0002)} y${encodeCoordinate(latitude + a * 0.0002)}`);
  const refs = [0, 1, 2, 3, 0].map((offset) => `n${firstNodeId + offset}`).join(",");
  return [...nodes, `w${wayId} T${tagText} N${refs}`];
}

// The reviewed cases, written as osmium would write them (Hangul escaped), CRLF.
function reviewedCaseOpl(){
  const hospitalName = encodeOplString("테스트병원");
  const pharmacyName = encodeOplString("테스트약국");
  return [
    `n1 Tamenity=clinic,name=${hospitalName} x126.98 y37.55`,
    `n2 Tamenity=pharmacy,name=${pharmacyName},phone=010-1111-1111,opening_hours=${encodeOplString("Mo-Fr 09:00-18:00")} x126.98 y37.55`,
    ...squareLines(11, 1001, 37.55, 126.98, `amenity=hospital,emergency=yes,name=${hospitalName}`),
    ...squareLines(12, 2001, 37.55, 126.98, `amenity=pharmacy,healthcare=hospital,emergency=yes,name=${pharmacyName},phone=010-2222-2222,opening_hours=closed`)
  ].join("\r\n") + "\r\n";
}

const BASE = {latitude: 37.5503, longitude: 126.9803};

test("1: OPL -> build -> tiles -> static candidates -> REAL client pipeline: emergency hospital way kept, pharmacy node kept, no fabricated data", async () => {
  const client = loadClientPipeline();
  const parsed = parseOplText(reviewedCaseOpl()).elements;
  const result = build(parsed);
  for(const recommendation of [null, EMERGENCY]){
    const hospitals = client.run(staticCandidates(result, "hospital", BASE.latitude, BASE.longitude, 5000), "hospital", BASE, recommendation);
    assert.equal(hospitals[0].id, "hospital-way-11", `hospital, emergency=${!!recommendation}`);
    assert.equal(hospitals[0].emergencyCareConfirmed, true);
    assert.equal(hospitals[0].emergencyTag, "yes");
    assert.equal(hospitals.some((facility) => facility.id === "hospital-node-1"), false, "the duplicate clinic node does not replace the emergency hospital");

    const pharmacies = client.run(staticCandidates(result, "pharmacy", BASE.latitude, BASE.longitude, 5000), "pharmacy", BASE, recommendation);
    assert.deepEqual(pharmacies.map((facility) => [facility.id, facility.phone, facility.openingHours, facility.emergencyCareConfirmed, facility.emergencyStatus, facility.emergencyTag]),
      [["pharmacy-node-2", "010-1111-1111", "Mo-Fr 09:00-18:00", false, "unknown", ""]], `pharmacy, emergency=${!!recommendation}`);
  }

  // Live Function (stub provider, Overpass order) for the same objects: the
  // pharmacy result is identical; for the hospital the live path keeps the
  // clinic node (documented divergence: the static path is the safer one).
  const universe = result.manifest.tiles.pharmacy.flatMap((entry) => JSON.parse(fileMap(result).get(entry.path).bytes.toString("utf8")).elements);
  const livePharmacy = await loadLiveFunction(universe).search("pharmacy", BASE.latitude, BASE.longitude);
  assert.deepEqual(client.run(livePharmacy.elements, "pharmacy", BASE, null),
    client.run(staticCandidates(result, "pharmacy", BASE.latitude, BASE.longitude, 5000), "pharmacy", BASE, null));
  const hospitalUniverse = result.manifest.tiles.hospital.flatMap((entry) => JSON.parse(fileMap(result).get(entry.path).bytes.toString("utf8")).elements)
    .concat(parsed.filter((element) => element.id === 1).map((element) => ({...element})));
  const liveHospital = await loadLiveFunction(hospitalUniverse).search("hospital", BASE.latitude, BASE.longitude);
  assert.equal(client.run(liveHospital.elements, "hospital", BASE, EMERGENCY)[0].id, "hospital-node-1");

  // Original OSM tags preserved (whitelist only), nothing added.
  const sourceTags = new Map(parsed.filter((element) => element.tags).map((element) => [`${element.type}/${element.id}`, element.tags]));
  for(const type of ["hospital", "pharmacy"]){
    for(const entry of result.manifest.tiles[type]){
      for(const record of JSON.parse(fileMap(result).get(entry.path).bytes.toString("utf8")).elements){
        assert.deepEqual(record.tags, preservedTags(sourceTags.get(`${record.type}/${record.id}`)).tags, `${record.type}/${record.id}`);
      }
    }
  }
  const pharmacyNode = parsed.find((element) => element.id === 2);
  assert.equal(Object.prototype.hasOwnProperty.call(pharmacyNode.tags, "emergency"), false, "no emergency tag fabricated");
});

// Fake file system for readOplFile: stat reports `statSize`, the stream yields `chunks`.
function fakeFs(statSize, chunks, counters = {}){
  counters.streams = 0;
  counters.pulled = 0;
  return {
    statSync: () => ({isFile: () => true, size: statSize}),
    createReadStream: () => {
      counters.streams += 1;
      return Readable.from((function* (){
        for(const chunk of chunks){
          counters.pulled += 1;
          yield chunk;
        }
      })());
    }
  };
}

test("2: size limits are enforced from stat before reading and from the bytes actually read, independently", async () => {
  const line = Buffer.from("n1 T x1 y1\n");
  // a) stat over the limit: refused before any stream is opened.
  const before = {};
  await assert.rejects(readOplFile("virtual.opl", {maxInputBytes: 100}, fakeFs(101, [line], before)),
    (error) => error.code === "OPL_INPUT_TOO_LARGE" && /limit 100/.test(error.message));
  assert.equal(before.streams, 0, "no read was started");
  // b) the file grows after stat: the byte count stops it while streaming.
  const grown = {};
  await assert.rejects(readOplFile("virtual.opl", {maxInputBytes: 100}, fakeFs(10, [Buffer.alloc(60, 0x0a), Buffer.alloc(41, 0x0a), Buffer.alloc(1000, 0x0a)], grown)),
    (error) => error.code === "OPL_INPUT_TOO_LARGE" && /while reading/.test(error.message));
  assert.equal(grown.pulled, 2, "stopped at the chunk that crossed the limit");
  // c) stat reports 0 bytes (special files): the actual bytes still count.
  await assert.rejects(readOplFile("virtual.opl", {maxInputBytes: 100}, fakeFs(0, [Buffer.alloc(101, 0x0a)])),
    (error) => error.code === "OPL_INPUT_TOO_LARGE");
  // d) exactly at the limit is accepted on both checks.
  const exact = Buffer.concat([line, Buffer.alloc(100 - line.length, 0x0a)]);
  const accepted = await readOplFile("virtual.opl", {maxInputBytes: 100}, fakeFs(100, [exact]));
  assert.equal(accepted.stats.bytes, 100);
  assert.equal(accepted.elements.length, 1);
  assert.equal(accepted.stats.sha256, sha256Hex(exact));
});

test("3: an over-limit line with no trailing newline is refused early (OPL_LINE_TOO_LONG)", async (t) => {
  // Real file: 3 MiB in one line, no newline at all.
  const directory = tempDir(t, "sos-opl-longline-");
  const file = path.join(directory, "endless.opl");
  fs.writeFileSync(file, "n1 Tname=" + "a".repeat(3 * 1024 * 1024));
  await assert.rejects(readOplFile(file), (error) => error.code === "OPL_LINE_TOO_LONG" && error.lineNumber === 1);
  assert.ok(3 * 1024 * 1024 > OPL_DEFAULT_LIMITS.maxLineBytes);
  // Injected stream: 64 chunks of 64 KiB without a newline, 100 KiB line
  // limit. The reader must stop while the line is still growing, not after
  // buffering the whole input.
  const counters = {};
  const chunks = Array.from({length: 64}, () => Buffer.alloc(64 * 1024, 0x61));
  await assert.rejects(readOplFile("virtual.opl", {maxLineBytes: 100 * 1024, maxInputBytes: 64 * 1024 * 1024}, fakeFs(64 * 64 * 1024, chunks, counters)),
    (error) => error.code === "OPL_LINE_TOO_LONG" && error.lineNumber === 1);
  assert.ok(counters.pulled <= 3, `stopped after ${counters.pulled} of 64 chunks`);
  // A long line that does end in a newline is refused the same way.
  await assert.rejects(readOplFile("virtual.opl", {maxLineBytes: 10}, fakeFs(20, [Buffer.from("n1 Tname=abcdefgh\n")])),
    (error) => error.code === "OPL_LINE_TOO_LONG" && error.lineNumber === 1);
});

// Heap limit of a child started with `flag`. The child writes the bare number
// with process.stdout.write, not `node -p`: -p prints through console.log,
// which colours numbers when FORCE_COLOR is set ("\x1b[33m218103808\x1b[39m"),
// and node --test sets FORCE_COLOR=1 for every test file when its own output
// is a terminal (e.g. npm test in PowerShell). The child inherits it, so
// Number() returned NaN there. The output is parsed strictly: anything but a
// plain positive decimal byte count stops the test with the probe details.
const HEAP_LIMIT_PROBE = "process.stdout.write(String(require('node:v8').getHeapStatistics().heap_size_limit))";
const MIN_PLAUSIBLE_HEAP_LIMIT_BYTES = 1024 * 1024;

function parseHeapLimitProbe(probe){
  const fail = (reason) => {
    const shown = (value) => typeof value === "string" ? JSON.stringify(value.slice(0, 200)) : String(value);
    throw new Error(`heap limit probe failed: ${reason}; status=${probe.status} signal=${probe.signal} error=${probe.error ? probe.error.message : "none"}; expected stdout: a positive decimal integer (bytes) and nothing else; stdout=${shown(probe.stdout)} stderr=${shown(probe.stderr)}`);
  };
  if(probe.error) fail("the child process could not be run");
  if(probe.status !== 0 || probe.signal !== null) fail("the child process did not exit normally");
  if(typeof probe.stdout !== "string") fail("stdout is not text");
  if(!/^[1-9][0-9]*$/.test(probe.stdout)) fail("stdout is not a plain decimal integer");
  const value = Number(probe.stdout);
  if(!Number.isSafeInteger(value)) fail("the value is not a safe integer");
  if(value < MIN_PLAUSIBLE_HEAP_LIMIT_BYTES) fail("the value is too small to be a heap limit in bytes");
  return value;
}

function childHeapLimit(flag, env = process.env){
  return parseHeapLimitProbe(spawnSync(process.execPath, [flag, "-e", HEAP_LIMIT_PROBE], {encoding: "utf8", env}));
}

test("4a: heap limit probe: abnormal child output is refused with the probe details, never turned into a number", () => {
  const ok = (stdout) => ({status: 0, signal: null, error: undefined, stdout, stderr: ""});
  assert.equal(parseHeapLimitProbe(ok("218103808")), 218103808);
  const refused = [
    ["empty stdout", ok(""), /not a plain decimal integer/],
    ["text", ok("heap"), /not a plain decimal integer/],
    ["number with text", ok("218103808 bytes"), /not a plain decimal integer/],
    ["coloured number (FORCE_COLOR, the Windows failure)", ok("\u001b[33m218103808\u001b[39m\n"), /not a plain decimal integer/],
    ["surrounding whitespace", ok(" 218103808\n"), /not a plain decimal integer/],
    ["zero", ok("0"), /not a plain decimal integer/],
    ["negative", ok("-218103808"), /not a plain decimal integer/],
    ["Infinity", ok("Infinity"), /not a plain decimal integer/],
    ["NaN", ok("NaN"), /not a plain decimal integer/],
    ["exponent", ok("2.1e8"), /not a plain decimal integer/],
    ["beyond safe integers", ok("9007199254740993"), /not a safe integer/],
    ["too small to be bytes (MiB)", ok("208"), /too small/],
    ["non-zero exit", {status: 1, signal: null, error: undefined, stdout: "218103808", stderr: "boom"}, /did not exit normally.*stderr="boom"/],
    ["killed by a signal", {status: null, signal: "SIGKILL", error: undefined, stdout: "", stderr: ""}, /did not exit normally.*signal=SIGKILL/],
    ["spawn error", {status: null, signal: null, error: new Error("spawn ENOENT"), stdout: null, stderr: null}, /could not be run.*spawn ENOENT/],
    ["stdout not text", {status: 0, signal: null, error: undefined, stdout: null, stderr: ""}, /stdout is not text/]
  ];
  for(const [label, probe, message] of refused){
    assert.throws(() => parseHeapLimitProbe(probe), message, label);
  }
  // The real probe gives the same plain number with FORCE_COLOR=1 as without
  // it, whether or not this test run is attached to a terminal.
  const plain = {...process.env};
  delete plain.FORCE_COLOR;
  const flag = "--max-old-space-size=16";
  assert.equal(childHeapLimit(flag, {...plain, FORCE_COLOR: "1"}), childHeapLimit(flag, plain));
});

test("4: CLI heap pre-check (child process, small heap): oversized input is refused with INSUFFICIENT_HEAP before it is read", (t) => {
  const flag = "--max-old-space-size=16";
  const heapLimit = childHeapLimit(flag);
  const directory = tempDir(t, "sos-opl-heap-");
  // Conservatively oversized: one MiB above what the estimate allows. The
  // first line is invalid on purpose: if the input were read at all, the run
  // would fail with OPL_UNKNOWN_TYPE instead, so INSUFFICIENT_HEAP proves the
  // check ran before reading (no timing or OS memory pressure involved).
  const size = Math.ceil(heapLimit / ESTIMATED_HEAP_BYTES_PER_OPL_BYTE) + 1024 * 1024;
  const file = path.join(directory, "big.opl");
  const filler = Buffer.alloc(size - 2, 0x0a);
  fs.writeFileSync(file, Buffer.concat([Buffer.from("x\n"), filler]));
  const out = path.join(directory, "out");
  const gates = writeJson(directory, "gates.json", GATES);
  const result = runCli(["--input", file, "--input-format", "opl", "--region", "KR", "--out", out, "--data-as-of", DATA_AS_OF, "--quality-gates", gates], {nodeFlags: [flag]});
  const error = cliError(result);
  assert.equal(error.code, "INSUFFICIENT_HEAP");
  assert.equal(error.details.inputBytes, size);
  assert.equal(error.details.heapLimitBytes, heapLimit);
  assert.equal(fs.existsSync(out), false, "no output directory");
  assert.deepEqual(listTree(directory), ["big.opl", "gates.json"], "no staging or partial output left behind");
  // Below the estimate the same child reads the input (and stops on line 1).
  const small = path.join(directory, "small.opl");
  fs.writeFileSync(small, "x\n");
  const read = runCli(["--input", small, "--input-format", "opl", "--region", "KR", "--out", out, "--data-as-of", DATA_AS_OF, "--quality-gates", gates], {nodeFlags: [flag]});
  assert.equal(cliError(read).code, "OPL_UNKNOWN_TYPE");
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(listTree(directory), ["big.opl", "gates.json", "small.opl"]);
});

test("5: geometry point budget: a facility expanding to more than MAX_GEOMETRY_POINTS points stops the build (GEOMETRY_TOO_LARGE)", (t) => {
  // Every node exists with a valid location inside a tiny box, so without the
  // budget this facility would resolve and be placed.
  const count = MAX_GEOMETRY_POINTS + 1;
  const lines = ["n900001 Tamenity=pharmacy,name=P x126.99 y37.56", "n900002 Tamenity=hospital,name=H x126.99 y37.561"];
  for(let id = 1; id <= count; id += 1) lines.push(`n${id} T x${encodeCoordinate(126.98 + (id % 100) * 0.000001)} y${encodeCoordinate(37.55 + Math.floor(id / 100) * 0.000001)}`);
  const refs = [];
  for(let id = 1; id <= count; id += 1) refs.push(`n${id}`);
  lines.push(`w10 Tamenity=hospital,name=Huge N${refs.join(",")}`);
  const text = lines.join("\n") + "\n";
  const elements = parseOplText(text).elements;
  const details = [];
  for(let round = 0; round < 2; round += 1){
    expectBuildError("REFERENTIAL_INTEGRITY_FAILED", () => build(elements), (d) => {
      assert.equal(d.objects[0].object, "way/10");
      assert.equal(d.objects[0].problems[0].code, "GEOMETRY_TOO_LARGE");
      details.push(JSON.stringify(d));
    });
  }
  assert.equal(details[0], details[1], "deterministic error details");
  // A relation over the budget through two member ways (60,000 + 60,000 points).
  const half = 60000;
  const relationElements = [
    {type: "node", id: 900001, lat: 37.56, lon: 126.99, tags: {amenity: "pharmacy", name: "P"}},
    {type: "node", id: 900002, lat: 37.561, lon: 126.99, tags: {amenity: "hospital", name: "H"}},
    {type: "node", id: 1, lat: 37.55, lon: 126.98},
    {type: "node", id: 2, lat: 37.5501, lon: 126.9801},
    {type: "way", id: 20, nodes: Array.from({length: half}, (_, index) => (index % 2) + 1)},
    {type: "way", id: 21, nodes: Array.from({length: half}, (_, index) => (index % 2) + 1)},
    {type: "relation", id: 30, members: [{type: "way", ref: 20, role: "outer"}, {type: "way", ref: 21, role: "outer"}], tags: {amenity: "hospital", name: "R"}}
  ];
  expectBuildError("REFERENTIAL_INTEGRITY_FAILED", () => build(relationElements), (d) => {
    assert.equal(d.objects[0].object, "relation/30");
    assert.equal(d.objects[0].problems[0].code, "GEOMETRY_TOO_LARGE");
  });
  // Through the CLI: complete failure, nothing written.
  const directory = tempDir(t, "sos-opl-budget-");
  const file = path.join(directory, "huge.opl");
  fs.writeFileSync(file, text);
  const out = path.join(directory, "out");
  const result = runCli(["--input", file, "--input-format", "opl", "--region", "KR", "--out", out, "--data-as-of", DATA_AS_OF, "--quality-gates", writeJson(directory, "gates.json", GATES)]);
  const error = cliError(result);
  assert.equal(error.code, "REFERENTIAL_INTEGRITY_FAILED");
  assert.equal(error.details.objects[0].problems[0].code, "GEOMETRY_TOO_LARGE");
  assert.equal(fs.existsSync(out), false);
});

test("6: OPL CLI output safety: inside-repository refusal, no overwrite, failed writes leave nothing, CRLF, JSON unchanged", (t) => {
  const directory = tempDir(t, "sos-opl-cli-safety-");
  const base = ["--input-format", "opl", "--region", "KR", "--data-as-of", DATA_AS_OF, "--quality-gates", FIXTURE_QUALITY_GATES_PATH];
  // Inside the repository, OPL format: refused before the input is read.
  const repoBefore = listTree(ROOT);
  for(const [out, cwd] of [["..audit-output", ROOT], [path.join(ROOT, "..audit-output"), os.tmpdir()], ["scripts/../..x", ROOT]]){
    const refused = runCli(["--input", path.join(directory, "missing.opl"), ...base, "--out", out], {cwd});
    assert.equal(cliError(refused).code, "OUTPUT_INSIDE_REPOSITORY", out);
  }
  assert.deepEqual(listTree(ROOT), repoBefore, "nothing written inside the repository");

  // Accepted OPL candidate, then OUTPUT_EXISTS on the same version.
  const out = path.join(directory, "out");
  const first = runCli(["--input", OPL_FIXTURE, ...base, "--out", out]);
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.contentSha256, S1_GOLDEN_CONTENT_SHA256);
  assert.equal(cliError(runCli(["--input", OPL_FIXTURE, ...base, "--out", out])).code, "OUTPUT_EXISTS");
  assert.deepEqual(fs.readdirSync(out), [summary.datasetVersionId]);

  // Windows CRLF copy of the fixture: same tiles.
  const crlf = path.join(directory, "crlf.opl");
  fs.writeFileSync(crlf, fs.readFileSync(OPL_FIXTURE, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
  const crlfRun = runCli(["--input", crlf, ...base, "--out", path.join(directory, "crlf-out")]);
  assert.equal(crlfRun.status, 0, crlfRun.stderr);
  assert.equal(JSON.parse(crlfRun.stdout).contentSha256, S1_GOLDEN_CONTENT_SHA256);

  // Failed writes of an OPL-built candidate: no version, no staging, and the
  // output root this call created is removed.
  const result = buildDataset({elements: parseOplText(fs.readFileSync(OPL_FIXTURE, "utf8")).elements}, {
    region: KR_REGION, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "opl", sourceFormat: "osm-opl",
    qualityGates: JSON.parse(fs.readFileSync(FIXTURE_QUALITY_GATES_PATH, "utf8"))
  });
  const nestedRoot = path.join(directory, "write-fail", "nested");
  for(const failAt of [1, 4, result.files.length]){
    let writes = 0;
    const failing = {...fs, writeFileSync: (...args) => {
      writes += 1;
      if(writes === failAt) throw Object.assign(new Error("ENOSPC: simulated"), {code: "ENOSPC"});
      return fs.writeFileSync(...args);
    }};
    assert.throws(() => writeDatasetVersion(result, nestedRoot, ROOT, failing), /ENOSPC/);
    assert.equal(fs.existsSync(path.join(directory, "write-fail")), false, `write ${failAt}: created root removed, no staging, no version`);
  }
  const renameFails = {...fs, renameSync: () => { throw Object.assign(new Error("EPERM: simulated"), {code: "EPERM"}); }};
  assert.throws(() => writeDatasetVersion(result, nestedRoot, ROOT, renameFails), /EPERM/);
  assert.equal(fs.existsSync(path.join(directory, "write-fail")), false);

  // JSON input path unchanged: same golden tiles with gates; without gates the
  // fail-closed rules still refuse to write.
  const json = runCli(["--input", FIXTURE_PATH, "--region", "KR", "--out", path.join(directory, "json"), "--quality-gates", FIXTURE_QUALITY_GATES_PATH]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).inputFormat, "json");
  assert.equal(JSON.parse(json.stdout).contentSha256, S1_GOLDEN_CONTENT_SHA256);
  const simple = writeJson(directory, "simple.json", {osm3s: {timestamp_osm_base: DATA_AS_OF}, elements: [
    {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "H"}},
    {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "P"}}
  ]});
  assert.equal(cliError(runCli(["--input", simple, "--region", "KR", "--out", path.join(directory, "nogates")])).code, "REQUIRED_GATE_NOT_CONFIGURED");
  assert.equal(fs.existsSync(path.join(directory, "nogates")), false);
});

const OUTSIDE = {type: "node", id: 50, lat: 37.24, lon: 131.86, tags: {amenity: "hospital", emergency: "yes", name: "Far east"}};
const INSIDE = [
  {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "H"}},
  {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "P"}}
];

test("7: risk A: an emergency-evidence hospital outside the data bounds stops the build unless acknowledged per object, and is then listed", (t) => {
  expectBuildError("EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS", () => build([...INSIDE, OUTSIDE]), (details) => {
    assert.deepEqual(details.objects, [{object: "node/50", reason: "outside_data_bounds", latitude: 37.24, longitude: 131.86}]);
  });
  // Non-emergency objects outside the bounds are still only counted (unchanged).
  const plain = build([...INSIDE, {...OUTSIDE, tags: {amenity: "hospital", name: "Far east"}}]);
  assert.equal(plain.report.rejected.byReason.outside_data_bounds.count, 1);
  assert.equal(plain.report.emergencyEvidenceExclusions.count, 0);
  assert.equal(plain.report.acceptance.emergencyEvidenceExclusions, 0);

  const reason = "Reviewed 2026-10-30: outside the KR data bounds; covered by the live search fallback.";
  const acknowledged = build([...INSIDE, OUTSIDE], {...GATES, acknowledgeEmergencyOutsideDataBounds: [{object: "node/50", reason}]});
  const expected = {count: 1, objects: [{object: "node/50", reason: "outside_data_bounds", latitude: 37.24, longitude: 131.86, acknowledgement: reason}]};
  assert.deepEqual({count: acknowledged.report.emergencyEvidenceExclusions.count, objects: acknowledged.report.emergencyEvidenceExclusions.objects}, expected);
  assert.deepEqual(acknowledged.manifest.emergencyEvidenceExclusions, expected);
  assert.ok(acknowledged.report.acceptance.pendingReview.includes("emergency_evidence_exclusions_review"));
  assert.ok(acknowledged.manifest.acceptance.pendingReview.includes("emergency_evidence_exclusions_review"));
  assert.equal(acknowledged.manifest.acceptance.publishable, false);
  const gate = acknowledged.report.gates.find((entry) => entry.id === "emergency_evidence_preserved");
  assert.deepEqual(gate.observed, {silentlyDropped: 0, acknowledgedOutsideDataBounds: 1});
  // The acknowledged candidate can be written, and the exclusion travels with it.
  const out = tempDir(t, "sos-ack-");
  const target = writeDatasetVersion(acknowledged, path.join(out, "v"), ROOT);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).emergencyEvidenceExclusions, expected);

  // Stale or malformed acknowledgements stop the build.
  expectBuildError("STALE_EMERGENCY_ACKNOWLEDGEMENT", () => build(INSIDE, {...GATES, acknowledgeEmergencyOutsideDataBounds: [{object: "node/50", reason}]}));
  expectBuildError("INVALID_QUALITY_GATES", () => build([...INSIDE, OUTSIDE], {...GATES, acknowledgeEmergencyOutsideDataBounds: [{object: "node/50", reason: "short"}]}));
  expectBuildError("INVALID_QUALITY_GATES", () => build([...INSIDE, OUTSIDE], {...GATES, acknowledgeEmergencyOutsideDataBounds: [{object: "node/50", reason}, {object: "node/50", reason}]}));
  expectBuildError("INVALID_QUALITY_GATES", () => build([...INSIDE, OUTSIDE], {...GATES, acknowledgeEmergencyOutsideDataBounds: "node/50"}));
});

test("8: risk B: oversized or unresolved emergency geometry always stops; neither allowance nor acknowledgement releases it", () => {
  const square = (first, latitude) => [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([a, b], index) => ({
    type: "node", id: first + index, lat: Math.round((latitude + a * 0.0002) * 1e7) / 1e7, lon: Math.round((126.98 + b * 0.0002) * 1e7) / 1e7
  }));
  const oversized = [
    ...INSIDE, ...square(100, 37.55), ...square(200, 37.61),
    {type: "way", id: 30, nodes: [100, 101, 102, 103, 100]},
    {type: "way", id: 31, nodes: [200, 201, 202, 203, 200]},
    {type: "relation", id: 40, members: [{type: "way", ref: 30, role: "outer"}, {type: "way", ref: 31, role: "outer"}], tags: {amenity: "hospital", emergency: "yes", name: "Big"}}
  ];
  const reason = "Reviewed: mapping error upstream, extent 0.06 degrees.";
  for(const gates of [GATES, {...GATES, allowIncompleteGeometry: [{object: "relation/40", reason}]}, {...GATES, acknowledgeEmergencyOutsideDataBounds: [{object: "relation/40", reason}]}]){
    expectBuildError("EMERGENCY_EVIDENCE_REJECTED", () => build(oversized, gates), (details) => {
      assert.equal(details.objects[0].object, "relation/40");
      assert.equal(details.objects[0].problems[0].code, "GEOMETRY_EXTENT_TOO_LARGE");
    });
  }
});
