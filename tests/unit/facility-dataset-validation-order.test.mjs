// S2-a v4 regression tests (independent review of v3, REQUEST CHANGES):
// an empty tag value (valid OSM, e.g. "name=") made the whole object
// "malformed_tags" BEFORE the safety checks ran, so
//   problem 1: an emergency hospital outside the data bounds and
//   problem 2: a hospital way with a missing node
// were dropped silently instead of stopping the build. v4 accepts empty values
// and checks scope, emergency evidence, position, referential integrity and
// data bounds BEFORE rejecting malformed tags. OPL and JSON input alike; the
// real client pipeline re-checks ordering and emergency preservation.
// Synthetic data only; no network.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildDataset, DatasetBuildError} from "../../scripts/facility-dataset/lib/generate.mjs";
import {parseOplText} from "../../scripts/facility-dataset/lib/opl.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {GENERATOR_DIR, fileMap, loadClientPipeline, loadLiveFunction, staticCandidates} from "./facility-dataset-helpers.mjs";
import {encodeOplString, encodeCoordinate} from "./facility-dataset-opl-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const CLI = path.join(GENERATOR_DIR, "build-dataset.mjs");
const DATA_AS_OF = "2026-10-20T00:00:00Z";
const GATES = {schemaVersion: "1", regionCode: "KR", maxRejectedRatio: 0.9};
const BASE_OPL = "n1 Tamenity=hospital,name=H x126.98 y37.55\nn2 Tamenity=pharmacy,name=P x126.981 y37.551\n";
const PROBLEM_1 = BASE_OPL + "n50 Tamenity=hospital,emergency=yes,name= x131.86 y37.24\n";
const PROBLEM_2 = BASE_OPL + "n3 T x126.98 y37.55\nw10 Tamenity=hospital,name= Nn3,n404\n";
const EMERGENCY = {emergencyContext: true};

function build(elements, gates = GATES){
  return buildDataset({elements}, {region: KR_REGION, generator: generatorInfo(), dataAsOf: DATA_AS_OF, sourceLabel: "validation-order", qualityGates: gates});
}

// The same objects as OPL-parsed elements and as JSON.parse output.
function bothInputs(oplText){
  const fromOpl = parseOplText(oplText).elements;
  return {opl: fromOpl, json: JSON.parse(JSON.stringify(fromOpl))};
}

function expectBuildError(code, fn, check){
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DatasetBuildError, String(error));
    assert.equal(error.code, code);
    if(check) check(error.details);
    return true;
  });
}

function tempDir(t, prefix){
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test("1: problem 1 (empty name, emergency hospital outside the data bounds) stops with EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS, OPL and JSON", () => {
  const inputs = bothInputs(PROBLEM_1);
  assert.equal(Object.getOwnPropertyDescriptor(inputs.opl.find((element) => element.id === 50).tags, "name").value, "");
  for(const [format, elements] of Object.entries(inputs)){
    expectBuildError("EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS", () => build(elements), (details) => {
      assert.deepEqual(details.objects, [{object: "node/50", reason: "outside_data_bounds", latitude: 37.24, longitude: 131.86}], format);
    });
  }
  // Acknowledged per object, it is excluded and listed (v3 policy unchanged).
  const reason = "Reviewed: outside the KR data bounds; live search fallback covers it.";
  const acknowledged = build(inputs.opl, {...GATES, acknowledgeEmergencyOutsideDataBounds: [{object: "node/50", reason}]});
  assert.deepEqual(acknowledged.manifest.emergencyEvidenceExclusions.objects.map((item) => [item.object, item.reason]), [["node/50", "outside_data_bounds"]]);
  assert.equal(acknowledged.report.rejected.byReason.malformed_tags.count, 0, "an empty value is not malformed");
});

test("2: problem 2 (empty name, hospital way referencing missing n404) stops with REFERENTIAL_INTEGRITY_FAILED, OPL and JSON", () => {
  for(const [format, elements] of Object.entries(bothInputs(PROBLEM_2))){
    expectBuildError("REFERENTIAL_INTEGRITY_FAILED", () => build(elements), (details) => {
      assert.deepEqual(details.objects.map((item) => [item.object, item.problems[0].code, item.problems[0].missingRef]), [["way/10", "MISSING_NODE", 404]], format);
    });
  }
});

test("3: both problems stop the CLI with nothing written (no version, no staging)", (t) => {
  const directory = tempDir(t, "sos-order-cli-");
  const gates = path.join(directory, "gates.json");
  fs.writeFileSync(gates, JSON.stringify(GATES));
  for(const [name, text, code] of [["p1.opl", PROBLEM_1, "EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS"], ["p2.opl", PROBLEM_2, "REFERENTIAL_INTEGRITY_FAILED"]]){
    const input = path.join(directory, name);
    fs.writeFileSync(input, text.replace(/\n/g, "\r\n"));
    const out = path.join(directory, `out-${name}`);
    const result = spawnSync(process.execPath, [CLI, "--input", input, "--input-format", "opl", "--region", "KR", "--out", out,
      "--data-as-of", DATA_AS_OF, "--quality-gates", gates], {encoding: "utf8"});
    assert.equal(result.status, 1, name);
    assert.equal(JSON.parse(result.stderr).code, code, name);
    assert.equal(fs.existsSync(out), false, `${name}: nothing written`);
  }
});

test("4: validation order matrix: malformed tags never hide integrity, bounds or emergency problems (OPL and JSON)", () => {
  const longValue = "가".repeat(256);
  // Tag defects that make an object's tags malformed, plus the valid empty value.
  const defects = {
    "empty value (valid)": (tags) => ({...tags, name: ""}),
    "empty key": (tags) => Object.assign({"": "x"}, tags),
    "value over 255 characters": (tags) => ({...tags, description: longValue})
  };
  const square = [
    {type: "node", id: 100, lat: 37.5498, lon: 126.9798}, {type: "node", id: 101, lat: 37.5498, lon: 126.9802},
    {type: "node", id: 102, lat: 37.5502, lon: 126.9802}, {type: "node", id: 103, lat: 37.5502, lon: 126.9798}
  ];
  const base = [
    {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "H"}},
    {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "P"}}
  ];
  const situations = [
    // [label, objects (tags supplied), expected code when the tags are malformed, expected code when only an empty value]
    ["emergency hospital outside the data bounds", (tags) => [{type: "node", id: 50, lat: 37.24, lon: 131.86, tags: {...tags, emergency: "yes"}}],
      "EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS", "EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS"],
    ["hospital way with a missing node", (tags) => [...square, {type: "way", id: 10, nodes: [100, 404], tags}],
      "REFERENTIAL_INTEGRITY_FAILED", "REFERENTIAL_INTEGRITY_FAILED"],
    ["emergency hospital way with a missing node", (tags) => [...square, {type: "way", id: 10, nodes: [100, 404], tags: {...tags, emergency: "yes"}}],
      "EMERGENCY_EVIDENCE_REJECTED", "EMERGENCY_EVIDENCE_REJECTED"],
    ["emergency hospital node with valid position", (tags) => [{type: "node", id: 60, lat: 37.552, lon: 126.982, tags: {...tags, emergency: "yes"}}],
      "EMERGENCY_EVIDENCE_REJECTED", null],
    ["plain hospital node with valid position", (tags) => [{type: "node", id: 61, lat: 37.552, lon: 126.982, tags}],
      null, null]
  ];
  for(const [defectName, defect] of Object.entries(defects)){
    const valid = defectName === "empty value (valid)";
    for(const [situation, objects, malformedCode, validCode] of situations){
      const elements = [...base, ...objects(defect({amenity: "hospital", name: "X"}))];
      const expected = valid ? validCode : malformedCode;
      for(const [format, input] of [["json", JSON.parse(JSON.stringify(elements))], ["object", elements]]){
        const label = `${situation} / ${defectName} / ${format}`;
        if(expected){
          expectBuildError(expected, () => build(input), (details) => {
            if(expected === "EMERGENCY_EVIDENCE_REJECTED" && situation === "emergency hospital node with valid position"){
              assert.deepEqual(details.objects, [{object: "node/60", reason: "malformed_tags"}], label);
            }
          });
        }else{
          const result = build(input);
          const malformed = result.report.rejected.byReason.malformed_tags.sample;
          assert.deepEqual(malformed, valid ? [] : ["node/61"], label);
        }
      }
    }
  }
  // The same through OPL text (empty key and over-long value are representable).
  const oplCases = [
    ["n50 T=x,amenity=hospital,emergency=yes x131.86 y37.24", "EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS"],
    [`n50 Tamenity=hospital,emergency=yes,description=${encodeOplString(longValue)} x131.86 y37.24`, "EMERGENCY_EVIDENCE_OUTSIDE_DATA_BOUNDS"],
    ["n3 T x126.98 y37.55\nw10 T=x,amenity=hospital Nn3,n404", "REFERENTIAL_INTEGRITY_FAILED"],
    ["n60 T=x,amenity=hospital,emergency=yes x126.982 y37.552", "EMERGENCY_EVIDENCE_REJECTED"]
  ];
  for(const [lines, code] of oplCases){
    expectBuildError(code, () => build(parseOplText(BASE_OPL + lines + "\n").elements));
  }
});

test("5: malformed objects (shape) with emergency evidence stop the build; without evidence they stay counted", () => {
  const base = [
    {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "H"}},
    {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "P"}},
    {type: "node", id: 3, lat: 37.55, lon: 126.98}
  ];
  expectBuildError("EMERGENCY_EVIDENCE_REJECTED", () => build([...base, {type: "way", id: 10, nodes: [3], tags: {amenity: "hospital", emergency: "yes"}}]), (details) => {
    assert.deepEqual(details.objects, [{object: "way/10", reason: "malformed_element"}]);
  });
  expectBuildError("EMERGENCY_EVIDENCE_REJECTED", () => build([...base, {type: "node", id: 11, lat: Number.NaN, lon: 126.98, tags: {amenity: "hospital", emergency: "yes"}}]));
  const counted = build([...base, {type: "way", id: 10, nodes: [3], tags: {amenity: "hospital"}}]);
  assert.deepEqual(counted.report.rejected.byReason.malformed_element.sample, ["way/10"]);
  // A non-string selector value cannot be identified as a facility: counted (JSON only; OPL values are strings).
  const unidentifiable = build([...base, {type: "node", id: 12, lat: 37.55, lon: 126.98, tags: {amenity: 5, emergency: "yes"}}]);
  assert.deepEqual(unidentifiable.report.rejected.byReason.malformed_tags.sample, ["node/12"]);
});

function squareLines(wayId, firstNodeId, latitude, longitude, tagText){
  const nodes = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([a, b], index) =>
    `n${firstNodeId + index} T x${encodeCoordinate(longitude + b * 0.0002)} y${encodeCoordinate(latitude + a * 0.0002)}`);
  const refs = [0, 1, 2, 3, 0].map((offset) => `n${firstNodeId + offset}`).join(",");
  return [...nodes, `w${wayId} T${tagText} N${refs}`];
}

test("6: empty values through the REAL client: emergency hospital way kept over a clinic node, pharmacy node kept, same as the live Function for pharmacy", async () => {
  const client = loadClientPipeline();
  const text = [
    "n1 Tamenity=clinic,name= x126.98 y37.55",
    `n2 Tamenity=pharmacy,name=,phone=010-1111-1111,opening_hours=${encodeOplString("Mo-Fr 09:00-18:00")} x126.98 y37.55`,
    ...squareLines(11, 1001, 37.55, 126.98, "amenity=hospital,emergency=yes,name="),
    ...squareLines(12, 2001, 37.55, 126.98, "amenity=pharmacy,healthcare=hospital,emergency=yes,name=,phone=010-2222-2222,opening_hours=closed")
  ].join("\r\n") + "\r\n";
  const base = {latitude: 37.5503, longitude: 126.9803};
  for(const [format, elements] of Object.entries(bothInputs(text))){
    const result = build(elements);
    assert.equal(result.report.rejected.byReason.malformed_tags.count, 0, format);
    for(const recommendation of [null, EMERGENCY]){
      const hospitals = client.run(staticCandidates(result, "hospital", base.latitude, base.longitude, 5000), "hospital", base, recommendation);
      assert.equal(hospitals[0].id, "hospital-way-11", `${format} hospital emergency=${!!recommendation}`);
      assert.equal(hospitals[0].emergencyCareConfirmed, true);
      assert.equal(hospitals[0].nameMissing, true, "empty name is treated as no name, as by the live Function");
      assert.equal(hospitals.some((facility) => facility.id === "hospital-node-1"), false);
      const pharmacies = client.run(staticCandidates(result, "pharmacy", base.latitude, base.longitude, 5000), "pharmacy", base, recommendation);
      assert.deepEqual(pharmacies.map((facility) => [facility.id, facility.phone, facility.openingHours, facility.emergencyCareConfirmed]),
        [["pharmacy-node-2", "010-1111-1111", "Mo-Fr 09:00-18:00", false]], `${format} pharmacy`);
    }
    // Tags preserved verbatim, empty values included; nothing added.
    const records = new Map(["hospital", "pharmacy"].flatMap((type) => result.manifest.tiles[type].flatMap((entry) =>
      JSON.parse(fileMap(result).get(entry.path).bytes.toString("utf8")).elements)).map((record) => [`${record.type}/${record.id}`, record]));
    assert.deepEqual(records.get("node/2").tags, {amenity: "pharmacy", name: "", opening_hours: "Mo-Fr 09:00-18:00", phone: "010-1111-1111"});
    assert.deepEqual(records.get("way/11").tags, {amenity: "hospital", emergency: "yes", name: ""});
    // Pharmacy: identical to the live Function on the same objects.
    const universe = result.manifest.tiles.pharmacy.flatMap((entry) => JSON.parse(fileMap(result).get(entry.path).bytes.toString("utf8")).elements);
    const live = await loadLiveFunction(universe).search("pharmacy", base.latitude, base.longitude);
    assert.deepEqual(client.run(live.elements, "pharmacy", base, null), client.run(staticCandidates(result, "pharmacy", base.latitude, base.longitude, 5000), "pharmacy", base, null));
  }
});
