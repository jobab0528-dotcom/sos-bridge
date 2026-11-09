// S2-a v2 regression tests for the independent review (REQUEST CHANGES):
// FINDING 1 (missing referenced objects still produced an ok candidate),
// FINDING 2 (missing sub-relations were ignored), the gate statuses, atomic
// output and the tile-size stop (FINDING 4). Synthetic data only.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildDataset, DatasetBuildError} from "../../scripts/facility-dataset/lib/generate.mjs";
import {MAX_RELATION_DEPTH} from "../../scripts/facility-dataset/lib/integrity.mjs";
import {writeDatasetVersion, STAGING_PREFIX} from "../../scripts/facility-dataset/lib/write-output.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {parseOplText} from "../../scripts/facility-dataset/lib/opl.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {ROOT, GENERATOR_DIR, FIXTURE_PATH, fileMap, seededRandom, shuffled} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const CLI = path.join(GENERATOR_DIR, "build-dataset.mjs");
const DATA_AS_OF = "2026-10-20T00:00:00Z";
const GATES = {schemaVersion: "1", regionCode: "KR", maxRejectedRatio: 0.5};
const HOSPITAL = {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "H"}};
const PHARMACY = {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "P"}};

function build(elements, extra = {}){
  return buildDataset({elements: [HOSPITAL, PHARMACY, ...elements]}, {
    region: KR_REGION, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "integrity-test", qualityGates: GATES, ...extra
  });
}

function expectCode(code, fn, check){
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DatasetBuildError, String(error));
    assert.equal(error.code, code);
    if(check) check(error.details);
    return true;
  });
}

function problems(details){
  return details.objects.map((item) => [item.object, ...item.problems.map((problem) => `${problem.code} ${problem.missingType}/${problem.missingRef}`)]);
}

function square(firstNodeId, latitude, longitude, half = 0.0002){
  return [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([a, b], index) => ({
    type: "node", id: firstNodeId + index, lat: Math.round((latitude + a * half) * 1e7) / 1e7, lon: Math.round((longitude + b * half) * 1e7) / 1e7
  }));
}

function way(id, nodes, tags){
  const element = {type: "way", id, nodes};
  if(tags) element.tags = tags;
  return element;
}

function relation(id, members, tags){
  const element = {type: "relation", id, members: members.map(([type, ref, role = ""]) => ({type, ref, role}))};
  if(tags) element.tags = tags;
  return element;
}

function tempDir(t, prefix){
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function runCli(args){
  return spawnSync(process.execPath, [CLI, ...args], {encoding: "utf8"});
}

function writeJson(directory, name, value){
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("1: FINDING 1 (missing node): the reviewed case stops with a structured error and writes nothing", (t) => {
  const reviewed = [{type: "node", id: 101, lat: 37.56, lon: 126.99}, way(10, [101, 404], {amenity: "hospital", name: "W10"})];
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => build(reviewed), (details) => {
    assert.equal(details.objectCount, 1);
    assert.equal(details.problemCountByCode.MISSING_NODE, 1);
    assert.deepEqual(details.objects, [{
      object: "way/10", facilityTypes: ["hospital"], problemCount: 1,
      problems: [{code: "MISSING_NODE", missingType: "node", missingRef: 404, via: ["way/10"]}]
    }]);
    assert.equal(details.allowedExclusionCount, 0);
  });
  // Same through the CLI, with gates configured: exit 1, nothing on disk.
  const directory = tempDir(t, "sos-integrity-f1-");
  const input = writeJson(directory, "f1.json", {osm3s: {timestamp_osm_base: DATA_AS_OF}, elements: [HOSPITAL, PHARMACY, ...reviewed]});
  const gates = writeJson(directory, "gates.json", GATES);
  const out = path.join(directory, "out");
  const result = runCli(["--input", input, "--region", "KR", "--out", out, "--quality-gates", gates]);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.code, "REFERENTIAL_INTEGRITY_FAILED");
  assert.equal(error.details.objects[0].problems[0].missingRef, 404);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(out), false, "no candidate and no staging directory");
});

test("2: missing way, node without a valid location and malformed referenced objects are unresolvable, never skipped", () => {
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => build([
    ...square(500, 37.56, 126.99),
    way(50, [500, 501, 502, 503, 500]),
    relation(60, [["way", 50, "outer"], ["way", 51, "outer"]], {amenity: "hospital", type: "multipolygon"}),
    {type: "node", id: 700, lat: 95, lon: 126.99},
    way(70, [500, 700, 501], {amenity: "clinic"}),
    way(80, [500]),
    relation(81, [["way", 80, "outer"]], {amenity: "hospital"}),
    relation(82, [], {amenity: "hospital"})
  ]), (details) => {
    assert.deepEqual(problems(details), [
      ["relation/60", "MISSING_WAY way/51"],
      ["relation/81", "MALFORMED_REFERENCED_OBJECT way/80"],
      ["relation/82", "EMPTY_RELATION relation/82"],
      ["way/70", "NODE_WITHOUT_VALID_LOCATION node/700"]
    ]);
  });
});

test("3: FINDING 2 (missing sub-relation): r40 = w30@outer + r404@outer stops the build", (t) => {
  const reviewed = [
    {type: "node", id: 301, lat: 37.57, lon: 126.97}, {type: "node", id: 302, lat: 37.571, lon: 126.971}, {type: "node", id: 303, lat: 37.571, lon: 126.97},
    way(30, [301, 302, 303, 301]),
    relation(40, [["way", 30, "outer"], ["relation", 404, "outer"]], {type: "multipolygon", amenity: "hospital", name: "R40"})
  ];
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => build(reviewed), (details) => {
    assert.deepEqual(problems(details), [["relation/40", "MISSING_RELATION relation/404"]]);
  });
  // Through OPL text exactly as in the review.
  const opl = parseOplText([
    "n1 Tamenity=hospital,name=H x126.98 y37.55",
    "n2 Tamenity=pharmacy,name=P x126.981 y37.551",
    "n301 T x126.97 y37.57", "n302 T x126.971 y37.571", "n303 T x126.97 y37.571",
    "w30 T Nn301,n302,n303,n301",
    "r40 Ttype=multipolygon,amenity=hospital,name=R40 Mw30@outer,r404@outer"
  ].join("\n")).elements;
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => buildDataset({elements: opl}, {
    region: KR_REGION, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "x", qualityGates: GATES
  }), (details) => assert.equal(details.objects[0].problems[0].missingRef, 404));
  // CLI: nothing written.
  const directory = tempDir(t, "sos-integrity-f2-");
  const input = path.join(directory, "f2.opl");
  fs.writeFileSync(input, "n1 Tamenity=hospital x126.98 y37.55\nn2 Tamenity=pharmacy x126.981 y37.551\nn301 T x126.97 y37.57\nn302 T x126.971 y37.571\nw30 T Nn301,n302\nr40 Tamenity=hospital Mw30@outer,r404@outer\n");
  const out = path.join(directory, "out");
  const result = runCli(["--input", input, "--input-format", "opl", "--data-as-of", DATA_AS_OF, "--region", "KR", "--out", out, "--quality-gates", writeJson(directory, "g.json", GATES)]);
  assert.equal(JSON.parse(result.stderr).code, "REFERENTIAL_INTEGRITY_FAILED");
  assert.equal(fs.existsSync(out), false);
});

test("4: relation cycles, excessive nesting and duplicate references are handled safely", () => {
  const nodes = square(500, 37.56, 126.99);
  const ring = way(50, [500, 501, 502, 503, 500]);
  // r1 -> r2 -> r1 cycle, and a self reference.
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => build([
    ...nodes, ring,
    relation(1001, [["way", 50], ["relation", 1002]], {amenity: "hospital"}),
    relation(1002, [["relation", 1001]]),
    relation(1003, [["way", 50], ["relation", 1003]], {amenity: "clinic"})
  ]), (details) => {
    assert.deepEqual(details.objects.map((item) => [item.object, item.problems[0].code, item.problems[0].via]), [
      ["relation/1001", "RELATION_CYCLE", ["relation/1001", "relation/1002", "relation/1001"]],
      ["relation/1003", "RELATION_CYCLE", ["relation/1003", "relation/1003"]]
    ]);
  });
  // A chain exactly MAX_RELATION_DEPTH deep resolves; one more level is refused.
  const chain = (depth, firstId) => {
    const relations = [];
    for(let level = 0; level < depth; level += 1){
      relations.push(relation(firstId + level, [level === depth - 1 ? ["way", 50] : ["relation", firstId + level + 1]], level === 0 ? {amenity: "hospital"} : undefined));
    }
    return relations;
  };
  const ok = build([...nodes, ring, ...chain(MAX_RELATION_DEPTH + 1, 2000)]);
  assert.equal(ok.report.geometry.maxRelationDepthSeen, MAX_RELATION_DEPTH);
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => build([...nodes, ring, ...chain(MAX_RELATION_DEPTH + 2, 3000)]),
    (details) => assert.equal(details.objects[0].problems[0].code, "RELATION_DEPTH_EXCEEDED"));
  // Duplicate member references (legal in OSM) do not change the result and are counted.
  const plain = build([...nodes, ring, relation(4000, [["way", 50, "outer"]], {amenity: "hospital"})]);
  const duplicated = build([...nodes, ring, relation(4000, [["way", 50, "outer"], ["way", 50, "outer"], ["node", 500], ["node", 500]], {amenity: "hospital"})]);
  const center = (result) => JSON.parse(fileMap(result).get(result.manifest.tiles.hospital[0].path).bytes.toString("utf8")).elements.find((e) => e.id === 4000).center;
  assert.deepEqual(center(duplicated), center(plain));
  assert.equal(duplicated.report.geometry.duplicateMemberReferences, 2);
});

test("5: valid nested multi-relations still resolve to the full bounding-box center, deterministically", () => {
  const elements = [
    ...square(500, 37.560, 126.990), ...square(510, 37.562, 126.994),
    way(50, [500, 501, 502, 503, 500]), way(51, [510, 511, 512, 513, 510]),
    relation(60, [["way", 50, "outer"]], {type: "multipolygon", building: "hospital"}),
    relation(61, [["way", 51, "outer"]], {type: "multipolygon", building: "hospital"}),
    // A site relation over two multipolygons, one of them listed twice via a shared child.
    relation(70, [["relation", 60, ""], ["relation", 61, ""], ["node", 500, "entrance"]], {type: "site", amenity: "hospital", emergency: "yes", name: "Site"}),
    relation(71, [["relation", 60, ""], ["relation", 60, ""]], {amenity: "clinic", name: "Shared"})
  ];
  const first = build(elements);
  const records = JSON.parse(fileMap(first).get(first.manifest.tiles.hospital[0].path).bytes.toString("utf8")).elements;
  assert.deepEqual(records.find((record) => record.id === 70).center, {lat: 37.561, lon: 126.992});
  assert.deepEqual(records.find((record) => record.id === 71).center, {lat: 37.56, lon: 126.99});
  assert.equal(first.report.geometry.relationFacilities, 2);
  assert.equal(first.report.geometry.maxRelationDepthSeen, 1);
  for(const seed of [11, 12]){
    const again = build(shuffled(elements, seededRandom(seed)));
    assert.deepEqual(again.files.map((file) => file.sha256), first.files.map((file) => file.sha256));
  }
});

test("6: an outline wider than one facility can be (bad member) is refused instead of misplacing the center", () => {
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => build([
    {type: "node", id: 900, lat: 37.55, lon: 126.98}, {type: "node", id: 901, lat: 37.75, lon: 126.98},
    way(90, [900, 901], {amenity: "hospital"})
  ]), (details) => {
    assert.equal(details.objects[0].problems[0].code, "GEOMETRY_EXTENT_TOO_LARGE");
    assert.deepEqual(details.objects[0].problems[0].extentE7, {lat: 2000000, lon: 0});
  });
});

test("7: an explicit allowance excludes only the named object, with its reason; stale or invalid allowances stop the build", () => {
  const broken = [{type: "node", id: 101, lat: 37.56, lon: 126.99}, way(10, [101, 404], {amenity: "clinic", name: "W10"})];
  const reason = "Verified upstream mapping error, reported to OSM; excluded until fixed.";
  const allowed = build(broken, {qualityGates: {...GATES, allowIncompleteGeometry: [{object: "way/10", reason}]}});
  assert.equal(allowed.report.acceptance.status, "BUILD_GATES_PASSED");
  assert.equal(allowed.report.integrity.allowedExclusionCount, 1);
  assert.deepEqual(allowed.report.integrity.allowedExclusions[0], {
    object: "way/10", facilityTypes: ["hospital"], problemCount: 1, reason,
    problems: [{code: "MISSING_NODE", missingType: "node", missingRef: 404, via: ["way/10"]}]
  });
  assert.deepEqual(allowed.report.rejected.byReason.incomplete_geometry, {count: 1, sample: ["way/10"]});
  assert.equal(allowed.report.gates.find((entry) => entry.id === "referential_integrity").observed.allowedExclusions, 1);
  const ids = allowed.manifest.tiles.hospital.flatMap((tile) => JSON.parse(fileMap(allowed).get(tile.path).bytes.toString("utf8")).elements.map((e) => e.id));
  assert.equal(ids.includes(10), false, "allowed objects are excluded, never placed approximately");

  expectCode("STALE_GEOMETRY_ALLOWANCE", () => build([], {qualityGates: {...GATES, allowIncompleteGeometry: [{object: "way/10", reason}]}}),
    (details) => assert.deepEqual(details.objects, ["way/10"]));
  const invalid = [
    {...GATES, extra: 1},
    {...GATES, regionCode: "JP"},
    {...GATES, schemaVersion: "2"},
    {...GATES, maxRejectedRatio: 1.5},
    {...GATES, allowIncompleteGeometry: [{object: "way/10", reason: "short"}]},
    {...GATES, allowIncompleteGeometry: [{object: "node/1", reason}]},
    {...GATES, allowIncompleteGeometry: [{object: "way/10", reason}, {object: "way/10", reason}]},
    {...GATES, allowIncompleteGeometry: [{object: "way/10", reason, note: "x"}]},
    {...GATES, allowIncompleteGeometry: [{object: "way/*", reason}]},
    []
  ];
  for(const qualityGates of invalid) expectCode("INVALID_QUALITY_GATES", () => build(broken, {qualityGates}));
});

test("8: hospital emergency evidence is never dropped silently, even with an allowance", () => {
  expectCode("EMERGENCY_EVIDENCE_REJECTED", () => build([
    {type: "node", id: 300, lat: 95, lon: 126.98, tags: {amenity: "hospital", emergency: "yes", name: "E"}}
  ]), (details) => assert.deepEqual(details.objects, [{object: "node/300", reason: "invalid_coordinates"}]));
  const broken = [{type: "node", id: 101, lat: 37.56, lon: 126.99}, way(10, [101, 404], {amenity: "hospital", "emergency:department": "yes"})];
  expectCode("EMERGENCY_EVIDENCE_REJECTED",
    () => build(broken, {qualityGates: {...GATES, allowIncompleteGeometry: [{object: "way/10", reason: "Attempt to exclude an emergency hospital."}]}}),
    (details) => {
      assert.deepEqual(details.allowanceRefused, ["way/10"]);
      assert.equal(details.objects[0].problems[0].code, "MISSING_NODE");
    });
  // A hospital explicitly tagged emergency=no carries no emergency evidence:
  // invalid coordinates are a counted rejection (S1 behaviour).
  const counted = build([{type: "node", id: 301, lat: 95, lon: 126.98, tags: {amenity: "hospital", emergency: "no"}}]);
  assert.deepEqual(counted.report.rejected.byReason.invalid_coordinates.sample, ["node/301"]);
});

test("9: unconfigured gates are NOT_CONFIGURED (never PASSED) and the candidate is not accepted", (t) => {
  const result = build([], {qualityGates: undefined});
  const byId = Object.fromEntries(result.report.gates.map((entry) => [entry.id, entry]));
  assert.equal(byId.max_rejected_ratio.status, "NOT_CONFIGURED");
  assert.equal(byId.max_rejected_ratio.threshold, null);
  for(const entry of result.report.gates){
    if(entry.status === "PASSED") assert.notEqual(entry.threshold, null, `${entry.id} PASSED without a threshold`);
  }
  for(const id of ["service_area_review", "count_delta_vs_previous_version", "known_facility_sample", "nonmedical_contamination_sample"]){
    assert.equal(byId[id].status, "PENDING_REVIEW", id);
    assert.equal(byId[id].stage, "publish");
  }
  assert.deepEqual(result.report.acceptance.notConfigured, ["max_rejected_ratio"]);
  assert.equal(result.report.acceptance.status, "NOT_ACCEPTED");
  assert.equal(result.manifest.acceptance.status, "NOT_ACCEPTED");
  assert.equal(result.manifest.acceptance.publishable, false);
  assert.equal(result.manifest.status, "candidate");

  // The writer refuses it before creating anything.
  const directory = tempDir(t, "sos-integrity-gates-");
  const out = path.join(directory, "out");
  expectCode("REQUIRED_GATE_NOT_CONFIGURED", () => writeDatasetVersion(result, out, ROOT), (details) => assert.deepEqual(details.notConfigured, ["max_rejected_ratio"]));
  assert.equal(fs.existsSync(out), false);
  // The CLI without --quality-gates: exit 1, nothing written, even for clean input.
  const input = writeJson(directory, "clean.json", {osm3s: {timestamp_osm_base: DATA_AS_OF}, elements: [HOSPITAL, PHARMACY]});
  const cli = runCli(["--input", input, "--region", "KR", "--out", out]);
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stderr).code, "REQUIRED_GATE_NOT_CONFIGURED");
  assert.equal(fs.existsSync(out), false);

  // Configured and exceeded: the build stops.
  expectCode("QUALITY_GATE_FAILED", () => build([{type: "node", id: 9, lat: 95, lon: 0, tags: {amenity: "hospital"}}], {qualityGates: {...GATES, maxRejectedRatio: 0}}),
    (details) => assert.equal(details.gates.find((entry) => entry.id === "max_rejected_ratio").status, "FAILED"));
  // Configured and met: every build gate PASSED, publish gates still pending.
  const accepted = build([]);
  assert.equal(accepted.report.acceptance.status, "BUILD_GATES_PASSED");
  assert.deepEqual(accepted.report.gates.filter((entry) => entry.stage === "build").map((entry) => entry.status), Array(8).fill("PASSED"));
  assert.equal(accepted.report.acceptance.publishable, false);
});

test("10: a failure while writing leaves no version, no staging directory and no directory this run created", (t) => {
  const result = build([]);
  const directory = tempDir(t, "sos-integrity-write-");
  // Out root created by this run: removed again.
  let writes = 0;
  const failing = {...fs, writeFileSync(...args){ writes += 1; if(writes === 3) throw Object.assign(new Error("disk full (injected)"), {code: "ENOSPC"}); return fs.writeFileSync(...args); }};
  const fresh = path.join(directory, "fresh", "nested");
  assert.throws(() => writeDatasetVersion(result, fresh, ROOT, failing), /disk full/);
  assert.equal(fs.existsSync(path.join(directory, "fresh")), false);
  // Existing out root: kept, but empty.
  const existing = path.join(directory, "existing");
  fs.mkdirSync(existing);
  writes = 0;
  assert.throws(() => writeDatasetVersion(result, existing, ROOT, failing), /disk full/);
  assert.deepEqual(fs.readdirSync(existing), []);
  // Read-back verification: a file that changed on disk stops the run.
  const corrupting = {...fs, readFileSync(file, ...rest){ const bytes = fs.readFileSync(file, ...rest); return file.endsWith("manifest.json") ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes; }};
  expectCode("OUTPUT_VERIFY_FAILED", () => writeDatasetVersion(result, existing, ROOT, corrupting));
  assert.deepEqual(fs.readdirSync(existing), []);
  // A normal write produces exactly the version directory.
  const target = writeDatasetVersion(result, existing, ROOT);
  assert.deepEqual(fs.readdirSync(existing), [result.datasetVersionId]);
  assert.equal(fs.readdirSync(existing).some((name) => name.startsWith(STAGING_PREFIX)), false);
  assert.equal(fs.readFileSync(path.join(target, "manifest.json")).equals(fileMap(result).get("manifest.json").bytes), true);
});

test("11: FINDING 4 stays fail-closed: 5,000 hospitals in one 0.25 degree tile stop the build with nothing written", (t) => {
  const many = [];
  for(let index = 0; index < 5000; index += 1){
    many.push({type: "node", id: 10000 + index, lat: 37.51 + (index % 100) * 0.002, lon: 126.76 + Math.floor(index / 100) * 0.004,
      tags: {amenity: "hospital", name: `Synthetic Hospital ${index}`, phone: "+82-2-000-0000"}});
  }
  expectCode("TILE_TOO_LARGE", () => build(many), (details) => {
    assert.equal(details.tileId, "510_1227");
    assert.ok(details.bytes > KR_REGION.tileMaxBytes);
  });
  const directory = tempDir(t, "sos-integrity-tile-");
  const input = writeJson(directory, "dense.json", {osm3s: {timestamp_osm_base: DATA_AS_OF}, elements: [PHARMACY, ...many]});
  const out = path.join(directory, "out");
  const result = runCli(["--input", input, "--region", "KR", "--out", out, "--quality-gates", writeJson(directory, "g.json", GATES)]);
  assert.equal(JSON.parse(result.stderr).code, "TILE_TOO_LARGE");
  assert.equal(fs.existsSync(out), false);
});

test("12: the synthetic fixture needs its explicit allowance: without it the real fail-closed default applies", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  expectCode("REFERENTIAL_INTEGRITY_FAILED", () => buildDataset(fixture, {region: KR_REGION, generator: generatorInfo(), sourceLabel: "x"}),
    (details) => assert.deepEqual(problems(details), [["way/2003", "MISSING_NODE node/9999"]]));
});
