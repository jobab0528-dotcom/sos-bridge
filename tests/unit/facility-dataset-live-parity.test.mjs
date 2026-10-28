// Regression tests for independent-review FINDING 3: static-vs-live parity is
// conditional. These tests run the REAL netlify/functions/nearby-facilities.js
// (stub provider, no network) and the REAL client pipeline, and pin exactly
// when the two paths give the same candidates and when the static path
// intentionally returns more.
//
// Rule (evidence: tests 1-5): static candidates (every selected object within
// the radius) equal the live candidates at the live searchRadiusMeters if and
// only if the live Function ran EVERY selector for that final radius: always
// for pharmacy; for hospital only when the extended query ran at that radius.
// The live Function skips it when the core query alone reaches 20 raw
// candidates. The static dataset is not truncated to mimic that, nor capped at
// the live 10 km hospital radius.

import assert from "node:assert/strict";
import test from "node:test";
import {buildDataset} from "../../scripts/facility-dataset/lib/generate.mjs";
import {generatorInfo} from "../../scripts/facility-dataset/lib/provenance.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {loadClientPipeline, loadLiveFunction, staticCandidates} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const client = loadClientPipeline();
const BASE = {latitude: 37.55, longitude: 126.98};
const EMERGENCY = {emergencyContext: true};
let nextId = 1;

function node(latitude, longitude, tags){
  return {type: "node", id: nextId++, lat: Math.round(latitude * 1e7) / 1e7, lon: Math.round(longitude * 1e7) / 1e7, tags};
}
// About 111 m per 0.001 degree of latitude.
function north(kilometers, tags){ return node(BASE.latitude + kilometers / 111.2, BASE.longitude, tags); }
function east(kilometers, tags){ return node(BASE.latitude, BASE.longitude + kilometers / 88.2, tags); }

const FILLER_PHARMACY = () => east(0.3, {amenity: "pharmacy", name: "filler pharmacy"});
const FILLER_HOSPITAL = () => east(0.4, {amenity: "hospital", name: "filler hospital"});

function build(universe){
  return buildDataset({elements: universe}, {
    region: KR_REGION, generator: generatorInfo(), dataAsOf: "2026-10-20T00:00:00Z", sourceLabel: "live-parity-test"
  });
}

function labels(elements){
  return elements.map((element) => `${element.type}/${element.id}`).sort();
}

async function compare(universe, type){
  const live = loadLiveFunction(universe);
  const body = await live.search(type, BASE.latitude, BASE.longitude);
  assert.equal(body.ok, true);
  const radius = body.searchRadiusMeters;
  const staticSet = staticCandidates(build(universe), type, BASE.latitude, BASE.longitude, radius);
  const finalRadiusQueries = live.queries.filter((query) => query.radius === radius).map((query) => query.scope);
  const consultedEverySelector = type === "pharmacy" ? finalRadiusQueries.includes("pharmacy")
    : finalRadiusQueries.includes("core") && finalRadiusQueries.includes("extended");
  return {body, live, radius, staticSet, consultedEverySelector};
}

function emergencyTier(facility){
  if(facility.emergencyNarrowSpecialty) return 3;
  if(facility.emergencyCareConfirmed) return 0;
  if(facility.isHospital && facility.emergencyStatus !== "explicit-no") return 1;
  return 2;
}

// Emergency classification and ranking stay safe even when sets differ:
// shared facilities are classified identically, the static list is ordered
// tier-then-distance, and every live hospital-level result is also present.
function assertEmergencySafety(liveElements, staticElements, type){
  const liveOut = client.run(liveElements, type, BASE, EMERGENCY);
  const staticOut = client.run(staticElements, type, BASE, EMERGENCY);
  const staticById = new Map(staticOut.map((facility) => [facility.id, facility]));
  for(const facility of liveOut){
    if(staticById.has(facility.id)) assert.deepEqual(staticById.get(facility.id), facility, facility.id);
    if(emergencyTier(facility) <= 1) assert.ok(staticById.has(facility.id), `${facility.id} hospital-level result kept`);
  }
  const tiers = staticOut.map(emergencyTier);
  assert.deepEqual(tiers, tiers.slice().sort((a, b) => a - b), "static emergency list is tier-ordered");
  return {liveOut, staticOut};
}

test("1: CORE >= 20 at 5 km (reported case): live stops after core with 20, static has 21; the extra one is the extended-only facility", async () => {
  const universe = [];
  for(let index = 0; index < 20; index += 1){
    universe.push(north(0.1 * (index + 1), index < 2 ? {amenity: "hospital", emergency: "yes", name: `응급병원 ${index}`} : {amenity: "hospital", name: `병원 ${index}`}));
  }
  const centre = east(-0.25, {healthcare: "centre", name: "보건지소"});
  universe.push(centre, FILLER_PHARMACY());
  const {body, live, radius, staticSet, consultedEverySelector} = await compare(universe, "hospital");
  assert.deepEqual(live.queries, [{scope: "core", radius: 5000}], "early stop: extended query never ran");
  assert.equal(live.EARLY_EXIT_RAW_CANDIDATE_COUNT, 20);
  assert.equal(body.complete, true);
  assert.equal(radius, 5000);
  assert.equal(body.elements.length, 20);
  assert.equal(staticSet.length, 21, "static is NOT truncated to the live early-exit count");
  assert.equal(consultedEverySelector, false);
  const liveLabels = new Set(labels(body.elements));
  assert.deepEqual(labels(staticSet).filter((label) => !liveLabels.has(label)), [`node/${centre.id}`]);
  assert.ok(labels(body.elements).every((label) => labels(staticSet).includes(label)), "live is a subset of static");

  const liveNormal = client.run(body.elements, "hospital", BASE, null);
  const staticNormal = client.run(staticSet, "hospital", BASE, null);
  assert.deepEqual(staticNormal.filter((facility) => facility.id !== `hospital-node-${centre.id}`), liveNormal);
  assert.equal(staticNormal.length, liveNormal.length + 1);
  // Five or more hospital-level results: emergency lists do not use the clinic
  // fallback, so they are identical even though the candidate sets differ.
  const {liveOut, staticOut} = assertEmergencySafety(body.elements, staticSet, "hospital");
  assert.deepEqual(staticOut, liveOut);
  assert.deepEqual(staticOut.slice(0, 2).map((facility) => facility.emergencyCareConfirmed), [true, true]);
});

test("2: CORE < 20 with EXTENDED consulted at the final radius: candidate sets and client results are identical", async () => {
  const universe = [
    north(1, {amenity: "hospital", emergency: "yes", name: "응급병원"}),
    north(2, {amenity: "clinic", name: "의원 A"}),
    east(1.5, {healthcare: "hospital", name: "병원 B"}),
    east(-2, {healthcare: "centre", name: "보건소"}),
    north(-3, {healthcare: "yes", name: "건강센터"}),
    north(7, {amenity: "doctors", name: "의원 C"}),
    east(8, {healthcare: "center", name: "센터 D"}),
    FILLER_PHARMACY()
  ];
  const {body, live, radius, staticSet, consultedEverySelector} = await compare(universe, "hospital");
  assert.deepEqual(live.queries, [
    {scope: "core", radius: 5000}, {scope: "extended", radius: 5000},
    {scope: "core", radius: 10000}, {scope: "extended", radius: 10000}
  ]);
  assert.equal(radius, 10000);
  assert.equal(body.complete, false, "live stops at the 4-attempt budget (existing behavior)");
  assert.equal(consultedEverySelector, true);
  assert.deepEqual(labels(staticSet), labels(body.elements));
  for(const recommendation of [null, EMERGENCY]){
    assert.deepEqual(
      client.run(staticSet, "hospital", BASE, recommendation),
      client.run(body.elements, "hospital", BASE, recommendation),
      `emergency=${!!recommendation}`
    );
  }
});

test("3: CORE reaches 20 at 10 km: live skips EXTENDED at 10 km, static includes it (intentional divergence)", async () => {
  const universe = [];
  for(let index = 0; index < 10; index += 1) universe.push(north(0.3 * (index + 1), {amenity: "hospital", name: `근거리 ${index}`}));
  for(let index = 0; index < 3; index += 1) universe.push(east(0.5 * (index + 1), {healthcare: "centre", name: `보건 ${index}`}));
  for(let index = 0; index < 8; index += 1) universe.push(north(-(5.5 + 0.5 * index), {amenity: "clinic", name: `원거리 ${index}`}));
  const extendedAt8km = east(8, {healthcare: "centre", name: "원거리 보건소"});
  universe.push(extendedAt8km, FILLER_PHARMACY());
  const {body, live, radius, staticSet, consultedEverySelector} = await compare(universe, "hospital");
  assert.deepEqual(live.queries, [{scope: "core", radius: 5000}, {scope: "extended", radius: 5000}, {scope: "core", radius: 10000}]);
  assert.equal(radius, 10000);
  assert.equal(body.complete, true);
  assert.equal(body.elements.length, 21);
  assert.equal(consultedEverySelector, false);
  const liveLabels = new Set(labels(body.elements));
  assert.deepEqual(labels(staticSet).filter((label) => !liveLabels.has(label)), [`node/${extendedAt8km.id}`]);
  assertEmergencySafety(body.elements, staticSet, "hospital");
});

test("4: beyond the live 10 km hospital cap the static path keeps coverage (not forced to repeat the live limit)", async () => {
  const far = north(15, {amenity: "hospital", emergency: "yes", name: "원거리 응급병원"});
  const universe = [far, FILLER_PHARMACY()];
  const {body, radius, staticSet} = await compare(universe, "hospital");
  assert.equal(radius, 10000, "live hospital search never reaches 20 km");
  assert.deepEqual(body.elements, []);
  assert.deepEqual(staticSet, []);
  const wider = staticCandidates(build(universe), "hospital", BASE.latitude, BASE.longitude, 20000);
  assert.deepEqual(labels(wider), [`node/${far.id}`]);
  const out = client.run(wider, "hospital", BASE, EMERGENCY);
  assert.equal(out[0].emergencyCareConfirmed, true);
});

test("5: pharmacy has no extended selector: static equals live at the live radius, including early stop at 20+", async () => {
  const universe = [FILLER_HOSPITAL()];
  for(let index = 0; index < 22; index += 1) universe.push(east(0.2 * (index + 1), index % 2 ? {amenity: "pharmacy", name: `약국 ${index}`} : {healthcare: "pharmacy", name: `약국 ${index}`}));
  universe.push(east(7, {amenity: "pharmacy", name: "원거리 약국"}));
  const {body, live, radius, staticSet, consultedEverySelector} = await compare(universe, "pharmacy");
  assert.deepEqual(live.queries, [{scope: "pharmacy", radius: 5000}]);
  assert.equal(radius, 5000);
  assert.equal(body.elements.length, 22);
  assert.equal(consultedEverySelector, true);
  assert.deepEqual(labels(staticSet), labels(body.elements));
  assert.deepEqual(client.run(staticSet, "pharmacy", BASE, null), client.run(body.elements, "pharmacy", BASE, null));
});
