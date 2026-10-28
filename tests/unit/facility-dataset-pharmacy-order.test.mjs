// Regression tests for the second independent review (S1 v3): emergency
// evidence ordering must apply to HOSPITAL tiles only. Pharmacy tiles keep the
// Overpass order (OSM type, then id) that the live Function returns and that
// S1 v1 stored, so the existing client keeps the same pharmacy record.
// Runs the REAL src/app/legacy-app.js pipeline and the REAL
// netlify/functions/nearby-facilities.js (stub provider, no network).

import assert from "node:assert/strict";
import test from "node:test";
import {buildDataset} from "../../scripts/facility-dataset/lib/generate.mjs";
import {mergeTileElements, elementsWithinRadius} from "../../scripts/facility-dataset/lib/read.mjs";
import {tileIdFor} from "../../scripts/facility-dataset/lib/geo.mjs";
import {preservedTags} from "../../scripts/facility-dataset/lib/selectors.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {
  buildFixture, fileMap, loadClientPipeline, loadLiveFunction, staticCandidates, seededRandom, shuffled
} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const client = loadClientPipeline();
const TYPE_ORDER = {node: 0, way: 1, relation: 2};
const FILLER_HOSPITAL = {type: "node", id: 900001, lat: 37.6, lon: 127.1, tags: {amenity: "hospital", name: "filler"}};
const FIELDS = ["id", "osmType", "osmId", "phone", "openingHours", "emergencyCareConfirmed", "emergencyStatus",
  "emergencyTag", "emergencyDepartmentTag", "emergencyWardTag", "isHospital", "facilityClass"];

function squareWay(wayId, firstNodeId, latitude, longitude, halfSize, tags){
  const corners = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([dLat, dLon], index) => ({
    type: "node", id: firstNodeId + index,
    lat: Math.round((latitude + dLat * halfSize) * 1e7) / 1e7,
    lon: Math.round((longitude + dLon * halfSize) * 1e7) / 1e7
  }));
  return [...corners, {type: "way", id: wayId, nodes: [...corners.map((corner) => corner.id), firstNodeId], tags}];
}

// The reported case: a plain pharmacy node and a way of the same name and
// point that is tagged as a pharmacy AND as an emergency hospital.
function reportedCase(nodeLatitude = 37.55, wayLatitude = 37.55){
  return [
    {type: "node", id: 1, lat: nodeLatitude, lon: 126.98, tags: {
      amenity: "pharmacy", name: "테스트약국", phone: "010-1111-1111", opening_hours: "Mo-Fr 09:00-18:00"
    }},
    ...squareWay(2001, 1001, wayLatitude, 126.98, 0.0002, {
      amenity: "pharmacy", healthcare: "hospital", emergency: "yes", name: "테스트약국",
      phone: "010-2222-2222", opening_hours: "closed"
    })
  ];
}

function build(elements){
  return buildDataset({elements: [...elements, FILLER_HOSPITAL]}, {
    region: KR_REGION, generator: generatorInfo(), dataAsOf: "2026-10-20T00:00:00Z", sourceLabel: "pharmacy-order-test"
  });
}

function tileDocuments(result, type){
  const files = fileMap(result);
  return result.manifest.tiles[type].map((entry) => JSON.parse(files.get(entry.path).bytes.toString("utf8")));
}

function pick(results){
  return results.map((facility) => Object.fromEntries(FIELDS.map((field) => [field, facility[field]])));
}

async function livePharmacyResults(result, base, recommendation){
  const universe = tileDocuments(result, "pharmacy").flatMap((tile) => tile.elements);
  const body = await loadLiveFunction(universe).search("pharmacy", base.latitude, base.longitude);
  assert.equal(body.ok, true);
  return client.run(body.elements, "pharmacy", base, recommendation);
}

const BASE = {latitude: 37.5503, longitude: 126.9803};

test("1: reported case: pharmacy search keeps the plain pharmacy node exactly like the live Function (id, phone, hours, emergency fields)", async () => {
  const result = build(reportedCase());
  for(const recommendation of [null, {emergencyContext: true}]){
    const live = await livePharmacyResults(result, BASE, recommendation);
    const fromTiles = client.run(staticCandidates(result, "pharmacy", BASE.latitude, BASE.longitude, 5000), "pharmacy", BASE, recommendation);
    assert.deepEqual(fromTiles, live, `recommendation=${JSON.stringify(recommendation)}`);
    assert.deepEqual(pick(fromTiles), [{
      id: "pharmacy-node-1", osmType: "node", osmId: 1, phone: "010-1111-1111", openingHours: "Mo-Fr 09:00-18:00",
      emergencyCareConfirmed: false, emergencyStatus: "unknown", emergencyTag: "", emergencyDepartmentTag: "",
      emergencyWardTag: "", isHospital: false, facilityClass: "other"
    }]);
  }
  // Pharmacy tile order is Overpass order (S1 v1 policy), not evidence order.
  const pharmacyIds = tileDocuments(result, "pharmacy").flatMap((tile) => tile.elements.map((element) => `${element.type}/${element.id}`));
  assert.deepEqual(pharmacyIds, ["node/1", "way/2001"]);
});

test("2: the same way still counts as hospital-level emergency evidence in HOSPITAL searches (v2 fix kept)", () => {
  const elements = [
    {type: "node", id: 5, lat: 37.55, lon: 126.98, tags: {amenity: "clinic", name: "테스트약국"}},
    ...reportedCase().slice(1)
  ];
  const result = build(elements);
  const hospitalIds = tileDocuments(result, "hospital").flatMap((tile) => tile.elements.map((element) => `${element.type}/${element.id}`));
  assert.deepEqual(hospitalIds.filter((label) => label !== "node/900001"), ["way/2001", "node/5"], "hospital tile is evidence-first");
  const results = client.run(staticCandidates(result, "hospital", BASE.latitude, BASE.longitude, 5000), "hospital", BASE, {emergencyContext: true});
  assert.equal(results[0].id, "hospital-way-2001");
  assert.equal(results[0].emergencyCareConfirmed, true);
  assert.equal(results.some((facility) => facility.id === "hospital-node-5"), false);
});

test("3: tile merge order does not change the pharmacy result, including a node and a way in neighbouring tiles", async () => {
  const result = build(reportedCase(37.499996, 37.500004));
  const documents = tileDocuments(result, "pharmacy");
  assert.equal(documents.length, 2, "node and way are in different tiles");
  assert.equal(tileIdFor(37.499996, 126.98, result.manifest.grid), "509_1227");
  const base = {latitude: 37.4998, longitude: 126.9802};
  const live = await livePharmacyResults(result, base, null);
  assert.equal(live[0].id, "pharmacy-node-1");
  const random = seededRandom(31);
  const orders = [documents, documents.slice().reverse(), ...Array.from({length: 6}, () => shuffled(documents, random))];
  for(const order of orders){
    const candidates = elementsWithinRadius(mergeTileElements(order, "pharmacy"), base.latitude, base.longitude, 5000);
    assert.deepEqual(client.run(candidates, "pharmacy", base, null), live);
  }
});

test("4: input order does not change pharmacy tiles or results; pharmacy tiles equal an independent type/id sort", () => {
  const elements = reportedCase();
  const reference = build(elements);
  const random = seededRandom(17);
  for(let round = 0; round < 10; round += 1){
    const again = build(shuffled(elements, random).map((element) => element.tags
      ? {...element, tags: Object.fromEntries(Object.entries(element.tags).reverse())} : element));
    assert.deepEqual(again.files.map((file) => file.sha256), reference.files.map((file) => file.sha256));
  }
  // Fixture: every pharmacy tile is in plain Overpass order (S1 v1 policy).
  const fixture = buildFixture();
  for(const tile of tileDocuments(fixture, "pharmacy")){
    const expected = tile.elements.slice().sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (a.id - b.id));
    assert.deepEqual(tile.elements, expected);
  }
});

test("5: no tag is changed or added on pharmacy records", () => {
  const elements = reportedCase();
  const result = build(elements);
  for(const record of tileDocuments(result, "pharmacy").flatMap((tile) => tile.elements)){
    const source = elements.find((element) => element.type === record.type && element.id === record.id);
    assert.deepEqual(record.tags, preservedTags(source.tags).tags, `${record.type}/${record.id}`);
  }
});
