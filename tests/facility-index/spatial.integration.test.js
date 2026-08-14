"use strict";

const assert = require("node:assert/strict");
const {after, before, test} = require("node:test");
const {findNearbyFacilities} = require("../../netlify/functions/_shared/facility-index/repository");
const {
  BULK_FIXTURE_SQL,
  DELETE_BULK_FIXTURE_SQL,
  FIXTURE_IDS,
  FIXTURE_SQL,
  REFERENCE
} = require("./fixtures");
const {
  assertEnvironment,
  createExecutor,
  queryRows,
  runPsql
} = require("./test-db");

const executor = createExecutor();

function search(overrides = {}) {
  return findNearbyFacilities(Object.assign({
    countryCode: REFERENCE.countryCode,
    type: "hospital",
    latitude: REFERENCE.latitude,
    longitude: REFERENCE.longitude,
    radiusMeters: 5000
  }, overrides), executor);
}

before(() => {
  assertEnvironment();
  runPsql(FIXTURE_SQL);
});

after(() => {
  runPsql(DELETE_BULK_FIXTURE_SQL);
});

test("nearest hospital is first in distance mode", async () => {
  const result = await search();
  assert.equal(result.facilities[0].facilityId, FIXTURE_IDS.hospitalNear);
});

test("pharmacy search returns only pharmacies", async () => {
  const result = await search({type: "pharmacy"});
  assert.deepEqual(result.facilities.map((item) => item.facilityId), [
    FIXTURE_IDS.pharmacyNear,
    FIXTURE_IDS.pharmacyFar
  ]);
  assert.equal(result.facilities.every((item) => item.type === "pharmacy"), true);
});

test("hospital search excludes pharmacies", async () => {
  const result = await search();
  assert.equal(result.facilities.every((item) => item.type === "hospital"), true);
});

test("exact 5000 meter boundary is included", async () => {
  const result = await search();
  assert.equal(result.facilities.some((item) => item.facilityId === FIXTURE_IDS.exactBoundary), true);
});

test("exact boundary fixture measures 5000 meters within tolerance", () => {
  const rows = queryRows(`
    SELECT ST_Distance(
      location,
      ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography
    ) AS distance
    FROM facility_index.facilities
    WHERE facility_id = 'EXACT_RADIUS_BOUNDARY'
  `);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(Number(rows[0].distance) - 5000) <= 0.01, rows[0].distance);
});

test("facility outside 5000 meters is excluded", async () => {
  const result = await search();
  assert.equal(result.facilities.some((item) => item.facilityId === FIXTURE_IDS.outsideRadius), false);
});

test("country isolation uses only the requested country", async () => {
  const aa = await search();
  const bb = await search({countryCode: "BB"});
  assert.equal(aa.facilities.some((item) => item.facilityId === FIXTURE_IDS.otherCountryHospital), false);
  assert.deepEqual(bb.facilities.map((item) => item.facilityId), [FIXTURE_IDS.otherCountryHospital]);
});

test("only the active dataset is queried", async () => {
  const result = await search();
  assert.equal(result.datasetVersionId, "TEST_DATASET_AA_V2");
});

test("previous dataset facilities are excluded", async () => {
  const result = await search();
  assert.equal(result.facilities.some((item) => item.facilityId === FIXTURE_IDS.otherDatasetHospital), false);
});

test("rejected facilities are excluded", async () => {
  const result = await search();
  assert.equal(result.facilities.some((item) => item.facilityId === FIXTURE_IDS.rejectedCarRepair), false);
});

test("review facilities are excluded", async () => {
  const result = await search();
  assert.equal(result.facilities.some((item) => item.facilityId === FIXTURE_IDS.reviewRecord), false);
});

test("inactive facilities are excluded", async () => {
  const result = await search();
  assert.equal(result.facilities.some((item) => item.facilityId === FIXTURE_IDS.inactiveRecord), false);
});

test("all returned distances are finite and non-negative", async () => {
  const result = await search();
  assert.equal(result.facilities.every((item) => Number.isFinite(item.distanceMeters) && item.distanceMeters >= 0), true);
});

test("equal distances use facility ID as deterministic tie-break", async () => {
  const result = await search();
  const ids = result.facilities.map((item) => item.facilityId);
  assert.ok(ids.indexOf(FIXTURE_IDS.tieDistanceA) < ids.indexOf(FIXTURE_IDS.tieDistanceB));
});

test("result cap remains 50 with more than 50 eligible fixtures", async () => {
  runPsql(DELETE_BULK_FIXTURE_SQL);
  runPsql(BULK_FIXTURE_SQL);
  try {
    const eligible = queryRows(`
      SELECT count(*)::integer AS count
      FROM facility_index.facilities
      WHERE dataset_version_id = 'TEST_DATASET_AA_V2'
        AND country_code = 'AA'
        AND facility_type = 'hospital'
        AND classification_status = 'accepted'
        AND is_active = TRUE
        AND ST_DWithin(
          location,
          ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
          5000
        )
    `);
    assert.ok(Number(eligible[0].count) > 50);
    const result = await search({limit: 50});
    assert.equal(result.facilities.length, 50);
  } finally {
    runPsql(DELETE_BULK_FIXTURE_SQL);
  }
});

test("emergency-first applies tier then distance ordering", async () => {
  const result = await search({priorityMode: "emergency-first"});
  assert.deepEqual(result.facilities.map((item) => item.facilityId), [
    FIXTURE_IDS.emergencyHospital,
    FIXTURE_IDS.hospitalNear,
    FIXTURE_IDS.tieDistanceA,
    FIXTURE_IDS.tieDistanceB,
    FIXTURE_IDS.hospitalFar,
    FIXTURE_IDS.exactBoundary,
    FIXTURE_IDS.clinic
  ]);
});

test("default distance ordering ignores emergency tier", async () => {
  const result = await search();
  assert.deepEqual(result.facilities.map((item) => item.facilityId), [
    FIXTURE_IDS.hospitalNear,
    FIXTURE_IDS.tieDistanceA,
    FIXTURE_IDS.tieDistanceB,
    FIXTURE_IDS.clinic,
    FIXTURE_IDS.emergencyHospital,
    FIXTURE_IDS.hospitalFar,
    FIXTURE_IDS.exactBoundary
  ]);
});

test("repeated identical spatial query is deterministic", async () => {
  const results = [];
  for (let count = 0; count < 3; count += 1) {
    results.push((await search()).facilities.map((item) => item.facilityId));
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test("a valid query with no nearby rows returns an empty result", async () => {
  const result = await search({latitude: 40, longitude: 40});
  assert.deepEqual(result.facilities, []);
});
