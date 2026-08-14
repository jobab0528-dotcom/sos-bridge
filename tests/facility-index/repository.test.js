"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {findNearbyFacilities} = require("../../netlify/functions/_shared/facility-index/repository");

function criteria(overrides = {}) {
  return Object.assign({
    countryCode: "AA",
    type: "hospital",
    latitude: 0,
    longitude: 0,
    radiusMeters: 5000
  }, overrides);
}

function fakeExecutor(facilityRows = []) {
  const calls = [];
  return {
    calls,
    async query(sqlText, params) {
      calls.push({sqlText, params});
      if (calls.length === 1) {
        return {rows: [{datasetVersionId: "TEST_DATASET_AA_V2", dataAsOf: "2030-02-01T00:00:00Z"}]};
      }
      return {rows: facilityRows};
    }
  };
}

function sampleRow(overrides = {}) {
  return Object.assign({
    facilityId: "HOSPITAL_NEAR",
    type: "hospital",
    facilityClass: "hospital",
    name: "Synthetic Hospital",
    nameLocal: null,
    nameEnglish: null,
    distanceMeters: 1000,
    emergency: false,
    specialties: [],
    address: null,
    phone: null
  }, overrides);
}

test("priorityMode defaults to distance and limit defaults to 50", async () => {
  const executor = fakeExecutor();
  await findNearbyFacilities(criteria(), executor);
  assert.equal(executor.calls.length, 2);
  assert.equal(executor.calls[1].params[6], "distance");
  assert.equal(executor.calls[1].params[7], 50);
});

test("invalid type is rejected before executor use", async () => {
  const executor = fakeExecutor();
  await assert.rejects(findNearbyFacilities(criteria({type: "restaurant"}), executor), {code: "FACILITY_INVALID_REQUEST"});
  assert.equal(executor.calls.length, 0);
});

test("invalid country code is rejected", async () => {
  await assert.rejects(findNearbyFacilities(criteria({countryCode: "aa"}), fakeExecutor()), {code: "FACILITY_INVALID_REQUEST"});
});

test("invalid coordinates are rejected", async () => {
  await assert.rejects(findNearbyFacilities(criteria({latitude: 91}), fakeExecutor()), {code: "FACILITY_INVALID_REQUEST"});
  await assert.rejects(findNearbyFacilities(criteria({longitude: -181}), fakeExecutor()), {code: "FACILITY_INVALID_REQUEST"});
});

test("invalid radius is rejected", async () => {
  await assert.rejects(findNearbyFacilities(criteria({radiusMeters: 7500}), fakeExecutor()), {code: "FACILITY_INVALID_REQUEST"});
});

test("limit above 50 is rejected", async () => {
  await assert.rejects(findNearbyFacilities(criteria({limit: 51}), fakeExecutor()), {code: "FACILITY_INVALID_REQUEST"});
});

test("pharmacy emergency-first is rejected", async () => {
  await assert.rejects(findNearbyFacilities(criteria({type: "pharmacy", priorityMode: "emergency-first"}), fakeExecutor()), {code: "FACILITY_INVALID_REQUEST"});
});

test("executor must expose query(sqlText, params)", async () => {
  await assert.rejects(findNearbyFacilities(criteria(), {}), {code: "FACILITY_DB_UNAVAILABLE"});
});

test("SQL uses bind placeholders and keeps values in params", async () => {
  const executor = fakeExecutor();
  await findNearbyFacilities(criteria(), executor);
  assert.match(executor.calls[0].sqlText, /\$1/);
  assert.match(executor.calls[1].sqlText, /\$8/);
  assert.equal(executor.calls[0].sqlText.includes("AA"), false);
  assert.deepEqual(executor.calls[0].params, ["AA"]);
  assert.deepEqual(executor.calls[1].params, [
    "TEST_DATASET_AA_V2", "AA", "hospital", 0, 0, 5000, "distance", 50
  ]);
});

test("raw symptom and unknown fields are outside the repository contract", async () => {
  const executor = fakeExecutor();
  await assert.rejects(findNearbyFacilities(criteria({rawSymptom: "private text"}), executor), {code: "FACILITY_INVALID_REQUEST"});
  assert.equal(executor.calls.length, 0);
});

test("result rows map to the stable B1 domain contract", async () => {
  const executor = fakeExecutor([sampleRow({distanceMeters: "1000.25", specialties: ["cardiology"]})]);
  const result = await findNearbyFacilities(criteria(), executor);
  assert.equal(result.datasetVersionId, "TEST_DATASET_AA_V2");
  assert.equal(result.facilities.length, 1);
  assert.deepEqual(result.facilities[0], {
    facilityId: "HOSPITAL_NEAR",
    type: "hospital",
    facilityClass: "hospital",
    name: "Synthetic Hospital",
    nameLocal: null,
    nameEnglish: null,
    distanceMeters: 1000.25,
    emergency: false,
    specialties: ["cardiology"],
    address: null,
    phone: null
  });
});

test("missing enabled active dataset is a country-not-ready error", async () => {
  const executor = {async query() { return {rows: []}; }};
  await assert.rejects(findNearbyFacilities(criteria(), executor), {code: "FACILITY_COUNTRY_NOT_READY"});
});

test("repeated calls produce the same normalized result", async () => {
  const first = await findNearbyFacilities(criteria(), fakeExecutor([sampleRow()]));
  const second = await findNearbyFacilities(criteria(), fakeExecutor([sampleRow()]));
  assert.deepEqual(first, second);
});
