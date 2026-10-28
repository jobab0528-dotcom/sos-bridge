// Contract tests: the static facility dataset generator against the REAL
// production sources (read as text, executed in node:vm; never modified).
// - selectors mirror the Overpass queries in nearby-facilities.js
// - preserved tags cover every OSM tag key the client pipeline reads
// - when the candidate sets are equal (the live response consulted BOTH the
//   core and the extended hospital selectors at its final radius), the client
//   pipeline gives the same results from static tiles as from a
//   live-Function-shaped response. Cases where the real Function returns a
//   smaller set are covered in facility-dataset-live-parity.test.mjs.
// - generator code has no network, clock or randomness dependencies

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {readRepoFile, extractFunction, forbidNetwork} from "../contract/_source.mjs";
import {
  HOSPITAL_CORE_SELECTORS,
  HOSPITAL_EXTENDED_SELECTORS,
  PHARMACY_SELECTORS,
  PRESERVED_TAG_KEYS
} from "../../scripts/facility-dataset/lib/selectors.mjs";
import {haversineMeters} from "../../scripts/facility-dataset/lib/geo.mjs";
import {mergeTileElements, tileMatchesChecksum} from "../../scripts/facility-dataset/lib/read.mjs";
import {buildFixture, fileMap, loadFixture, loadClientPipeline, staticCandidates, GENERATOR_DIR} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const FUNCTION_SOURCE = readRepoFile("netlify/functions/nearby-facilities.js");
const CLIENT_SOURCE = readRepoFile("src/app/legacy-app.js");

function querySelectors(functionName){
  const body = extractFunction(FUNCTION_SOURCE, functionName);
  const selectors = new Map();
  for(const match of body.matchAll(/(node|way|relation)\(around:[^)]*\)\["([^"]+)"(~|=)"([^"]+)"\]/g)){
    const key = `${match[2]}${match[3]}${match[4]}`;
    if(!selectors.has(key)) selectors.set(key, {key: match[2], operator: match[3], value: match[4], osmTypes: new Set()});
    selectors.get(key).osmTypes.add(match[1]);
  }
  return [...selectors.values()];
}

function asComparable(selectors){
  return selectors.map((selector) => `${selector.key}${selector.operator}${selector.value}`).sort();
}

test("1: selectors are identical to the live Function's Overpass queries for all OSM object types", () => {
  const core = querySelectors("buildHospitalCoreQuery");
  const extended = querySelectors("buildHospitalExtendedQuery");
  const pharmacy = querySelectors("buildOverpassQuery");
  assert.deepEqual(asComparable(core), asComparable(HOSPITAL_CORE_SELECTORS));
  assert.deepEqual(asComparable(extended), asComparable(HOSPITAL_EXTENDED_SELECTORS));
  assert.deepEqual(asComparable(pharmacy), asComparable(PHARMACY_SELECTORS));
  for(const selector of [...core, ...extended, ...pharmacy]){
    assert.deepEqual([...selector.osmTypes].sort(), ["node", "relation", "way"], `${selector.key}${selector.operator}${selector.value}`);
  }
  for(const name of ["buildHospitalCoreQuery", "buildHospitalExtendedQuery", "buildOverpassQuery"]){
    assert.match(extractFunction(FUNCTION_SOURCE, name), /out center tags;/, `${name} returns centers`);
  }
});

test("2: preserved tags cover every OSM tag key the client facility pipeline reads", () => {
  const keysRead = new Set();
  for(const call of CLIENT_SOURCE.matchAll(/\btag\(tags,\s*\[([^\]]*)\]\)/g)){
    for(const key of call[1].matchAll(/"([^"]+)"/g)) keysRead.add(key[1]);
  }
  assert.ok(keysRead.size >= 30, "tag() calls were found");
  const preserved = new Set(PRESERVED_TAG_KEYS);
  assert.deepEqual([...keysRead].filter((key) => !preserved.has(key)).sort(), []);
  // Direct tags[...] access would bypass this check; only the tag() helper may do it.
  const tagHelper = extractFunction(CLIENT_SOURCE, "tag");
  assert.match(tagHelper, /tags && tags\[k\]/);
  const outsideHelper = CLIENT_SOURCE.replace(tagHelper, "");
  assert.equal([...outsideHelper.matchAll(/\btags\s*\[/g)].length, 0, "update PRESERVED_TAG_KEYS if the client reads tags directly");
});

// Independent oracle for a live response that consulted EVERY selector at the
// given radius (the Function does this only when it does not stop early; see
// facility-dataset-live-parity.test.mjs): raw fixture objects with ALL their
// tags, selected with selectors parsed from the Function source, hospital
// core results first then extended (the Function's mergeOverpassElements
// order), each group in Overpass id order. Way/relation centers are
// hand-computed bounding-box centers.
const ORACLE_CENTERS = {"way/2001": {lat: 37.5502, lon: 126.9803}, "relation/3001": {lat: 37.5605, lon: 126.9905}};
const ORACLE_INVALID = new Set(["node/11", "node/12", "node/13", "node/21", "way/2003"]);
const TYPE_ORDER = {node: 0, way: 1, relation: 2};

function overpassOracle(type, latitude, longitude, radius){
  const matchesAll = (selectors, tags) => selectors.some((selector) => typeof tags[selector.key] === "string" &&
    (selector.operator === "=" ? tags[selector.key] === selector.value : new RegExp(selector.value).test(tags[selector.key])));
  const candidates = loadFixture().elements.filter((element) => {
    const label = `${element.type}/${element.id}`;
    return ["node", "way", "relation"].includes(element.type) && element.id > 0 && element.tags && !ORACLE_INVALID.has(label);
  });
  const unique = [...new Map(candidates.map((element) => [`${element.type}/${element.id}`, element])).values()];
  const shaped = unique.map((element) => {
    const center = ORACLE_CENTERS[`${element.type}/${element.id}`];
    return element.type === "node"
      ? {type: element.type, id: element.id, lat: element.lat, lon: element.lon, tags: element.tags}
      : {type: element.type, id: element.id, center, tags: element.tags};
  }).filter((element) => {
    const point = element.type === "node" ? element : element.center;
    return haversineMeters(latitude, longitude, point.lat, point.lon) <= radius;
  }).sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (a.id - b.id));
  if(type === "pharmacy") return shaped.filter((element) => matchesAll(querySelectors("buildOverpassQuery"), element.tags));
  const core = shaped.filter((element) => matchesAll(querySelectors("buildHospitalCoreQuery"), element.tags));
  const extended = shaped.filter((element) => !core.includes(element) && matchesAll(querySelectors("buildHospitalExtendedQuery"), element.tags));
  return [...core, ...extended];
}

test("3: with equal candidate sets (core and extended both consulted), static tiles and a live-shaped response give identical client results", () => {
  const {run} = loadClientPipeline();
  const result = buildFixture();
  const searches = [
    {type: "hospital", at: [37.5503, 126.9801], radius: 5000},
    {type: "hospital", at: [37.5503, 126.9801], radius: 10000},
    {type: "pharmacy", at: [37.5503, 126.9801], radius: 5000},
    {type: "hospital", at: [35.1, 129.0], radius: 10000},
    {type: "hospital", at: [33.5, 126.5], radius: 20000}
  ];
  const recommendations = [null, {emergencyContext: true}];
  for(const search of searches){
    const [latitude, longitude] = search.at;
    const base = {latitude, longitude};
    const live = overpassOracle(search.type, latitude, longitude, search.radius);
    const fromTiles = staticCandidates(result, search.type, latitude, longitude, search.radius);
    assert.ok(live.length > 0, "oracle found candidates");
    for(const recommendation of recommendations){
      assert.deepEqual(
        run(fromTiles, search.type, base, recommendation),
        run(live, search.type, base, recommendation),
        `${search.type} @ ${search.at} r=${search.radius} emergency=${!!recommendation}`
      );
    }
  }
});

test("4: the client pipeline on tiles removes non-medical look-alikes, dedupes the mapped-twice hospital and drops narrow specialties in emergency mode", () => {
  const {run} = loadClientPipeline();
  const result = buildFixture();
  const base = {latitude: 37.5503, longitude: 126.9801};
  const hospital = staticCandidates(result, "hospital", base.latitude, base.longitude, 10000);
  const normalIds = run(hospital, "hospital", base, null).map((facility) => facility.id);
  assert.deepEqual([...normalIds].sort(), [
    "hospital-node-1", "hospital-node-10", "hospital-node-14", "hospital-node-2",
    "hospital-node-20", "hospital-node-3", "hospital-relation-3001"
  ]);
  // 5 car repair, 7 funeral hall, 19 healthcare=yes (fetched by the extended
  // query, rejected by the client category filter), way 2001 same site as node 1.
  for(const removed of ["hospital-node-5", "hospital-node-7", "hospital-node-19", "hospital-way-2001"]) assert.equal(normalIds.includes(removed), false, removed);
  const emergency = run(hospital, "hospital", base, {emergencyContext: true});
  assert.deepEqual(emergency.slice(0, 2).map((facility) => facility.id).sort(), ["hospital-node-1", "hospital-relation-3001"]);
  assert.ok(emergency.slice(0, 2).every((facility) => facility.emergencyCareConfirmed === true));
  assert.equal(emergency.some((facility) => facility.id === "hospital-node-10"), false, "dental hospital excluded in emergency mode");
  assert.equal(emergency.length, 5, "two hospital-level results plus clinic fallback up to five");
  const pharmacy = run(staticCandidates(result, "pharmacy", base.latitude, base.longitude, 5000), "pharmacy", base, null);
  assert.deepEqual(pharmacy.map((facility) => facility.id).sort(), ["pharmacy-node-20", "pharmacy-node-8", "pharmacy-node-9"]);
});

test("5a: mergeTileElements de-duplicates and orders per facility type; mixing types is refused", () => {
  const tiles = [
    {elements: [{type: "relation", id: 1}, {type: "node", id: 30}, {type: "way", id: 2}]},
    {elements: [{type: "node", id: 4}, {type: "node", id: 30}, {type: "way", id: 1}]},
    {elements: [{type: "relation", id: 9, tags: {healthcare: "hospital"}}, {type: "way", id: 7, tags: {amenity: "hospital", emergency: "yes"}}]},
    null,
    {elements: "not-an-array"}
  ];
  const order = (type) => mergeTileElements(tiles, type).map((element) => `${element.type}/${element.id}`);
  assert.deepEqual(order("hospital"), ["way/7", "relation/9", "node/4", "node/30", "way/1", "way/2", "relation/1"]);
  assert.deepEqual(order("pharmacy"), ["node/4", "node/30", "way/1", "way/2", "way/7", "relation/1", "relation/9"]);
  assert.deepEqual(mergeTileElements(tiles.slice().reverse(), "hospital"), mergeTileElements(tiles, "hospital"));
  assert.deepEqual(mergeTileElements(tiles.slice().reverse(), "pharmacy"), mergeTileElements(tiles, "pharmacy"));
  assert.throws(() => mergeTileElements(tiles), TypeError, "facility type is required");
  assert.throws(() => mergeTileElements(tiles, "clinic"), TypeError);
  assert.throws(() => mergeTileElements([{facilityType: "hospital", tileId: "1_1", elements: []}], "pharmacy"), TypeError);
});

test("5: a tampered tile fails its checksum", () => {
  const result = buildFixture();
  const entry = result.manifest.tiles.hospital[0];
  const document = JSON.parse(fileMap(result).get(entry.path).bytes.toString("utf8"));
  assert.ok(tileMatchesChecksum(document, entry.sha256));
  document.elements[0].tags.name = "tampered";
  assert.equal(tileMatchesChecksum(document, entry.sha256), false);
});

test("6: generator sources have no network, clock, randomness or environment dependencies", () => {
  const files = [];
  const walk = (directory) => {
    for(const entry of fs.readdirSync(directory, {withFileTypes: true})){
      const absolute = path.join(directory, entry.name);
      if(entry.isDirectory()) walk(absolute);
      else if(entry.name.endsWith(".mjs")) files.push(absolute);
    }
  };
  walk(GENERATOR_DIR);
  assert.ok(files.length >= 7);
  for(const file of files){
    const source = fs.readFileSync(file, "utf8");
    const label = path.relative(GENERATOR_DIR, file);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, label);
    assert.doesNotMatch(source, /from\s+"node:(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads)"/, label);
    assert.doesNotMatch(source, /Date\.now\s*\(|new Date\(\s*\)|performance\.now|Math\.random/, label);
    assert.doesNotMatch(source, /process\.env/, label);
  }
  const pure = fs.readFileSync(path.join(GENERATOR_DIR, "lib", "generate.mjs"), "utf8");
  assert.doesNotMatch(pure, /from\s+"node:fs"/, "buildDataset is pure: no file system access");
});
