// Unit tests: tile grid, search-tile lookup and coordinate-based dataset
// selection for the static facility dataset (S1). City-level reference points
// are public, rounded landmarks used as synthetic test inputs only.

import assert from "node:assert/strict";
import test from "node:test";
import {
  tileIdFor,
  tileBounds,
  tileIdsForSearch,
  searchBox,
  haversineMeters,
  pointInRing,
  selectDatasetForSearch
} from "../../scripts/facility-dataset/lib/geo.mjs";
import {KR_REGION} from "../../scripts/facility-dataset/regions/kr.mjs";
import {forbidNetwork} from "../contract/_source.mjs";
import {buildFixture, tileDocument, seededRandom} from "./facility-dataset-helpers.mjs";

const restoreNetwork = forbidNetwork();
test.after(() => restoreNetwork());

const GRID = KR_REGION.grid;
const REGISTRY = [buildFixture().manifest];

// Destination point on the haversine sphere used by the client distance code.
function destination(latitude, longitude, bearingRadians, distanceMeters){
  const radius = 6371000;
  const rad = Math.PI / 180;
  const angular = distanceMeters / radius;
  const lat1 = latitude * rad;
  const lon1 = longitude * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearingRadians));
  const lon2 = lon1 + Math.atan2(Math.sin(bearingRadians) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return {latitude: lat2 / rad, longitude: lon2 / rad};
}

test("1: tiles are half-open 0.25 degree cells with exact integer edges", () => {
  assert.equal(tileIdFor(37.5, 127.0, GRID), "510_1228");
  assert.equal(tileIdFor(37.4999999, 126.9999999, GRID), "509_1227");
  assert.equal(tileIdFor(37.7499999, 127.2499999, GRID), "510_1228");
  assert.equal(tileIdFor(37.75, 127.25, GRID), "511_1229");
  assert.deepEqual(tileBounds("510_1228", GRID), {south: 37.5, west: 127, north: 37.75, east: 127.25});
  assert.equal(tileIdFor(-90, -180, GRID), "0_0");
  assert.equal(tileIdFor(90, 180, GRID), "719_1439", "+90/+180 close the last row and column");
  assert.throws(() => tileIdFor(91, 0, GRID), RangeError);
  assert.throws(() => tileIdFor(0, Number.NaN, GRID), RangeError);
  assert.throws(() => tileIdFor(0, 0, {tileSizeE7: 7000000}), RangeError, "tile size must divide the globe");
});

test("2: every generated element lies inside its own tile bounds, including the exact-corner fixture point", () => {
  const result = buildFixture();
  for(const type of ["hospital", "pharmacy"]){
    for(const entry of result.manifest.tiles[type]){
      const tile = tileDocument(result, entry.path);
      assert.deepEqual(tile.bounds, tileBounds(entry.tileId, GRID));
      assert.deepEqual(entry.bounds, tile.bounds);
      for(const element of tile.elements){
        const point = element.type === "node" ? element : element.center;
        assert.ok(point.lat >= tile.bounds.south && point.lat < tile.bounds.north, `${element.type}/${element.id} lat`);
        assert.ok(point.lon >= tile.bounds.west && point.lon < tile.bounds.east, `${element.type}/${element.id} lon`);
      }
    }
  }
  const corner = tileDocument(result, "hospital/510_1228.json").elements;
  assert.deepEqual(corner.map((element) => element.id), [14]);
});

test("3: search tile lookup covers every point within the radius (seeded property test)", () => {
  const random = seededRandom(7);
  const radii = [5000, 10000, 20000, 50000];
  for(let iteration = 0; iteration < 3000; iteration += 1){
    const latitude = 33 + random() * 5.5;
    const longitude = 124.5 + random() * 6;
    const radius = radii[iteration % radii.length];
    const target = destination(latitude, longitude, random() * 2 * Math.PI, random() * radius * 0.9999);
    assert.ok(haversineMeters(latitude, longitude, target.latitude, target.longitude) <= radius);
    const ids = tileIdsForSearch(latitude, longitude, radius, GRID);
    assert.ok(ids.includes(tileIdFor(target.latitude, target.longitude, GRID)), `iteration ${iteration}`);
  }
  // Sorted and bounded: a 10 km search in Korea touches at most a 2x2 block.
  const ids = tileIdsForSearch(37.5503, 126.9801, 10000, GRID);
  assert.deepEqual(ids, ["509_1227", "509_1228", "510_1227", "510_1228"]);
});

test("4: unsupported search boxes return null instead of a partial tile list", () => {
  assert.equal(searchBox(89.9, 0, 50000), null, "crosses a pole");
  assert.equal(searchBox(0, 179.9, 50000), null, "crosses the antimeridian");
  assert.equal(tileIdsForSearch(0, -179.9, 50000, GRID), null);
  assert.equal(searchBox(37.5, 127, 0), null);
  assert.equal(searchBox(37.5, 127, Number.NaN), null);
  assert.equal(searchBox(Number.NaN, 127, 1000), null);
});

test("5: KR is selected from the search coordinates: served points", () => {
  const served = {
    "Seoul city hall area": [37.5665, 126.978],
    "Incheon airport area": [37.4602, 126.4407],
    "Busan station area": [35.1152, 129.0422],
    "Gangneung area": [37.7519, 128.8761],
    "Jeju city area": [33.4996, 126.5312],
    "Gwangju area": [35.1595, 126.8526],
    "fixture search point": [37.5503, 126.9801]
  };
  for(const [label, [latitude, longitude]] of Object.entries(served)){
    for(const radius of [5000, 10000, 20000, 50000]){
      const selected = selectDatasetForSearch(latitude, longitude, radius, REGISTRY);
      assert.ok(selected, `${label} @ ${radius}`);
      assert.equal(selected.regionCode, "KR");
    }
  }
});

test("6: points outside the KR service area fall back (null), including near-border ones", () => {
  const outside = {
    "Tsushima (Japan)": [34.4, 129.3],
    "Kaesong (North Korea)": [37.97, 126.55],
    "Pyongyang (North Korea)": [39.03, 125.75],
    "Fukuoka (Japan)": [33.59, 130.4],
    "Tokyo (Japan)": [35.68, 139.76],
    "Dandong (China)": [40.12, 124.38],
    "Yellow Sea": [36.0, 124.5],
    "fixture strait-island hospital point": [34.4, 129.3]
  };
  for(const [label, [latitude, longitude]] of Object.entries(outside)){
    assert.equal(selectDatasetForSearch(latitude, longitude, 10000, REGISTRY), null, label);
  }
  assert.equal(selectDatasetForSearch(37.5665, 126.978, 50001, REGISTRY), null, "radius above the served maximum");
  assert.equal(selectDatasetForSearch(Number.NaN, 126.978, 5000, REGISTRY), null);
  assert.equal(selectDatasetForSearch(37.5665, 126.978, 5000, null), null);
  assert.equal(selectDatasetForSearch(37.5665, 126.978, 5000, [REGISTRY[0], REGISTRY[0]]), null, "ambiguous coverage falls back");
  // Vertices and edges of the service area count as outside.
  const vertex = KR_REGION.serviceArea.ringsLatLon[0][0];
  assert.equal(pointInRing(vertex[0], vertex[1], KR_REGION.serviceArea.ringsLatLon[0]), false);
  const jeju = KR_REGION.serviceArea.ringsLatLon[1];
  for(const [latitude, longitude] of [[33.6, 126.55], [33.15, 126.55], [33.375, 126.1], [33.375, 127.0]]){
    assert.equal(pointInRing(latitude, longitude, jeju), false, `edge ${latitude},${longitude}`);
  }
  assert.equal(pointInRing(33.375, 126.55, jeju), true);
});

test("7: the traveler's selected country never decides the dataset", () => {
  // selectDatasetForSearch has no country input at all.
  assert.equal(selectDatasetForSearch.length, 4);
  assert.doesNotMatch(selectDatasetForSearch.toString(), /country/i);
  const scenarios = [
    {travelerCountry: "JP", at: [37.5665, 126.978], expected: "KR"},
    {travelerCountry: "US", at: [35.1152, 129.0422], expected: "KR"},
    {travelerCountry: "KR", at: [35.68, 139.76], expected: null},
    {travelerCountry: "KR", at: [34.4, 129.3], expected: null}
  ];
  for(const scenario of scenarios){
    const selected = selectDatasetForSearch(scenario.at[0], scenario.at[1], 10000, REGISTRY);
    assert.equal(selected ? selected.regionCode : null, scenario.expected, `${scenario.travelerCountry} traveler at ${scenario.at}`);
  }
});

test("8: every KR service-area vertex keeps the maximum search radius inside the data bounds", () => {
  const {dataBounds, maxSearchRadiusMeters} = KR_REGION;
  for(const ring of KR_REGION.serviceArea.ringsLatLon){
    for(const [latitude, longitude] of ring){
      const box = searchBox(latitude, longitude, maxSearchRadiusMeters);
      assert.ok(box.south >= dataBounds.south && box.north <= dataBounds.north, `${latitude},${longitude} lat`);
      assert.ok(box.west >= dataBounds.west && box.east <= dataBounds.east, `${latitude},${longitude} lon`);
    }
  }
  assert.equal(KR_REGION.serviceAreaStatus, "provisional-unverified-conservative");
});
