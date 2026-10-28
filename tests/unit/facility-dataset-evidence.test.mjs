// Regression tests for independent-review FINDING 1: a hospital record with
// OSM emergency evidence must not be displaced by a weaker record of the same
// place because of record ORDER. Every check runs the REAL client pipeline
// (mapOverpass -> finalizeFacilityResults from src/app/legacy-app.js) and,
// where noted, the REAL netlify/functions/nearby-facilities.js with a stub
// provider. Coordinates and names are synthetic.

import assert from "node:assert/strict";
import test from "node:test";
import {buildDataset} from "../../scripts/facility-dataset/lib/generate.mjs";
import {facilityEvidenceRank, compareFacilityRecords} from "../../scripts/facility-dataset/lib/evidence.mjs";
import {clientCollapseKeys} from "../../scripts/facility-dataset/lib/collisions.mjs";
import {tileIdFor} from "../../scripts/facility-dataset/lib/geo.mjs";
import {preservedTags} from "../../scripts/facility-dataset/lib/selectors.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {loadClientPipeline, loadLiveFunction, staticCandidates, fileMap, seededRandom, shuffled} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const client = loadClientPipeline();
const EMERGENCY = {emergencyContext: true};
const FILLER_PHARMACY = {type: "node", id: 900000, lat: 37.6, lon: 127.1, tags: {amenity: "pharmacy", name: "filler"}};
const TYPE_ORDER = {node: 0, way: 1, relation: 2};

// Closed square way (4 corner nodes) whose bounding-box center is exactly (lat, lon).
function squareWay(wayId, firstNodeId, latitude, longitude, halfSize, tags){
  const corners = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([dLat, dLon], index) => ({
    type: "node",
    id: firstNodeId + index,
    lat: Math.round((latitude + dLat * halfSize) * 1e7) / 1e7,
    lon: Math.round((longitude + dLon * halfSize) * 1e7) / 1e7
  }));
  const ids = corners.map((corner) => corner.id);
  return [...corners, {type: "way", id: wayId, nodes: [...ids, ids[0]], tags}];
}

function build(elements){
  return buildDataset({elements: [...elements, FILLER_PHARMACY]}, {
    region: KR_REGION, generator: generatorInfo(), dataAsOf: "2026-10-20T00:00:00Z", sourceLabel: "evidence-test"
  });
}

function staticResults(result, latitude, longitude, recommendation, radius = 5000){
  return client.run(staticCandidates(result, "hospital", latitude, longitude, radius), "hospital", {latitude, longitude}, recommendation);
}

function overpassOrder(elements){
  return elements.filter((element) => element.tags).slice()
    .sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (a.id - b.id));
}

function ids(results){
  return results.map((facility) => facility.id);
}

function allTileRecords(result){
  const files = fileMap(result);
  return result.manifest.tiles.hospital.flatMap((entry) => JSON.parse(files.get(entry.path).bytes.toString("utf8")).elements);
}

// Search point 30 m north-east of the facility.
const P = {lat: 37.55, lon: 126.98};
const SEARCH = {lat: 37.5503, lon: 126.9803};

test("1: node/way, same name and point: the emergency hospital way beats a clinic node (mapOverpass first-record collapse)", async () => {
  const elements = [
    {type: "node", id: 1, lat: P.lat, lon: P.lon, tags: {amenity: "clinic", name: "테스트병원"}},
    ...squareWay(2001, 1001, P.lat, P.lon, 0.0002, {amenity: "hospital", emergency: "yes", name: "테스트병원"})
  ];
  const result = build(elements);
  // Hazard reproduced with the real client on Overpass order (node first),
  // which is the order the original S1 merge produced.
  const hazard = client.run(overpassShaped(elements, result), "hospital", {latitude: SEARCH.lat, longitude: SEARCH.lon}, EMERGENCY);
  assert.deepEqual(ids(hazard), ["hospital-node-1"], "real client keeps the first record: the clinic");
  assert.equal(hazard[0].emergencyCareConfirmed, false);

  for(const recommendation of [null, EMERGENCY]){
    const results = staticResults(result, SEARCH.lat, SEARCH.lon, recommendation);
    assert.deepEqual(ids(results), ["hospital-way-2001"], `emergency=${!!recommendation}`);
    assert.equal(results[0].emergencyCareConfirmed, true);
    assert.equal(results[0].facilityClass, "hospital");
  }

  // The live Function returns Overpass order, so the live path still keeps the
  // clinic: an intentional, documented divergence (static is safer here).
  const live = loadLiveFunction(overpassShaped(elements, result));
  const body = await live.search("hospital", SEARCH.lat, SEARCH.lon);
  assert.deepEqual(ids(client.run(body.elements, "hospital", {latitude: SEARCH.lat, longitude: SEARCH.lon}, EMERGENCY)), ["hospital-node-1"]);
});

// The same records in Overpass response order (nodes, ways, relations;
// ascending id), i.e. the order the original S1 merge produced and the order
// the live Function receives. Centers are the ones the generator computed.
function overpassShaped(elements, result){
  const byLabel = new Map(allTileRecords(result).map((record) => [`${record.type}/${record.id}`, record]));
  return overpassOrder(elements).map((element) => byLabel.get(`${element.type}/${element.id}`)).filter(Boolean);
}

test("2: node/way, different names, identical point: the emergency hospital wins the equal-distance coordinate collapse", () => {
  const elements = [
    {type: "node", id: 1, lat: P.lat, lon: P.lon, tags: {amenity: "doctors", name: "테스트 접수처"}},
    ...squareWay(2001, 1001, P.lat, P.lon, 0.0002, {amenity: "hospital", "emergency:department": "yes", name: "테스트 대학병원"})
  ];
  const result = build(elements);
  const hazard = client.run(overpassShaped(elements, result), "hospital", {latitude: SEARCH.lat, longitude: SEARCH.lon}, null);
  assert.deepEqual(ids(hazard), ["hospital-node-1"], "real client: equal distance keeps input order");
  for(const recommendation of [null, EMERGENCY]){
    assert.deepEqual(ids(staticResults(result, SEARCH.lat, SEARCH.lon, recommendation)), ["hospital-way-2001"]);
  }
  assert.equal(result.report.clientCollapse.mixedEvidencePairsResolvedByOrdering, 1);
  assert.equal(result.report.clientCollapse.mixedEvidencePairsDistanceDependent, 0);
});

test("3: relation/way: a multipolygon hospital with emergency tags beats its own outer way tagged as a plain hospital", () => {
  const elements = [
    ...squareWay(2002, 1005, P.lat, P.lon, 0.0005, {amenity: "hospital", name: "테스트 종합병원"}),
    {type: "relation", id: 3001, members: [{type: "way", ref: 2002, role: "outer"}], tags: {
      type: "multipolygon", amenity: "hospital", healthcare: "hospital", emergency: "yes", name: "테스트 종합병원"
    }}
  ];
  const result = build(elements);
  const hazard = client.run(overpassShaped(elements, result), "hospital", {latitude: SEARCH.lat, longitude: SEARCH.lon}, EMERGENCY);
  assert.deepEqual(ids(hazard), ["hospital-way-2002"], "real client on Overpass order keeps the way without emergency tags");
  assert.equal(hazard[0].emergencyCareConfirmed, false);
  const records = allTileRecords(result);
  assert.deepEqual(records.find((record) => record.id === 3001).center, records.find((record) => record.id === 2002).center);
  for(const recommendation of [null, EMERGENCY]){
    const results = staticResults(result, SEARCH.lat, SEARCH.lon, recommendation);
    assert.deepEqual(ids(results), ["hospital-relation-3001"]);
    assert.equal(results[0].emergencyCareConfirmed, true);
  }
});

test("4: every client emergency-evidence tag variant wins; explicit emergency=no loses to an untagged hospital", () => {
  const variants = [
    {amenity: "hospital", emergency: "yes"},
    {amenity: "hospital", emergency: "YES"},
    {amenity: "hospital", emergency: "designated"},
    {amenity: "hospital", emergency: "24/7"},
    {amenity: "hospital", emergency: "no;yes"},
    {amenity: "hospital", "emergency:department": "yes"},
    {amenity: "hospital", "healthcare:emergency": "yes"},
    {amenity: "hospital", emergency_ward: "yes"},
    {amenity: "hospital", emergency_ward_entrance: "yes"},
    {amenity: "hospital", "healthcare:speciality": "emergency"},
    {amenity: "hospital", speciality: "emergency medicine"},
    {amenity: "hospital", "medical_system:specialty": "emergency_medical_services"},
    {healthcare: "hospital", emergency: "yes"},
    {amenity: "Hospital", healthcare: "hospital", emergency: "Emergency-Department"}
  ];
  for(const [index, tags] of variants.entries()){
    const elements = [
      {type: "node", id: 1, lat: P.lat, lon: P.lon, tags: {amenity: "clinic", name: "테스트병원"}},
      ...squareWay(2001, 1001, P.lat, P.lon, 0.0002, {...tags, name: "테스트병원"})
    ];
    const result = build(elements);
    const results = staticResults(result, SEARCH.lat, SEARCH.lon, EMERGENCY);
    assert.deepEqual(ids(results), ["hospital-way-2001"], `variant ${index} ${JSON.stringify(tags)}`);
    assert.equal(results[0].emergencyCareConfirmed, true, `variant ${index}`);
  }
  // Explicit "no" emergency evidence ranks below an untagged hospital.
  const elements = [
    {type: "node", id: 1, lat: P.lat, lon: P.lon, tags: {amenity: "hospital", name: "테스트병원"}},
    ...squareWay(2001, 1001, P.lat, P.lon, 0.0002, {amenity: "hospital", emergency: "no", name: "테스트병원"})
  ];
  assert.deepEqual(ids(staticResults(build(elements), SEARCH.lat, SEARCH.lon, null)), ["hospital-node-1"]);
});

test("5: tile boundary: node and way of one facility in neighbouring tiles still merge evidence-first", () => {
  // 5-decimal coordinates are equal (37.50000), tiles differ (37.5 is a tile edge).
  const elements = [
    {type: "node", id: 1, lat: 37.499996, lon: P.lon, tags: {amenity: "clinic", name: "경계병원"}},
    ...squareWay(2001, 1001, 37.500004, P.lon, 0.0002, {amenity: "hospital", emergency: "yes", name: "경계병원"})
  ];
  const result = build(elements);
  const records = allTileRecords(result);
  const way = records.find((record) => record.id === 2001);
  assert.equal(tileIdFor(37.499996, P.lon, result.manifest.grid), "509_1227");
  assert.equal(tileIdFor(way.center.lat, way.center.lon, result.manifest.grid), "510_1227");
  const search = {lat: 37.4998, lon: 126.9802};
  for(const recommendation of [null, EMERGENCY]){
    const results = staticResults(result, search.lat, search.lon, recommendation);
    assert.deepEqual(ids(results), ["hospital-way-2001"], `emergency=${!!recommendation}`);
  }
});

test("6: equal evidence keeps a deterministic order independent of input order", () => {
  const elements = [
    {type: "node", id: 5, lat: P.lat, lon: P.lon, tags: {amenity: "hospital", name: "테스트병원"}},
    ...squareWay(2001, 1001, P.lat, P.lon, 0.0002, {amenity: "hospital", name: "테스트병원"}),
    {type: "node", id: 3, lat: P.lat, lon: P.lon, tags: {amenity: "hospital", emergency: "yes", name: "테스트병원"}}
  ];
  const reference = build(elements);
  const random = seededRandom(99);
  for(let round = 0; round < 10; round += 1){
    const again = build(shuffled(elements, random));
    assert.deepEqual(again.files.map((file) => file.sha256), reference.files.map((file) => file.sha256));
  }
  const order = allTileRecords(reference).map((record) => `${record.type}/${record.id}`);
  assert.deepEqual(order, ["node/3", "node/5", "way/2001"]);
});

test("7: legitimate separate facilities are all kept; no record is removed and no tag is added or changed", () => {
  const elements = [
    {type: "node", id: 1, lat: 37.5501, lon: 126.9801, tags: {amenity: "clinic", name: "테스트 내과"}},
    {type: "node", id: 2, lat: 37.5504, lon: 126.9804, tags: {amenity: "hospital", emergency: "yes", name: "테스트 응급병원"}},
    {type: "node", id: 3, lat: 37.552, lon: 126.982, tags: {amenity: "hospital", name: "테스트 요양병원"}},
    ...squareWay(2001, 1001, 37.549, 126.979, 0.0002, {healthcare: "clinic", name: "테스트 소아과"})
  ];
  const result = build(elements);
  const records = allTileRecords(result);
  assert.deepEqual(records.map((record) => `${record.type}/${record.id}`).sort(), ["node/1", "node/2", "node/3", "way/2001"]);
  for(const record of records){
    const source = elements.find((element) => element.type === record.type && element.id === record.id);
    assert.deepEqual(record.tags, preservedTags(source.tags).tags, `${record.type}/${record.id} tags unchanged`);
  }
  assert.deepEqual(ids(staticResults(result, SEARCH.lat, SEARCH.lon, null)).sort(), [
    "hospital-node-1", "hospital-node-2", "hospital-node-3", "hospital-way-2001"
  ]);
  const emergency = staticResults(result, SEARCH.lat, SEARCH.lon, EMERGENCY);
  assert.deepEqual(ids(emergency).slice(0, 2), ["hospital-node-2", "hospital-node-3"]);
  assert.equal(emergency.filter((facility) => facility.emergencyCareConfirmed).length, 1, "no emergency evidence is invented");
});

test("8: KNOWN LIMITATION: when the weaker record is strictly closer, the client keeps it (distance, not order); the report flags it", () => {
  // Same display name, same 4-decimal cell, different 5-decimal coordinates.
  const elements = [
    {type: "node", id: 1, lat: 37.55002, lon: 126.98002, tags: {amenity: "clinic", name: "테스트병원"}},
    ...squareWay(2001, 1001, 37.55004, 126.98004, 0.0002, {amenity: "hospital", emergency: "yes", name: "테스트병원"})
  ];
  const result = build(elements);
  assert.deepEqual(result.report.clientCollapse.distanceDependentSample, ["node/1+way/2001"]);
  assert.equal(result.report.clientCollapse.mixedEvidencePairsDistanceDependent, 1);
  const nearNode = staticResults(result, 37.5499, 126.9799, EMERGENCY);
  assert.deepEqual(ids(nearNode), ["hospital-node-1"], "existing client behavior; needs an S3 client change");
  const nearWay = staticResults(result, 37.5502, 126.9802, EMERGENCY);
  assert.deepEqual(ids(nearWay), ["hospital-way-2001"]);
});

test("9: facilityEvidenceRank equals the real client emergency tier (narrow specialty aside) for a tag matrix and 3000 random tag sets", () => {
  const pools = {
    amenity: [undefined, "hospital", "Hospital", "clinic", "doctors", "pharmacy", "dentist"],
    healthcare: [undefined, "hospital", "HOSPITAL", "clinic", "centre", "yes"],
    emergency: [undefined, "yes", "no", "YES", "No", "designated", "24/7", "no;yes", "none", "false", " yes ", "unknown", "emergency department"],
    "emergency:department": [undefined, "yes", "no", "main"],
    "healthcare:emergency": [undefined, "yes", "no"],
    emergency_ward: [undefined, "yes", "no"],
    emergency_ward_entrance: [undefined, "yes", "official"],
    "healthcare:speciality": [undefined, "emergency", "general;emergency_medicine", "dentistry", "Emergency Medical Services"],
    speciality: [undefined, "emergency", "urology"],
    "medical_system:specialty": [undefined, "emergency_medicine"],
    name: [undefined, "테스트", "Test Dental Clinic", "치과병원"]
  };
  const random = seededRandom(4242);
  let compared = 0;
  for(let iteration = 0; iteration < 3000; iteration += 1){
    const tags = {};
    for(const [key, values] of Object.entries(pools)){
      const value = values[Math.floor(random() * values.length)];
      if(value !== undefined && random() < 0.6) tags[key] = value;
    }
    const expected = client.tierOf(tags);
    assert.equal(facilityEvidenceRank(tags), expected.tierIgnoringNarrow, JSON.stringify(tags));
    if(expected.tier !== 3) assert.equal(facilityEvidenceRank(tags), expected.tier, JSON.stringify(tags));
    compared += 1;
  }
  assert.equal(compared, 3000);
  assert.equal(facilityEvidenceRank(undefined), 2);
  assert.equal(compareFacilityRecords({type: "node", id: 9, tags: {}}, {type: "way", id: 1, tags: {amenity: "hospital"}}) > 0, true);
});

test("10: report collapse keys equal the real client keys (mapOverpass name+point and finalizeFacilityResults dedupe keys)", () => {
  const random = seededRandom(77);
  const names = [undefined, "테스트 병원", "Test (General) Hospital", "  ", "·.,", "A-B/C"];
  for(let iteration = 0; iteration < 500; iteration += 1){
    const tags = {amenity: "hospital"};
    for(const key of ["name", "name:ko", "name:en"]){
      const value = names[Math.floor(random() * names.length)];
      if(value !== undefined && random() < 0.5) tags[key] = value;
    }
    const element = {type: "node", id: iteration + 1, lat: Math.round((37 + random()) * 1e7) / 1e7, lon: Math.round((127 + random()) * 1e7) / 1e7, tags};
    const [facility] = client.mapOne(element, "hospital", {latitude: 37.5, longitude: 127.5});
    const ours = clientCollapseKeys(element);
    assert.equal(ours[0], `map:${facility.nameKo}-${facility.latitude.toFixed(5)}-${facility.longitude.toFixed(5)}`);
    const clientKeys = client.dedupeKeys(facility).filter((key) => !key.startsWith("osm:"));
    assert.deepEqual(ours.slice(1), clientKeys, JSON.stringify(tags));
  }
});
