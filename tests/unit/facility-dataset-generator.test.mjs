// Unit tests: scripts/facility-dataset generator (S1, synthetic fixture only).

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildDataset, DatasetBuildError, LICENSE, REJECTION_REASONS} from "../../scripts/facility-dataset/lib/generate.mjs";
import {canonicalJson, canonicalJsonBytes, sha256Hex} from "../../scripts/facility-dataset/lib/canonical-json.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {
  ROOT,
  FIXTURE_PATH,
  GENERATOR_DIR,
  loadFixture,
  buildFixture,
  fileMap,
  tileDocument,
  seededRandom,
  shuffled
} from "./facility-dataset-helpers.mjs";

// Pinned: changes only when the fixture, the tile format or the tile element
// order changes on purpose (v2: evidence-first order).
const GOLDEN_CONTENT_SHA256 = "f50b7d279b628e6e0a06e06073c9afcf6455de8996df27f486d6ea1327887016";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

function build(input, options = {}){
  return buildDataset(input, {region: KR_REGION, generator: generatorInfo(), sourceLabel: "unit", ...options});
}

function expectBuildError(code, fn){
  assert.throws(fn, (error) => error instanceof DatasetBuildError && error.code === code, code);
}

const HOSPITAL_NODE = {type: "node", id: 1, lat: 37.55, lon: 126.98, tags: {amenity: "hospital", name: "A"}};
const PHARMACY_NODE = {type: "node", id: 2, lat: 37.551, lon: 126.981, tags: {amenity: "pharmacy", name: "B"}};
const DATA_AS_OF = {dataAsOf: "2026-10-20T00:00:00Z"};

test("1: fixture report counts every accepted, excluded, duplicate and rejected object exactly", () => {
  const {report, manifest} = buildFixture();
  assert.deepEqual(report.input, {
    elementCount: 38,
    uniqueElementCount: 35,
    byType: {node: 31, way: 3, relation: 1},
    untaggedElementCount: 10,
    duplicateIdenticalCount: 1,
    duplicateIdenticalSample: ["node/8"]
  });
  assert.deepEqual(report.accepted, {
    hospital: 14, pharmacy: 3, inBothTypes: 1, hospitalCoreScope: 12, hospitalExtendedOnlyScope: 2,
    osmEmergencyTagPresent: {hospital: 4, pharmacy: 0}
  });
  assert.deepEqual(report.excluded, {outOfSelectorScope: 3});
  assert.equal(report.rejected.total, 8);
  assert.deepEqual(Object.fromEntries(Object.entries(report.rejected.byReason).map(([reason, value]) => [reason, value.sample])), {
    incomplete_geometry: ["way/2003"],
    invalid_coordinates: ["node/11", "node/12"],
    malformed_element: ["area/5", "node/-3"],
    malformed_tags: ["node/13", "node/21"],
    outside_data_bounds: ["node/18"]
  });
  assert.deepEqual(Object.keys(report.rejected.byReason), [...REJECTION_REASONS]);
  assert.deepEqual(manifest.counts, {hospital: 14, pharmacy: 3});
  assert.equal(report.tags.droppedTagEntryCount, 4);
});

test("2: invalid or missing coordinates, malformed tags and malformed elements never reach a tile", () => {
  const result = buildFixture();
  const ids = new Set();
  for(const type of ["hospital", "pharmacy"]){
    for(const entry of result.manifest.tiles[type]){
      for(const element of tileDocument(result, entry.path).elements) ids.add(`${element.type}/${element.id}`);
    }
  }
  for(const rejected of ["node/11", "node/12", "node/13", "node/21", "node/18", "way/2003", "area/5", "node/-3"]){
    assert.equal(ids.has(rejected), false, rejected);
  }
  // Bad values are counted rejections, not crashes. NaN cannot occur in JSON
  // input; a programmatic NaN fails canonical serialization (malformed element).
  const report = build({elements: [
    HOSPITAL_NODE, PHARMACY_NODE,
    {type: "node", id: 3, lat: Number.NaN, lon: 126.98, tags: {amenity: "hospital"}},
    {type: "node", id: 4, lat: "37.5", lon: 126.98, tags: {amenity: "hospital"}},
    {type: "node", id: 5, lat: 37.5, lon: 181, tags: {amenity: "hospital"}},
    {type: "node", id: 6, lat: 37.5, lon: 126.9, tags: {amenity: "hospital", name: ""}},
    {type: "node", id: 7, lat: 37.5, lon: 126.9, tags: ["amenity", "hospital"]},
    {type: "way", id: 8, nodes: [1], tags: {amenity: "hospital"}},
    {type: "relation", id: 9, members: [{type: "node"}], tags: {amenity: "hospital"}},
    null, 42, "node"
  ]}, DATA_AS_OF).report;
  assert.deepEqual(report.rejected.byReason.invalid_coordinates.sample, ["node/4", "node/5"]);
  assert.deepEqual(report.rejected.byReason.malformed_tags.sample, ["node/6", "node/7"]);
  assert.equal(report.rejected.byReason.malformed_element.count, 6, "3 labelled + null, 42 and a string");
  assert.deepEqual(report.rejected.byReason.malformed_element.sample, ["node/3", "relation/9", "way/8"]);
});

test("3: clearly non-medical objects outside the Function selectors are excluded; in-scope look-alikes keep raw tags for the client filters", () => {
  const result = buildFixture();
  const hospital = tileDocument(result, "hospital/510_1227.json").elements;
  const names = hospital.map((element) => element.tags.name);
  assert.equal(names.includes("테스트 식당"), false, "restaurant is out of selector scope");
  assert.equal(names.includes("테스트 치과"), false, "dentist is outside the Function hospital selectors");
  assert.equal(names.includes("테스트 대문자 태그"), false, "Overpass value matching is case-sensitive");
  // In selector scope, so the live Function would return them too; the client
  // pipeline removes them (proven in facility-dataset-contract.test.mjs).
  const carRepair = hospital.find((element) => element.id === 5);
  assert.deepEqual(carRepair.tags, {healthcare: "clinic", name: "테스트 자동차 병원", shop: "car_repair"});
  assert.ok(hospital.some((element) => element.tags.name === "테스트 장례식장"));
});

test("4: identical duplicate object IDs collapse; conflicting duplicates stop the build", () => {
  const result = build({elements: [HOSPITAL_NODE, PHARMACY_NODE, structuredClone(HOSPITAL_NODE)]}, DATA_AS_OF);
  assert.equal(result.report.input.duplicateIdenticalCount, 1);
  assert.equal(result.manifest.counts.hospital, 1);
  expectBuildError("DUPLICATE_ID_CONFLICT", () => build({elements: [
    HOSPITAL_NODE, PHARMACY_NODE, {...HOSPITAL_NODE, tags: {amenity: "hospital", name: "changed"}}
  ]}, DATA_AS_OF));
  // The same numeric id on different OSM types is not a duplicate.
  const mixed = build({elements: [
    HOSPITAL_NODE, PHARMACY_NODE,
    {type: "node", id: 100, lat: 37.55, lon: 126.98},
    {type: "node", id: 101, lat: 37.551, lon: 126.981},
    {type: "way", id: 1, nodes: [100, 101], tags: {amenity: "clinic"}}
  ]}, DATA_AS_OF);
  assert.equal(mixed.manifest.counts.hospital, 2);
});

test("5: tag whitelist keeps classification, emergency and dedupe tags and drops everything else", () => {
  const elements = tileDocument(buildFixture(), "hospital/510_1227.json").elements;
  const node = elements.find((element) => element.type === "node" && element.id === 1);
  assert.deepEqual(node.tags, {
    "addr:city": "서울", "addr:housenumber": "1", "addr:street": "테스트로", amenity: "hospital",
    emergency: "yes", name: "테스트 종합병원", "name:en": "Test General Hospital", phone: "+82-2-000-0000"
  });
  const way = elements.find((element) => element.type === "way" && element.id === 2001);
  assert.deepEqual(way.tags, {amenity: "hospital", name: "테스트 종합병원"});
  const relation = elements.find((element) => element.type === "relation" && element.id === 3001);
  assert.deepEqual(relation.tags, {
    amenity: "hospital", emergency: "yes", healthcare: "hospital", "healthcare:speciality": "emergency;general",
    name: "테스트 대학병원"
  });
});

test("6: ways and relations get the bounding-box center; records use the Overpass element shape", () => {
  const elements = tileDocument(buildFixture(), "hospital/510_1227.json").elements;
  assert.deepEqual(elements.find((element) => element.id === 2001).center, {lat: 37.5502, lon: 126.9803});
  assert.deepEqual(elements.find((element) => element.id === 3001).center, {lat: 37.5605, lon: 126.9905});
  for(const element of elements){
    const keys = Object.keys(element).sort();
    assert.deepEqual(keys, element.type === "node" ? ["id", "lat", "lon", "tags", "type"] : ["center", "id", "tags", "type"]);
  }
  const subrelation = build({elements: [
    HOSPITAL_NODE, PHARMACY_NODE,
    {type: "node", id: 10, lat: 37.5, lon: 126.5},
    {type: "relation", id: 1, members: [{type: "node", ref: 10, role: ""}, {type: "relation", ref: 99, role: ""}], tags: {amenity: "hospital"}},
    {type: "relation", id: 2, members: [{type: "relation", ref: 1, role: ""}], tags: {amenity: "hospital"}}
  ]}, DATA_AS_OF);
  assert.equal(subrelation.report.geometry.subrelationMembersIgnored, 2);
  assert.deepEqual(subrelation.report.rejected.byReason.incomplete_geometry.sample, ["relation/2"]);
});

test("7: hospitals and pharmacies are separate tile sets; an object matching both appears in both", () => {
  const result = buildFixture();
  const pharmacy = tileDocument(result, "pharmacy/510_1227.json");
  assert.equal(pharmacy.facilityType, "pharmacy");
  assert.deepEqual(pharmacy.elements.map((element) => element.id), [8, 9, 20]);
  const hospitalIds = result.manifest.tiles.hospital.flatMap((entry) => tileDocument(result, entry.path).elements.map((element) => element.id));
  assert.ok(hospitalIds.includes(20));
  assert.equal(hospitalIds.includes(8), false);
  assert.equal(hospitalIds.includes(9), false);
  for(const entry of result.manifest.tiles.hospital) assert.match(entry.path, /^hospital\//);
  for(const entry of result.manifest.tiles.pharmacy) assert.match(entry.path, /^pharmacy\//);
});

test("8: every checksum and count in the manifest matches the generated bytes", () => {
  const result = buildFixture();
  const files = fileMap(result);
  for(const file of result.files) assert.equal(file.sha256, sha256Hex(file.bytes), file.path);
  const tileLines = [];
  for(const type of ["hospital", "pharmacy"]){
    for(const entry of result.manifest.tiles[type]){
      const file = files.get(entry.path);
      assert.equal(entry.sha256, file.sha256);
      assert.equal(entry.bytes, file.bytes.length);
      assert.equal(entry.count, tileDocument(result, entry.path).elements.length);
      tileLines.push(`${entry.path} ${entry.sha256}\n`);
    }
  }
  assert.equal(result.manifest.contentSha256, sha256Hex(Buffer.from(tileLines.sort().join(""), "utf8")));
  assert.equal(result.manifest.files.validationReport.sha256, files.get("validation-report.json").sha256);
  assert.equal(result.manifest.files.attribution.sha256, files.get("ATTRIBUTION.txt").sha256);
  assert.equal(result.manifestSha256, files.get("manifest.json").sha256);
  assert.equal(files.get("manifest.json").bytes.toString("utf8"), canonicalJson(result.manifest) + "\n");
});

test("9: output is deterministic: rebuilds, shuffled input and reordered tag keys give identical bytes", () => {
  const first = buildFixture();
  const second = buildFixture();
  const random = seededRandom(20261023);
  const input = loadFixture();
  input.elements = shuffled(input.elements, random).map((element) => {
    if(!element || typeof element !== "object" || !element.tags || typeof element.tags !== "object" || Array.isArray(element.tags)) return element;
    return {...element, tags: Object.fromEntries(Object.entries(element.tags).reverse())};
  });
  const third = buildFixture({input});
  for(const other of [second, third]){
    assert.equal(other.files.length, first.files.length);
    first.files.forEach((file, index) => {
      assert.equal(other.files[index].path, file.path);
      assert.equal(other.files[index].sha256, file.sha256, file.path);
    });
  }
  assert.equal(first.manifest.contentSha256, GOLDEN_CONTENT_SHA256);
  assert.equal(first.datasetVersionId, `kr-osm-20261020T000000Z-${GOLDEN_CONTENT_SHA256.slice(0, 12)}`);
});

test("10: the dataset timestamp comes from the source or an explicit option, never the clock", () => {
  const result = buildFixture();
  assert.equal(result.manifest.dataAsOf, "2026-10-20T00:00:00Z");
  const timestamps = canonicalJson(result.manifest).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g);
  assert.deepEqual([...new Set(timestamps)], ["2026-10-20T00:00:00"]);
  const elements = [HOSPITAL_NODE, PHARMACY_NODE];
  assert.equal(build({elements}, DATA_AS_OF).manifest.dataAsOf, "2026-10-20T00:00:00Z");
  expectBuildError("MISSING_DATA_AS_OF", () => build({elements}));
  expectBuildError("INVALID_DATA_AS_OF", () => build({elements}, {dataAsOf: "2026-02-30T00:00:00Z"}));
  expectBuildError("INVALID_DATA_AS_OF", () => build({elements}, {dataAsOf: "2026-10-20"}));
  expectBuildError("INVALID_DATA_AS_OF", () => build({elements, osm3s: {timestamp_osm_base: "yesterday"}}));
  expectBuildError("DATA_AS_OF_CONFLICT", () => build(loadFixture(), {dataAsOf: "2026-10-21T00:00:00Z"}));
});

test("11: malformed input and empty datasets stop the build instead of producing an empty dataset", () => {
  for(const input of [null, undefined, [], "osm", 42, {}, {elements: {}}, {elements: "x"}]){
    expectBuildError("INVALID_INPUT", () => build(input, DATA_AS_OF));
  }
  expectBuildError("EMPTY_DATASET", () => build({elements: []}, DATA_AS_OF));
  expectBuildError("EMPTY_DATASET", () => build({elements: [HOSPITAL_NODE]}, DATA_AS_OF));
  expectBuildError("EMPTY_DATASET", () => build({elements: [PHARMACY_NODE]}, DATA_AS_OF));
  expectBuildError("EMPTY_DATASET", () => build({elements: [{type: "node", id: 9, lat: 95, lon: 0, tags: {amenity: "hospital"}}]}, DATA_AS_OF));
  expectBuildError("INVALID_REGION", () => buildDataset({elements: [HOSPITAL_NODE, PHARMACY_NODE]}, {generator: generatorInfo(), ...DATA_AS_OF}));
  expectBuildError("INVALID_GENERATOR_INFO", () => buildDataset({elements: [HOSPITAL_NODE, PHARMACY_NODE]}, {region: KR_REGION, ...DATA_AS_OF}));
  expectBuildError("TILE_TOO_LARGE", () => build(loadFixture(), {region: {...KR_REGION, tileMaxBytes: 500}}));
});

test("12: ODbL attribution and share-alike notice travel with the manifest, every tile and ATTRIBUTION.txt", () => {
  const result = buildFixture();
  assert.deepEqual(result.manifest.license, {
    id: "ODbL-1.0",
    name: "Open Data Commons Open Database License 1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright",
    shareAlike: true,
    notice: "Contains information from OpenStreetMap, which is made available here under the Open Database License (ODbL) 1.0."
  });
  assert.equal(result.manifest.source.kind, "openstreetmap");
  assert.match(result.manifest.source.canonicalInputSha256, /^[0-9a-f]{64}$/);
  for(const type of ["hospital", "pharmacy"]){
    for(const entry of result.manifest.tiles[type]){
      assert.deepEqual(tileDocument(result, entry.path).license, {
        id: LICENSE.id, attribution: LICENSE.attribution, attributionUrl: LICENSE.attributionUrl
      });
    }
  }
  const notice = fileMap(result).get("ATTRIBUTION.txt").bytes.toString("utf8");
  assert.match(notice, /© OpenStreetMap contributors - https:\/\/www\.openstreetmap\.org\/copyright/);
  assert.match(notice, /Open Database License \(ODbL\) 1\.0/);
  assert.match(notice, /share-alike/);
  assert.match(notice, new RegExp(result.datasetVersionId));
});

test("13: OSM emergency tags are passed through verbatim and never presented as verified emergency operation", () => {
  const result = buildFixture();
  assert.match(result.manifest.semantics.emergency, /do not verify that an emergency department exists, is open/);
  assert.equal(result.manifest.status, "candidate");
  const keys = [];
  const walk = (value) => {
    if(Array.isArray(value)) value.forEach(walk);
    else if(value && typeof value === "object"){
      for(const [key, child] of Object.entries(value)){
        keys.push(key);
        if(key !== "tags") walk(child); // raw OSM tag keys are source data, not claims
      }
    }
  };
  walk(result.manifest);
  for(const type of ["hospital", "pharmacy"]){
    for(const entry of result.manifest.tiles[type]) walk(tileDocument(result, entry.path));
  }
  walk(result.report);
  const derivedClaims = keys.filter((key) => /verif|confirm|operational|open_now|isopen|available/i.test(key));
  assert.deepEqual(derivedClaims, []);
});

test("14: canonical JSON is key-order independent and rejects non-JSON values", () => {
  assert.equal(canonicalJson({b: 1, a: [true, null, "x"], c: {z: -0, y: 1.5}}), '{"a":[true,null,"x"],"b":1,"c":{"y":1.5,"z":0}}');
  assert.equal(canonicalJsonBytes({a: 1}).toString("utf8"), '{"a":1}\n');
  assert.throws(() => canonicalJson({a: Number.NaN}), TypeError);
  assert.throws(() => canonicalJson({a: undefined}), TypeError);
  assert.throws(() => canonicalJson(new Date(0)), TypeError);
});

test("15: CLI writes an immutable candidate version outside the repository and refuses unsafe outputs", () => {
  const cli = path.join(GENERATOR_DIR, "build-dataset.mjs");
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sos-facility-dataset-"));
  try{
    const run = (out) => spawnSync(process.execPath, [cli, "--input", FIXTURE_PATH, "--region", "KR", "--out", out], {encoding: "utf8"});
    const first = run(outRoot);
    assert.equal(first.status, 0, first.stderr);
    const summary = JSON.parse(first.stdout);
    assert.equal(summary.status, "candidate");
    const versionDir = path.join(outRoot, summary.datasetVersionId);
    const manifestBytes = fs.readFileSync(path.join(versionDir, "manifest.json"));
    assert.equal(sha256Hex(manifestBytes), summary.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifest.source.rawInputSha256, sha256Hex(fs.readFileSync(FIXTURE_PATH)));
    assert.equal(manifest.contentSha256, GOLDEN_CONTENT_SHA256);
    for(const type of ["hospital", "pharmacy"]){
      for(const entry of manifest.tiles[type]){
        assert.equal(sha256Hex(fs.readFileSync(path.join(versionDir, ...entry.path.split("/")))), entry.sha256);
      }
    }
    assert.deepEqual(fs.readdirSync(outRoot), [summary.datasetVersionId], "no staging directory left behind");

    const again = run(outRoot);
    assert.equal(again.status, 1);
    assert.equal(JSON.parse(again.stderr).code, "OUTPUT_EXISTS");

    const insideRepository = path.join(ROOT, "tmp-facility-dataset-must-not-exist");
    const refused = run(insideRepository);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stderr).code, "OUTPUT_INSIDE_REPOSITORY");
    assert.equal(fs.existsSync(insideRepository), false);

    const badArgs = spawnSync(process.execPath, [cli, "--input", FIXTURE_PATH], {encoding: "utf8"});
    assert.equal(badArgs.status, 1);
    assert.equal(JSON.parse(badArgs.stderr).code, "INVALID_ARGUMENTS");
  }finally{
    fs.rmSync(outRoot, {recursive: true, force: true});
  }
});
